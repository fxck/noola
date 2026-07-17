package main

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

// Agent-studio execution runner (Go). Runs on the Zerops `runner` docker service (a
// Docker-in-VM). Consumes run jobs from the shared NATS JetStream and launches ONE
// ephemeral `docker run --rm --network=host` container per job — every run a fresh,
// bounded, self-cleaning sandbox. A static Go binary (CGO_ENABLED=0), so it runs on the
// Alpine VM with zero runtime deps (the docker CLI is already there).
//
// Slice B: records the run lifecycle to runner_runs via pgx (queued→running→succeeded/
// failed, capturing the container's combined output into `result`). Recording is
// best-effort — the runner keeps executing even if Postgres is unreachable. The worker
// connects as a BYPASSRLS role (super) so it can write any tenant's row. Slice C swaps the
// echo container for real command execution + per-run credential injection.

type CredRef struct {
	IntegrationID string `json:"integrationId"`
	EnvName       string `json:"envName"`
}

type Job struct {
	RunID    string    `json:"runId"`
	TenantID string    `json:"tenantId"`
	Cmd      string    `json:"cmd"`
	Creds    []CredRef `json:"creds"`
	// Mode "flow" runs a whole automation graph in the flow-runner container; empty/other = the
	// classic `sh -c cmd` run.
	Mode string `json:"mode"`
	// Mode "flow" (Studio→Studio fold): run a WHOLE automation graph containing browser/AI-browser
	// nodes inside the flow-runner container (one persistent Chromium + Stagehand/Claude across the
	// graph). Graph is the serialized {nodes,edges}; Input is the serialized seed item ({json,text}).
	Graph string `json:"graph"`
	Input string `json:"input"`
}

var (
	globalMax = envInt("RUNNER_GLOBAL_MAX", 3)
	// Per-tenant concurrency cap (multitenancy fairness). globalMax bounds TOTAL concurrent runs,
	// but without this one tenant could occupy every slot and starve the rest on the shared runner
	// VM. Keep tenantMax < globalMax so a busy tenant always leaves headroom for siblings. <=0
	// disables the per-tenant cap (single-tenant / self-hosted).
	tenantMax = envInt("RUNNER_TENANT_MAX", 2)
	runImage  = envStr("RUNNER_IMAGE", "alpine:3.20")
	// Node execution image for `flow`-mode jobs — runs the whole browser/AI graph (Playwright +
	// Stagehand + Claude) to completion, writing runner_runs.result_json/node_events + publishing
	// progress to NATS run.<id>. Built into the runner image at deploy (prepareCommands), so it's a
	// local tag — a failed `docker pull` at boot is expected and harmless.
	flowRunnerImage = envStr("RUNNER_FLOW_IMAGE", "noola-flow-runner:v1")
	cpus            = envStr("RUNNER_CPUS", "1")
	memory          = envStr("RUNNER_MEMORY", "512m")
	// Browser containers need more headroom (Chromium) than a plain command run.
	browserMemory = envStr("RUNNER_BROWSER_MEMORY", "1024m")
	db            *pgxpool.Pool // nil when DB env is absent/unreachable — recording degrades gracefully
)

func envStr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func logf(format string, a ...any) { log.Printf("[runner] "+format, a...) }

func dockerOk() bool { return exec.Command("docker", "ps").Run() == nil }

func dockerPull(image string) {
	cmd := exec.Command("docker", "pull", image)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	_ = cmd.Run()
}

func firstN(s string, n int) string {
	if len(s) < n {
		return s
	}
	return s[:n]
}

func asExitError(err error, target **exec.ExitError) bool {
	if e, ok := err.(*exec.ExitError); ok {
		*target = e
		return true
	}
	return false
}

// One ephemeral container per job. --network=host so it resolves Zerops internal
// hostnames; --rm + per-container cpu/mem caps give isolated, bounded, self-cleaning runs.
// Returns (exit code, combined stdout+stderr, error). Slice B captures the output (for
// runner_runs.result) instead of streaming it; slice C replaces the echo with the real cmd.
func dockerRun(job Job, name string, envArgs []string) (int, string, error) {
	script := strings.TrimSpace(job.Cmd)
	if script == "" {
		script = fmt.Sprintf(`echo "[run %s] (empty command)"`, job.RunID)
	}
	// The command runs FOR REAL inside the ephemeral container (sh -c). exec.Command passes
	// `script` as a single arg — no host-side shell — so there's no injection on the host;
	// the container (--rm, cpu/mem-capped, host-mode network per the trust decision) is the
	// sandbox. envArgs carries `-e NAME=<secret>` pairs of resolved vault credentials.
	args := []string{
		"run", "--rm", "--network=host",
		"--cpus=" + cpus, "--memory=" + memory, "--name", name,
	}
	args = append(args, envArgs...)
	args = append(args, runImage, "sh", "-c", script)
	var buf bytes.Buffer
	cmd := exec.Command("docker", args...)
	cmd.Stdout, cmd.Stderr = &buf, &buf
	err := cmd.Run()
	out := strings.TrimSpace(buf.String())
	if err != nil {
		var exitErr *exec.ExitError
		if asExitError(err, &exitErr) {
			return exitErr.ExitCode(), out, nil
		}
		return 1, out, err
	}
	return 0, out, nil
}

