package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

// Agent-studio execution runner (Go). Consumes run jobs from the shared NATS JetStream and runs
// every job in a Zerops Box sandbox of its own — a microVM with its own kernel, created for the job
// and terminated after it — so code a tenant sends never runs in the runner's container, beside its
// database, broker and storage credentials. A static Go binary (CGO_ENABLED=0).
//
// A shell job (`sh -c cmd`) boots from the Box's `default` base; a flow job (a whole automation
// graph with browser/AI nodes) boots from the flow-runner base the runner has the Box build from
// runner/flow-runner (flow.go). The runner writes the job's files into the sandbox — the command or
// the graph, and an env file holding the tenant's credentials — starts the job, tails its output
// while it runs (relaying it live to NATS run.<id>), and records the run lifecycle to runner_runs
// via pgx (queued→running→succeeded/failed). Recording is best-effort — the runner keeps executing
// even if Postgres is unreachable; it connects as a BYPASSRLS role (super) so it can write any
// tenant's row. A sandbox's network is the internet or nothing, never the project's own.

type CredRef struct {
	IntegrationID string `json:"integrationId"`
	EnvName       string `json:"envName"`
}

type Job struct {
	RunID    string    `json:"runId"`
	TenantID string    `json:"tenantId"`
	Cmd      string    `json:"cmd"`
	Creds    []CredRef `json:"creds"`
	// Mode "flow" runs a whole automation graph in a flow-runner sandbox; empty/other = the
	// classic `sh -c cmd` run.
	Mode string `json:"mode"`
	// Mode "flow" (Studio→Studio fold): run a WHOLE automation graph containing browser/AI-browser
	// nodes inside one flow-runner sandbox (one persistent Chromium + Stagehand/Claude across the
	// graph). Graph is the serialized {nodes,edges}; Input is the serialized seed item ({json,text}).
	Graph string `json:"graph"`
	Input string `json:"input"`
}

// maxDeliver is the consumer's delivery budget: a job that could not start its sandbox this many
// times is failed rather than left queued.
const maxDeliver = 100

var (
	globalMax = envInt("RUNNER_GLOBAL_MAX", 3)
	// Per-tenant concurrency cap (multitenancy fairness). globalMax bounds TOTAL concurrent runs,
	// but without this one tenant could occupy every slot and starve the rest on the shared Box.
	// Keep tenantMax < globalMax so a busy tenant always leaves headroom for siblings. <=0
	// disables the per-tenant cap (single-tenant / self-hosted).
	tenantMax = envInt("RUNNER_TENANT_MAX", 2)
	// Sandbox sizes. The Box shares its own CPU and memory between the sandboxes it runs, so
	// globalMax × these must fit it; a create beyond them waits (the job is requeued).
	cpus        = envInt("RUNNER_CPUS", 1)
	memoryBytes = envMiB("RUNNER_MEMORY_MB", 512)
	// Browser sandboxes need more headroom (Chromium) than a plain command run.
	flowMemoryBytes = envMiB("RUNNER_FLOW_MEMORY_MB", 1024)
	// A job's whole run, after which its process is killed and the run fails.
	jobTimeout = time.Duration(envInt("RUNNER_JOB_TIMEOUT_SECONDS", 600)) * time.Second

	db          *pgxpool.Pool // nil when DB env is absent/unreachable — recording degrades gracefully
	box         *Box
	nc          *nats.Conn
	networkMode string
	shellBase   *namedBase
	flow        *flowBase // nil when the flow-runner sources are missing: flow jobs fail
	flowErr     error     // why flow is nil
	// sandboxPrefix names this runner container's sandboxes (noola-<service>-<node>-), so a restarted
	// runner terminates the ones it left behind without touching another runner's.
	sandboxPrefix string
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

// envMiB reads a size in MiB as bytes, rounded up to the Box's 16 MiB memory step.
func envMiB(k string, def int) int64 {
	n := envInt(k, def)
	if n <= 0 {
		n = def
	}
	return int64((n+15)/16*16) << 20
}

func logf(format string, a ...any) { log.Printf("[runner] "+format, a...) }

func firstN(s string, n int) string {
	if len(s) < n {
		return s
	}
	return s[:n]
}

// sandboxNetworkMode is RUNNER_NETWORK_MODE, INTERNET when unset: a job's sandbox reaches the
// internet, or nothing at all. PROJECT and PROJECT_INTERNET would put the code a tenant sends on
// the project's private network, next to the database and the broker, so they are refused.
func sandboxNetworkMode(v string) (string, error) {
	switch v = strings.ToUpper(strings.TrimSpace(v)); v {
	case "":
		return "INTERNET", nil
	case "INTERNET", "AIRGAPPED":
		return v, nil
	}
	return "", fmt.Errorf("RUNNER_NETWORK_MODE %q: a sandbox runs on INTERNET or AIRGAPPED only", v)
}

var zeropsHostRE = regexp.MustCompile(`^node-id-(\d+)\.runtime\.([a-z0-9]+)\.`)

// hostTag names this container in its sandboxes' names: <service>-<node> on Zerops
// (node-id-2.runtime.runnerstage.zerops → runnerstage-2), else the hostname made name-safe.
func hostTag(hostname string) string {
	if m := zeropsHostRE.FindStringSubmatch(hostname); m != nil {
		return m[2] + "-" + m[1]
	}
	var b strings.Builder
	for _, c := range strings.ToLower(hostname) {
		if c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' {
			b.WriteRune(c)
		} else {
			b.WriteByte('-')
		}
	}
	if t := strings.Trim(b.String(), "-"); t != "" {
		return firstN(t, 40)
	}
	return "runner"
}