// resolveModelKey looks up a tenant's BYO model-provider key from model_config (Settings → AI)
// and decrypts it at the execution host, so the tenant's Anthropic key can be -e-injected into a
// flow container without ever riding the NATS job payload. The key lives in model_config.key_cipher
// (NOT the integrations table — that holds connector secrets, and its column is `kind`, not `type`),
// written by the api with the same crypto seam this worker decrypts (crypto.ts encryptSecret →
// v1:iv:tag:ct). Returns "" (no error) when the tenant has no key for that provider, so a
// deterministic browser flow still runs keyless — but a genuine DB/decrypt failure IS surfaced (the
// caller logs it) instead of being silently swallowed (which is exactly what hid the old bug).
func resolveModelKey(ctx context.Context, tenantID, provider string) (string, error) {
	if db == nil {
		return "", errors.New("no DB — cannot resolve model key")
	}
	var keyCipher *string
	err := db.QueryRow(ctx,
		"SELECT key_cipher FROM model_config WHERE tenant_id=$1 AND provider=$2 AND key_cipher IS NOT NULL AND key_cipher <> ''",
		tenantID, provider,
	).Scan(&keyCipher)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil // tenant has no BYO key for this provider → run keyless
	}
	if err != nil {
		return "", err // real DB error — surface it, don't hide it
	}
	if keyCipher == nil {
		return "", nil
	}
	return decryptSecret(*keyCipher)
}

// One ephemeral Node execution container per `flow`-mode job. Runs the WHOLE automation graph
// (browser + AI-browser + item nodes) to completion via exec.mts, which drives a local headless
// Chromium (Playwright/Stagehand + Claude), writes runner_runs.result_json/node_events itself, and
// publishes per-node progress to NATS run.<id>. The Anthropic key is resolved at THIS host and
// -e-injected — never carried on NATS. GRAPH/INPUT are the serialized graph + seed item. DB/NATS
// env are passed through so the container can persist its own structured output + stream progress.
func flowRun(job Job, name, anthropicKey string) (int, string, error) {
	if strings.TrimSpace(job.Graph) == "" {
		return 1, "", errors.New("flow job has no graph")
	}
	args := []string{
		"run", "--rm", "--network=host",
		"--cpus=" + cpus, "--memory=" + browserMemory, "--name", name,
		"-e", "RUN_ID=" + job.RunID,
		"-e", "TENANT_ID=" + job.TenantID,
		"-e", "GRAPH=" + job.Graph,
		"-e", "INPUT=" + job.Input,
	}
	if anthropicKey != "" {
		args = append(args, "-e", "ANTHROPIC_API_KEY="+anthropicKey)
	}
	// Pass infra creds through so exec.mts can write runner_runs + publish run.<id> progress.
	// STORAGE_* lets it upload the encoded .webm replay to object storage (0092).
	for _, k := range []string{
		"NATS_HOST", "NATS_PORT", "NATS_USER", "NATS_PASS",
		"DB_HOST", "DB_PORT", "DB_USER", "DB_PASS", "DB_NAME",
		"MODEL_KEY_SECRET",
		"STORAGE_ENDPOINT", "STORAGE_ACCESS_KEY", "STORAGE_SECRET_KEY", "STORAGE_BUCKET", "STORAGE_REGION",
	} {
		if v := os.Getenv(k); v != "" {
			args = append(args, "-e", k+"="+v)
		}
	}
	args = append(args, flowRunnerImage)
	var buf bytes.Buffer
	cmd := exec.Command("docker", args...)
	cmd.Stdout, cmd.Stderr = &buf, &buf
	err := cmd.Run()
	out := strings.TrimSpace(buf.String())
	if err != nil {
		var exitErr *exec.ExitError
		if asExitError(err, &exitErr) {
			return exitErr.ExitCode(), out, nil
		}
		return 1, out, err
	}
	return 0, out, nil
}

// ── run-lifecycle recording (best-effort) ────────────────────────────────────

func markRunning(ctx context.Context, job Job) {
	if db == nil {
		return
	}
	if _, err := db.Exec(ctx,
		"UPDATE runner_runs SET status='running', started_at=now() WHERE tenant_id=$1 AND id=$2",
		job.TenantID, job.RunID,
	); err != nil {
		logf("run %s markRunning: %v", job.RunID, err)
	}
}

func markResult(ctx context.Context, job Job, status, result, errStr string) {
	if db == nil {
		return
	}
	var resultArg, errArg any
	if result != "" {
		resultArg = result
	}
	if errStr != "" {
		errArg = errStr
	}
	if _, err := db.Exec(ctx,
		"UPDATE runner_runs SET status=$3, result=$4, error=$5, finished_at=now() WHERE tenant_id=$1 AND id=$2",
		job.TenantID, job.RunID, status, resultArg, errArg,
	); err != nil {
		logf("run %s markResult: %v", job.RunID, err)
	}
}

// ── credential injection: resolve + decrypt vault integrations in-worker ──────
// Mirrors the api's crypto.ts (blob = "v1:<ivB64>:<tagB64>:<ctB64>", key = SHA-256(
// MODEL_KEY_SECRET), AES-256-GCM) so a run can use a tenant's stored connector secret
// without the secret ever riding the job payload / NATS — it's resolved HERE, at the
// execution host, and -e-injected into the container.