// sandboxName is unique per attempt: a requeued job's next sandbox never collides with the last.
func sandboxName(job Job) string { return newIdempotencyKey(sandboxPrefix + firstN(job.RunID, 8)) }

// namedBase is a base the Box already has (the shell base, `default`), by name: its digest is read
// once and again only after a create answers that the Box no longer has it.
type namedBase struct {
	name   string
	mu     sync.Mutex
	digest string
}

func (n *namedBase) Digest(ctx context.Context, box *Box) (string, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.digest == "" {
		d, err := box.BaseDigest(ctx, n.name)
		if err != nil {
			return "", err
		}
		n.digest = d
	}
	return n.digest, nil
}

func (n *namedBase) Forget(digest string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.digest == digest {
		n.digest = ""
	}
}

// resolveModelKey looks up a tenant's BYO model-provider key from model_config (Settings → AI)
// and decrypts it at the execution host, so the tenant's Anthropic key reaches a flow's sandbox (in
// its env file) without ever riding the NATS job payload. The key lives in model_config.key_cipher
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
// execution host, and handed to the job's sandbox in its env file (sandbox.go).

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

// Resolve every bound credential into the NAME=<secret> pairs of the job's env file.
func resolveCredEnv(ctx context.Context, job Job) ([][2]string, error) {
	var env [][2]string
	for _, cr := range job.Creds {
		if cr.EnvName == "" || cr.IntegrationID == "" {
			continue
		}
		if !validEnvName(cr.EnvName) {
			return nil, fmt.Errorf("credential %q: not a valid env name", cr.EnvName)
		}
		secret, err := resolveCred(ctx, job.TenantID, cr.IntegrationID)
		if err != nil {
			return nil, fmt.Errorf("credential %s: %w", cr.EnvName, err)
		}
		env = append(env, [2]string{cr.EnvName, secret})
	}
	return env, nil
}

// ── per-tenant concurrency accounting (noisy-neighbor fairness) ──────────────
// Tracks how many runs each tenant currently occupies. A job that would exceed its tenant's cap
// is Nak-requeued (not run, not dropped) so it waits for one of that tenant's siblings to finish
// while other tenants' jobs keep flowing through the remaining global slots.