func decryptSecret(blob string) (string, error) {
	master := os.Getenv("MODEL_KEY_SECRET")
	if master == "" {
		return "", errors.New("MODEL_KEY_SECRET not set")
	}
	parts := strings.SplitN(blob, ":", 4)
	if len(parts) != 4 || parts[0] != "v1" {
		return "", errors.New("bad cipher blob format")
	}
	iv, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil {
		return "", err
	}
	tag, err := base64.StdEncoding.DecodeString(parts[2])
	if err != nil {
		return "", err
	}
	ct, err := base64.StdEncoding.DecodeString(parts[3])
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(master))
	block, err := aes.NewCipher(sum[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	// Node stores the GCM tag separately; Go's Open wants ciphertext‖tag.
	pt, err := gcm.Open(nil, iv, append(ct, tag...), nil)
	if err != nil {
		return "", err
	}
	return string(pt), nil
}

func resolveCred(ctx context.Context, tenantID, integrationID string) (string, error) {
	if db == nil {
		return "", errors.New("no DB — cannot resolve credential")
	}
	var secretEnc *string
	if err := db.QueryRow(ctx,
		"SELECT secret_enc FROM integrations WHERE tenant_id=$1 AND id=$2",
		tenantID, integrationID,
	).Scan(&secretEnc); err != nil {
		return "", fmt.Errorf("integration %s not found: %w", integrationID, err)
	}
	if secretEnc == nil {
		return "", fmt.Errorf("integration %s has no secret", integrationID)
	}
	return decryptSecret(*secretEnc)
}

// Resolve every bound credential into `-e NAME=<secret>` docker args.
func resolveCredEnv(ctx context.Context, job Job) ([]string, error) {
	var envArgs []string
	for _, cr := range job.Creds {
		if cr.EnvName == "" || cr.IntegrationID == "" {
			continue
		}
		secret, err := resolveCred(ctx, job.TenantID, cr.IntegrationID)
		if err != nil {
			return nil, fmt.Errorf("credential %s: %w", cr.EnvName, err)
		}
		envArgs = append(envArgs, "-e", cr.EnvName+"="+secret)
	}
	return envArgs, nil
}

// ── per-tenant concurrency accounting (noisy-neighbor fairness) ──────────────
// Tracks how many runs each tenant currently occupies. A job that would exceed its tenant's cap
// is Nak-requeued (not run, not dropped) so it waits for one of that tenant's siblings to finish
// while other tenants' jobs keep flowing through the remaining global slots.

var (
	inflightMu sync.Mutex
	inflight   = map[string]int{}
	// globalSem caps TOTAL concurrent runs at globalMax. It's a real semaphore (not MaxAckPending)
	// so the consumer can be given delivery HEADROOM above globalMax — that headroom is what lets a
	// second tenant's job stay visible past a flooding tenant's deferred (Nak'd) backlog, which is
	// the whole point of the per-tenant cap. Buffered to globalMax in main().
	globalSem chan struct{}
)

// tryAcquire reserves a slot for tenantID iff it's under the per-tenant cap. Returns false when the
// tenant is already at capacity (the caller should Nak to requeue). tenantMax<=0 disables the cap.
func tryAcquire(tenantID string) bool {
	if tenantMax <= 0 {
		return true
	}
	inflightMu.Lock()
	defer inflightMu.Unlock()
	if inflight[tenantID] >= tenantMax {
		return false
	}
	inflight[tenantID]++
	return true
}

// release frees the slot reserved by tryAcquire; must be deferred immediately after a successful
// acquire so every handleJob exit path (success, cred error, docker error) returns the slot.
func release(tenantID string) {
	if tenantMax <= 0 {
		return
	}
	inflightMu.Lock()
	defer inflightMu.Unlock()
	if inflight[tenantID] <= 1 {
		delete(inflight, tenantID)
	} else {
		inflight[tenantID]--
	}
}

func handleJob(msg jetstream.Msg) {
	var job Job
	if err := json.Unmarshal(msg.Data(), &job); err != nil {
		_ = msg.Term() // unparseable — drop, never redeliver
		return
	}
	if job.RunID == "" {
		_ = msg.Term()
		return
	}
	// Admission control, two gates, both non-blocking (defer, never queue-in-goroutine):
	//  1) a GLOBAL execution slot (globalSem) — bounds total concurrent runs on the VM;
	//  2) the tenant's per-tenant slot (tryAcquire) — fairness so no tenant hogs the global slots.
	// Missing either ⇒ Nak-requeue (redeliver after a short delay); the job is preserved, not run,
	// so runner_runs stays 'queued'. The short delay avoids a hot requeue loop.
	select {
	case globalSem <- struct{}{}:
	default:
		logf("run %s deferred — runner at global cap %d", job.RunID, globalMax)
		_ = msg.NakWithDelay(1 * time.Second)
		return
	}
	defer func() { <-globalSem }()
	if !tryAcquire(job.TenantID) {
		logf("run %s deferred — tenant %s at concurrency cap %d", job.RunID, firstN(job.TenantID, 8), tenantMax)
		_ = msg.NakWithDelay(2 * time.Second) // defer above releases the global slot
		return
	}
	defer release(job.TenantID)
	ctx := context.Background()
	name := fmt.Sprintf("run-%s-%d", firstN(job.RunID, 8), time.Now().UnixNano()%100000)
	markRunning(ctx, job)

	var code int
	var out string
	var err error
	if job.Mode == "flow" {
		// Whole-graph browser/AI flow (Studio→Studio fold). Resolve the tenant's Anthropic key HERE and
		// -e-inject it; the container drives Chromium + Stagehand/Claude and writes its own
		// result_json/node_events. A missing key is not fatal — a deterministic browser flow still runs.
		anthropicKey, keyErr := resolveModelKey(ctx, job.TenantID, "anthropic")
		if keyErr != nil {
			logf("run %s anthropic key resolve failed (continuing without): %v", job.RunID, keyErr)
			anthropicKey = ""
		}
		logf("run %s → flow container %s (key: %v)", job.RunID, flowRunnerImage, anthropicKey != "")
		code, out, err = flowRun(job, name, anthropicKey)
	} else {
		logf("run %s → docker run %s (%d creds)", job.RunID, runImage, len(job.Creds))
		// Resolve + decrypt each bound vault credential and -e-inject it. Secrets are resolved
		// HERE (at the execution host), never carried in the job payload / NATS.
		envArgs, credErr := resolveCredEnv(ctx, job)
		if credErr != nil {
			logf("run %s credential resolve failed: %v", job.RunID, credErr)
			markResult(ctx, job, "failed", "", credErr.Error())
			_ = msg.Term() // config error — don't redeliver
			return
		}
		code, out, err = dockerRun(job, name, envArgs)
	}
	if out != "" {
		logf("run %s output: %s", job.RunID, out)
	}
	if err != nil {
		logf("run %s docker error: %v", job.RunID, err)
		markResult(ctx, job, "failed", out, err.Error())
		_ = msg.NakWithDelay(2 * time.Second)
		return
	}
	logf("run %s container exit %d", job.RunID, code)
	if code == 0 {
		markResult(ctx, job, "succeeded", out, "")
		_ = msg.Ack()
	} else {
		markResult(ctx, job, "failed", out, fmt.Sprintf("container exited %d", code))
		_ = msg.NakWithDelay(2 * time.Second)
	}
}

// Keyword DSN (avoids URL-encoding the generated password). Empty when DB env is absent.
func dbDSN() string {
	host, user, name := os.Getenv("DB_HOST"), os.Getenv("DB_USER"), os.Getenv("DB_NAME")
	if host == "" || user == "" || name == "" {
		return ""
	}
	return fmt.Sprintf("host=%s port=%s user=%s password=%s dbname=%s sslmode=disable",
		host, envStr("DB_PORT", "5432"), user, os.Getenv("DB_PASS"), name)
}

func main() {
	log.SetFlags(0)
	globalSem = make(chan struct{}, globalMax)

	if os.Getenv("NATS_HOST") == "" || os.Getenv("NATS_PORT") == "" {
		log.Fatal("[runner] missing NATS_HOST/NATS_PORT — exiting for a restart with env present")
	}
	if !dockerOk() {
		log.Fatal("[runner] docker daemon not reachable — exiting for restart")
	}
	dockerPull(runImage)
	logf("run image ready: %s", runImage)
	// The flow-runner image is built into the runner container at deploy (prepareCommands) as a local
	// tag, so a registry `pull` will usually miss — that's fine. Report whether the tag is present.
	go func() {
		dockerPull(flowRunnerImage)
		if exec.Command("docker", "image", "inspect", flowRunnerImage).Run() == nil {
			logf("flow image ready: %s", flowRunnerImage)
		} else {
			logf("flow image NOT present (%s) — flow-mode jobs will fail until it's built", flowRunnerImage)
		}
	}()

	// Optional DB — records run lifecycle to runner_runs. Connect as a BYPASSRLS role so
	// the worker writes any tenant's row. Degrade gracefully if env is absent or pg is down.
	if dsn := dbDSN(); dsn != "" {
		if pool, err := pgxpool.New(context.Background(), dsn); err != nil {
			logf("DB pool init failed (recording disabled): %v", err)
		} else if err := pool.Ping(context.Background()); err != nil {
			logf("DB ping failed (recording disabled): %v", err)
		} else {
			db = pool
			logf("DB connected — recording run lifecycle to runner_runs")
		}
	} else {
		logf("no DB env — run lifecycle recording disabled")
	}

	url := fmt.Sprintf("%s:%s", os.Getenv("NATS_HOST"), os.Getenv("NATS_PORT"))
	nc, err := nats.Connect(url,
		nats.UserInfo(os.Getenv("NATS_USER"), os.Getenv("NATS_PASS")),
		nats.Name("agent-studio-runner"),
		nats.MaxReconnects(-1),
	)
	if err != nil {
		log.Fatalf("[runner] NATS connect: %v", err)
	}
	logf("connected to NATS at %s · global cap %d · run image %s", nc.ConnectedUrl(), globalMax, runImage)

	ctx := context.Background()
	js, err := jetstream.New(nc)
	if err != nil {
		log.Fatalf("[runner] jetstream: %v", err)
	}

	if _, err := js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
		Name:     "RUNS",
		Subjects: []string{"jobs.>"},
	}); err != nil {
		log.Fatalf("[runner] stream ensure: %v", err)
	}
	logf("JetStream stream RUNS ready")

	// Delivery HEADROOM: MaxAckPending is the server-side delivery budget, deliberately set ABOVE
	// globalMax so the server keeps feeding us jobs we can inspect and admit/defer per-tenant —
	// otherwise a flooding tenant's deferred (Nak-pending) jobs would saturate the budget and starve
	// other tenants' delivery, defeating the per-tenant cap. Actual concurrency is bounded by
	// globalSem, not this. Configurable via RUNNER_ACK_PENDING.
	ackPending := envInt("RUNNER_ACK_PENDING", globalMax*4)
	if ackPending < globalMax {
		ackPending = globalMax
	}
	cons, err := js.CreateOrUpdateConsumer(ctx, "RUNS", jetstream.ConsumerConfig{
		Durable:       "runner",
		AckPolicy:     jetstream.AckExplicitPolicy,
		FilterSubject: "jobs.run",
		AckWait:       5 * time.Minute,
		MaxDeliver:    100,
		MaxAckPending: ackPending,
	})
	if err != nil {
		log.Fatalf("[runner] consumer ensure: %v", err)
	}
	logf(`consumer "runner" ready (ack-pending %d)`, ackPending)

	// One goroutine per delivered message; admission control inside handleJob (globalSem +
	// per-tenant tryAcquire) decides run-now vs Nak-requeue. Concurrency is bounded by globalSem,
	// delivery breadth by MaxAckPending above.
	if _, err := cons.Consume(func(msg jetstream.Msg) { go handleJob(msg) }); err != nil {
		log.Fatalf("[runner] consume: %v", err)
	}
	if tenantMax > 0 {
		logf("consuming jobs.run — up to %d concurrent runs (≤%d per tenant)", globalMax, tenantMax)
	} else {
		logf("consuming jobs.run — up to %d concurrent runs (no per-tenant cap)", globalMax)
	}

	select {} // block forever
}