var (
	inflightMu sync.Mutex
	inflight   = map[string]int{}
	// globalSem caps TOTAL concurrent runs (sandboxes) at globalMax. It's a real semaphore (not MaxAckPending)
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
// acquire so every handleJob exit path (success, cred error, sandbox error) returns the slot.
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

// ── one job, one sandbox ─────────────────────────────────────────────────────

// configError is a job that cannot run as sent (a credential that does not resolve, a flow without
// a graph, no flow base): it fails at once and is never redelivered.
type configError struct{ err error }

func (e *configError) Error() string { return e.err.Error() }
func (e *configError) Unwrap() error { return e.err }

// maxResult bounds runner_runs.result: a run's recorded output keeps its last maxResult bytes.
const maxResult = 256 << 10

// tailBuffer keeps the last max bytes written to it.
type tailBuffer struct {
	max int
	b   []byte
	cut bool
}

func (t *tailBuffer) Write(p []byte) {
	t.b = append(t.b, p...)
	if len(t.b) > t.max {
		t.b = append(t.b[:0], t.b[len(t.b)-t.max:]...)
		t.cut = true
	}
}

func (t *tailBuffer) String() string {
	s := trimLog(t.b)
	if t.cut {
		s = "… (earlier output cut)\n" + s
	}
	return s
}

// publishLive sends one event to a run's live channel (core NATS, best-effort, like the api's own).
var publishLive = func(subject string, data []byte) {
	if nc == nil {
		return
	}
	if err := nc.Publish(subject, data); err != nil {
		logf("publish %s: %v", subject, err)
	}
}

// sandboxPoll is how often a running job's sandbox is asked for its new output and its status.
var sandboxPoll = 500 * time.Millisecond

func maxPublish() int {
	if nc == nil {
		return 0
	}
	return int(nc.MaxPayload())
}

// heartbeat keeps a running job's message from redelivery (AckWait) while its sandbox runs.
func heartbeat(msg jetstream.Msg) func() {
	last := time.Now()
	return func() {
		if time.Since(last) >= 30*time.Second {
			last = time.Now()
			_ = msg.InProgress()
		}
	}
}

func deliveries(msg jetstream.Msg) uint64 {
	md, err := msg.Metadata()
	if err != nil {
		return 0
	}
	return md.NumDelivered
}

// runShell runs a job's command as `sh` in a sandbox booted from the shell base, with the job's
// credentials in its env. Its output streams live as `output` events and is the run's result.
func runShell(ctx context.Context, msg jetstream.Msg, job Job) (output, failure string, err error) {
	env, err := resolveCredEnv(ctx, job)
	if err != nil {
		return "", "", &configError{err}
	}
	envData, err := envFile(env)
	if err != nil {
		return "", "", &configError{err}
	}
	digest, err := shellBase.Digest(ctx, box)
	if err != nil {
		return "", "", &startError{fmt.Errorf("shell base %q: %w", shellBase.name, err)}
	}
	script := strings.TrimSpace(job.Cmd)
	if script == "" {
		script = fmt.Sprintf(`echo "[run %s] (empty command)"`, job.RunID)
	}
	logf("run %s → shell sandbox (%d creds)", job.RunID, len(env))
	subject := "run." + job.RunID
	out := &tailBuffer{max: maxResult}
	var carry []byte
	res, err := runSandboxJob(ctx, box, SandboxJob{
		Name:        sandboxName(job),
		BaseDigest:  digest,
		NetworkMode: networkMode,
		CPUs:        cpus,
		MemoryBytes: memoryBytes,
		Files: []SandboxFile{
			{Path: jobDir + "/env", Mode: 0o600, Data: envData},
			{Path: jobDir + "/cmd.sh", Mode: 0o600, Data: []byte(script + "\n")},
		},
		Script:     jobScript(jobDir+"/out.log", jobDir+"/env", "exec sh "+shQuote(jobDir+"/cmd.sh")),
		StreamPath: jobDir + "/out.log",
		Timeout:    jobTimeout,
		Poll:       sandboxPoll,
		OnStarted:  func() { markRunning(context.Background(), job) },
		OnTick:     heartbeat(msg),
		OnChunk: func(b []byte) {
			out.Write(b)
			var evs [][]byte
			evs, carry = outputEvents(carry, b, 32<<10)
			for _, ev := range evs {
				publishLive(subject, ev)
			}
		},
	})
	if isBaseNotFound(err) {
		shellBase.Forget(digest)
	}
	if len(carry) > 0 { // a last character cut short: send its bytes as they are
		evs, _ := outputEvents(nil, append(carry, '\n'), 32<<10)
		for _, ev := range evs {
			publishLive(subject, ev)
		}
	}
	output = out.String()
	switch {
	case err != nil:
		return output, "", err
	case res.TimedOut:
		return output, fmt.Sprintf("command timed out after %s", jobTimeout), nil
	case res.ExitCode != 0:
		return output, fmt.Sprintf("command exited %d", res.ExitCode), nil
	}
	return output, "", nil
}

// runFlow runs a whole automation graph with exec.mjs in a sandbox booted from the flow base. Its
// events are relayed live; its state (items, per-node trace) and replay land on the run's row.
func runFlow(ctx context.Context, msg jetstream.Msg, job Job) (output, failure string, err error) {
	if strings.TrimSpace(job.Graph) == "" {
		return "", "", &configError{errors.New("flow job has no graph")}
	}
	if flow == nil {
		return "", "", &configError{fmt.Errorf("flow jobs are unavailable: %v", flowErr)}
	}
	digest, err := flow.Digest(ctx, box)
	switch {
	case errors.Is(err, errFlowBaseBuilding):
		return "", "", err
	case errors.Is(err, errFlowBaseFailed):
		return "", "", &configError{err}
	case err != nil:
		return "", "", &startError{fmt.Errorf("flow base: %w", err)}
	}
	// The tenant's Anthropic key, resolved HERE. A missing key is not fatal — a deterministic
	// browser flow still runs.
	anthropicKey, keyErr := resolveModelKey(ctx, job.TenantID, "anthropic")
	if keyErr != nil {
		logf("run %s anthropic key resolve failed (continuing without): %v", job.RunID, keyErr)
		anthropicKey = ""
	}
	env := [][2]string{
		{"RUN_ID", job.RunID},
		{"TENANT_ID", job.TenantID},
		{"GRAPH_FILE", jobDir + "/graph.json"},
		{"INPUT_FILE", jobDir + "/input.json"},
		{"EVENTS_FILE", jobDir + "/events.jsonl"},
		{"NODE_ENV", "production"},
		{"PLAYWRIGHT_BROWSERS_PATH", "/ms-playwright"},
	}
	if anthropicKey != "" {
		env = append(env, [2]string{"ANTHROPIC_API_KEY", anthropicKey})
	}
	replayKey := flowReplayKey(job.TenantID, job.RunID)
	if putURL, ok := replayUploadURL(replayKey); ok {
		env = append(env, [2]string{"REPLAY_PUT_URL", putURL}, [2]string{"REPLAY_KEY", replayKey})
	}
	envData, err := envFile(env)
	if err != nil {
		return "", "", &configError{err}
	}
	logf("run %s → flow sandbox %s (key: %v)", job.RunID, flow.Name, anthropicKey != "")

	// The flow writes its state every ~1.5 s; the latest one is saved on the next poll (and the last
	// once the flow ended), so a burst of them is one write.
	var pending struct {
		resultJSON, nodeEvents json.RawMessage
		dirty                  bool
	}
	saveState := func() {
		if pending.dirty {
			pending.dirty = false
			saveFlowState(job, pending.resultJSON, pending.nodeEvents)
		}
	}
	relay := &flowRelay{
		subject:   "run." + job.RunID,
		replayKey: replayKey,
		publish:   func(subject string, data []byte) { publishLive(subject, data) },
		maxPub:    maxPublish(),
		saveState: func(r, n json.RawMessage) {
			pending.resultJSON, pending.nodeEvents, pending.dirty = r, n, true
		},
	}
	beat := heartbeat(msg)
	res, err := runSandboxJob(ctx, box, SandboxJob{
		Name:        sandboxName(job),
		BaseDigest:  digest,
		NetworkMode: networkMode,
		CPUs:        cpus,
		MemoryBytes: flowMemoryBytes,
		Files: []SandboxFile{
			{Path: jobDir + "/env", Mode: 0o600, Data: envData},
			{Path: jobDir + "/graph.json", Mode: 0o600, Data: []byte(job.Graph)},
			{Path: jobDir + "/input.json", Mode: 0o600, Data: []byte(job.Input)},
		},
		Script:     jobScript(jobDir+"/out.log", jobDir+"/env", "cd /app && exec node exec.mjs"),
		StreamPath: jobDir + "/events.jsonl",
		LogPath:    jobDir + "/out.log",
		LogTail:    64 << 10,
		Timeout:    jobTimeout,
		Poll:       sandboxPoll,
		OnStarted:  func() { markRunning(context.Background(), job) },
		OnChunk:    relay.Write,
		OnTick: func() {
			beat()
			saveState()
		},
	})
	if isBaseNotFound(err) {
		flow.Forget(digest)
	}
	relay.Flush()
	saveState()
	if relay.ReplaySet {
		setReplayKey(job, replayKey)
	}
	output = trimLog(res.Log)
	switch {
	case err != nil:
		return output, "", err
	case res.TimedOut:
		return output, fmt.Sprintf("flow timed out after %s", jobTimeout), nil
	case res.ExitCode != 0:
		if relay.Error != "" {
			return output, relay.Error, nil
		}
		return output, fmt.Sprintf("flow exited %d", res.ExitCode), nil
	}
	return output, "", nil
}

// replayUploadURL presigns the PUT of a flow's replay, valid as long as the run can last.
func replayUploadURL(key string) (string, bool) {
	endpoint, bucket := os.Getenv("STORAGE_ENDPOINT"), os.Getenv("STORAGE_BUCKET")
	ak, sk := os.Getenv("STORAGE_ACCESS_KEY"), os.Getenv("STORAGE_SECRET_KEY")
	if endpoint == "" || bucket == "" || ak == "" || sk == "" {
		return "", false
	}
	u, err := presignPut(endpoint, envStr("STORAGE_REGION", "us-east-1"), bucket, key, ak, sk, jobTimeout+5*time.Minute, time.Now())
	if err != nil {
		logf("replay upload URL: %v", err)
		return "", false
	}
	return u, true
}

func saveFlowState(job Job, resultJSON, nodeEvents json.RawMessage) {
	if db == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := db.Exec(ctx,
		"UPDATE runner_runs SET result_json=$3::jsonb, node_events=$4::jsonb WHERE tenant_id=$1 AND id=$2",
		job.TenantID, job.RunID, string(resultJSON), string(nodeEvents),
	); err != nil {
		logf("run %s save state: %v", job.RunID, err)
	}
}

func setReplayKey(job Job, key string) {
	if db == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := db.Exec(ctx,
		"UPDATE runner_runs SET replay_key=$3 WHERE tenant_id=$1 AND id=$2",
		job.TenantID, job.RunID, key,
	); err != nil {
		logf("run %s replay key: %v", job.RunID, err)
	}
}

func handleJob(ctx context.Context, msg jetstream.Msg) {
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
	//  1) a GLOBAL execution slot (globalSem) — bounds total concurrent sandboxes;
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

	run := runShell
	if job.Mode == "flow" {
		run = runFlow
	}
	output, failure, err := run(ctx, msg, job)
	if output != "" {
		logf("run %s output: %s", job.RunID, firstN(output, 2000))
	}
	rec := context.Background() // the run is recorded even while the runner stops
	var ce *configError
	switch {
	case err == nil && failure == "":
		logf("run %s succeeded", job.RunID)
		markResult(rec, job, "succeeded", output, "")
		_ = msg.Ack()
	case err == nil:
		// The job's code ran and failed: recorded, never repeated.
		logf("run %s failed: %s", job.RunID, failure)
		markResult(rec, job, "failed", output, failure)
		_ = msg.Ack()
	case ctx.Err() != nil:
		// The runner is stopping: its sandbox is already terminated, and the job runs again on the
		// next runner, as it would have after a crash.
		logf("run %s interrupted — the runner is stopping; requeued", job.RunID)
		_ = msg.Nak()
	case errors.As(err, &ce):
		logf("run %s cannot run: %v", job.RunID, err)
		markResult(rec, job, "failed", "", err.Error())
		_ = msg.Term()
	case errors.Is(err, errFlowBaseBuilding) || isStartError(err):
		// Nothing of the job ran yet — usually a Box at capacity, or the flow base still building.
		// Requeue it (runner_runs stays 'queued') until its delivery budget is spent.
		if deliveries(msg) >= maxDeliver {
			logf("run %s could not start after %d tries: %v", job.RunID, maxDeliver, err)
			markResult(rec, job, "failed", "", "could not start the run's sandbox: "+err.Error())
			_ = msg.Term()
			return
		}
		delay := 5 * time.Second
		switch {
		case errors.Is(err, errFlowBaseBuilding):
			delay = 15 * time.Second
			logf("run %s waits for the flow sandbox base %s", job.RunID, flow.Name)
		case isWorkspaceFull(err):
			logf("run %s waits — the Box is full", job.RunID)
		default:
			logf("run %s could not start its sandbox (requeued): %v", job.RunID, err)
		}
		_ = msg.NakWithDelay(delay)
	default:
		// The job's code ran, then its sandbox was lost: recorded as failed, never repeated.
		logf("run %s sandbox error: %v", job.RunID, err)
		markResult(rec, job, "failed", output, err.Error())
		_ = msg.Ack()
	}
}

// sweepOrphans terminates the sandboxes a previous run of this runner container left behind (it
// was killed mid-job): the Box does not end them by itself.
func sweepOrphans(ctx context.Context) {
	list, err := box.Sandboxes(ctx, "")
	if err != nil {
		logf("orphan sweep: %v", err)
		return
	}
	for _, sb := range list {
		if !strings.HasPrefix(sb.Name, sandboxPrefix) || sb.Status == "TERMINATED" || sb.Status == "ARCHIVED" {
			continue
		}
		if err := box.terminateDetached(sb.ID); err != nil {
			logf("orphan sweep: terminate %s (%s): %v", sb.Name, sb.ID, err)
		} else {
			logf("orphan sweep: terminated %s (%s)", sb.Name, sb.ID)
		}
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
	var err error
	if networkMode, err = sandboxNetworkMode(os.Getenv("RUNNER_NETWORK_MODE")); err != nil {
		log.Fatalf("[runner] %v", err)
	}
	boxURL, boxKey := strings.TrimRight(os.Getenv("BOX_API_URL"), "/"), os.Getenv("BOX_API_KEY")
	if boxURL == "" || boxKey == "" {
		log.Fatal("[runner] missing BOX_API_URL/BOX_API_KEY — exiting for a restart with env present")
	}
	box = &Box{URL: boxURL, Key: boxKey, HTTP: &http.Client{Timeout: 2 * time.Minute}}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	shellBase = &namedBase{name: envStr("RUNNER_SHELL_BASE", "default")}
	digest, err := shellBase.Digest(ctx, box)
	if err != nil {
		log.Fatalf("[runner] Box at %s: shell base %q: %v — exiting for restart", boxURL, shellBase.name, err)
	}
	logf("Box %s ready · shell base %s (%s) · network %s", boxURL, shellBase.name, firstN(digest, 19), networkMode)
	host, _ := os.Hostname()
	sandboxPrefix = "noola-" + hostTag(host) + "-"
	sweepOrphans(ctx)

	// The flow base: found (or built) on the Box from the flow-runner sources next to the binary.
	flowDir := os.Getenv("RUNNER_FLOW_DIR")
	if flowDir == "" {
		if exe, err := os.Executable(); err == nil {
			flowDir = filepath.Join(filepath.Dir(exe), "flow-runner")
		}
	}
	if flow, flowErr = newFlowBase(flowDir); flowErr != nil {
		logf("flow jobs disabled: %v", flowErr)
	} else if _, err := flow.Digest(ctx, box); err == nil {
		logf("flow base ready: %s", flow.Name)
	} else {
		logf("flow base %s: %v", flow.Name, err)
	}

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
	nc, err = nats.Connect(url,
		nats.UserInfo(os.Getenv("NATS_USER"), os.Getenv("NATS_PASS")),
		nats.Name("agent-studio-runner"),
		nats.MaxReconnects(-1),
	)
	if err != nil {
		log.Fatalf("[runner] NATS connect: %v", err)
	}
	logf("connected to NATS at %s · global cap %d", nc.ConnectedUrl(), globalMax)

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
		MaxDeliver:    maxDeliver,
		MaxAckPending: ackPending,
	})
	if err != nil {
		log.Fatalf("[runner] consumer ensure: %v", err)
	}
	logf(`consumer "runner" ready (ack-pending %d)`, ackPending)

	// One goroutine per delivered message; admission control inside handleJob (globalSem +
	// per-tenant tryAcquire) decides run-now vs Nak-requeue. Concurrency is bounded by globalSem,
	// delivery breadth by MaxAckPending above.
	var (
		jobs    sync.WaitGroup
		jobsMu  sync.Mutex
		closing bool
	)
	cc, err := cons.Consume(func(msg jetstream.Msg) {
		jobsMu.Lock()
		if closing {
			jobsMu.Unlock()
			_ = msg.Nak()
			return
		}
		jobs.Add(1)
		jobsMu.Unlock()
		go func() {
			defer jobs.Done()
			handleJob(ctx, msg)
		}()
	})
	if err != nil {
		log.Fatalf("[runner] consume: %v", err)
	}
	if tenantMax > 0 {
		logf("consuming jobs.run — up to %d concurrent runs (≤%d per tenant)", globalMax, tenantMax)
	} else {
		logf("consuming jobs.run — up to %d concurrent runs (no per-tenant cap)", globalMax)
	}

	// On SIGTERM (a deploy, a restart): take no more jobs, end the running ones' sandboxes and
	// requeue those jobs, then go.
	<-ctx.Done()
	logf("stopping — terminating the running jobs' sandboxes")
	jobsMu.Lock()
	closing = true
	jobsMu.Unlock()
	cc.Stop()
	jobs.Wait()
	_ = nc.Drain()
	logf("stopped")
}
