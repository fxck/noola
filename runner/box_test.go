package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// A fake Box workspace API, enough of it for the runner: bases, sandbox create/terminate/list, exec
// (mkdir and the tail/head/base64 reads the runner sends), file writes, background processes and
// their sessions. A process is simulated by a Go func that writes the sandbox's files.

type fakeProc func(sb *fakeSandbox, req ExecRequest) (exitCode int)

// runsForever is a fakeProc exit code: the process runs until its timeout or the sandbox ends.
const runsForever = -1000

type fakeSandbox struct {
	id, name, digest, network string
	cpus                      int
	memory                    int64

	mu     sync.Mutex
	status string
	files  map[string][]byte
	modes  map[string]string
	ended  chan struct{}
}

func (sb *fakeSandbox) appendFile(path string, data []byte) {
	sb.mu.Lock()
	defer sb.mu.Unlock()
	sb.files[path] = append(sb.files[path], data...)
}

func (sb *fakeSandbox) file(path string) ([]byte, bool) {
	sb.mu.Lock()
	defer sb.mu.Unlock()
	b, ok := sb.files[path]
	return append([]byte(nil), b...), ok
}

type fakeSession struct {
	ID       string `json:"id"`
	Status   string `json:"status"`
	ExitCode *int   `json:"exitCode"`
}

type fakeBox struct {
	t      *testing.T
	srv    *httptest.Server
	mu     sync.Mutex
	bases  []BoxBase
	boxes  map[string]*fakeSandbox
	order  []string
	sess   map[string]*fakeSession
	nextID int

	proc       fakeProc
	createErr  int    // HTTP status the next creates answer with, 0 = create
	createCode string // its error code
	processErr int    // HTTP status /process answers with, 0 = start
	builds     []string
	buildReady chan string // a build waits for its name on this channel, nil = ready at once
	pulls      []string    // "<name> <imageRef>" of each pull
	pullOps    map[string]string
	pullReady  chan bool // a pull waits on this channel (true = READY, false = FAILED), nil = ready at once
	execs      []string
}

func newFakeBox(t *testing.T) *fakeBox {
	f := &fakeBox{
		t:     t,
		bases: []BoxBase{{Name: "default", Digest: "sha256:default", Status: "READY"}},
		boxes: map[string]*fakeSandbox{},
		sess:  map[string]*fakeSession{},

		pullOps: map[string]string{},
	}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeBox) client() *Box { return &Box{URL: f.srv.URL, Key: "test-key"} }

func (f *fakeBox) id(prefix string) string {
	f.nextID++
	return fmt.Sprintf("%s%d", prefix, f.nextID)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]any{"error": map[string]any{"code": code, "message": code}})
}

var (
	readFromRE = regexp.MustCompile(`^tail -c \+(\d+) '([^']*)' 2>/dev/null \| head -c (\d+) \| base64 -w0$`)
	readTailRE = regexp.MustCompile(`^tail -c (\d+) '([^']*)' 2>/dev/null \| base64 -w0$`)
)

func (f *fakeBox) serve(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer test-key" {
		writeErr(w, 401, "unauthorized")
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/rest")
	parts := strings.Split(strings.Trim(path, "/"), "/")
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case r.Method == "GET" && path == "/base-list":
		writeJSON(w, 200, map[string]any{"items": f.bases})

	case r.Method == "POST" && path == "/base-build":
		name := r.URL.Query().Get("name")
		body, _ := io.ReadAll(r.Body)
		if len(body) == 0 || r.Header.Get("Content-Type") != "application/octet-stream" {
			writeErr(w, 400, "invalidUserInput")
			return
		}
		f.builds = append(f.builds, name)
		f.bases = append(f.bases, BoxBase{Name: name, Status: "FLATTENING"})
		opID := f.id("op-build-")
		ready := func() {
			f.mu.Lock()
			defer f.mu.Unlock()
			for i := range f.bases {
				if f.bases[i].Name == name {
					f.bases[i].Status, f.bases[i].Digest = "READY", "sha256:"+name
				}
			}
		}
		if f.buildReady == nil {
			defer func() { go ready() }()
		} else {
			ch := f.buildReady
			go func() {
				if <-ch == name {
					ready()
				}
			}()
		}
		writeJSON(w, 202, BoxOperation{ID: opID, Kind: "BUILD_BASE", Status: "RUNNING"})

	case r.Method == "POST" && path == "/base":
		var req struct{ ImageRef, Name string }
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ImageRef == "" || r.Header.Get("Idempotency-Key") == "" {
			writeErr(w, 400, "invalidUserInput")
			return
		}
		f.pulls = append(f.pulls, req.Name+" "+req.ImageRef)
		for i := range f.bases { // the name moves to the new base
			if f.bases[i].Name == req.Name {
				f.bases[i].Name = ""
			}
		}
		digest := fmt.Sprintf("sha256:pulled-%d", len(f.pulls))
		f.bases = append(f.bases, BoxBase{Name: req.Name, Digest: digest, Status: "PULLING"})
		opID := f.id("op-pull-")
		f.pullOps[opID] = digest
		settle := func(ok bool) {
			f.mu.Lock()
			defer f.mu.Unlock()
			for i := range f.bases {
				if f.bases[i].Digest == digest {
					f.bases[i].Status = map[bool]string{true: "READY", false: "FAILED"}[ok]
				}
			}
		}
		if f.pullReady == nil {
			defer func() { go settle(true) }()
		} else {
			ch := f.pullReady
			go func() { settle(<-ch) }()
		}
		writeJSON(w, 200, BoxOperation{ID: opID, Kind: "PULL_BASE", Status: "RUNNING"})

	case r.Method == "GET" && len(parts) == 2 && parts[0] == "operation":
		if digest, ok := f.pullOps[parts[1]]; ok {
			status := "RUNNING"
			for _, b := range f.bases {
				if b.Digest == digest {
					status = map[string]string{"READY": "FINISHED", "FAILED": "FAILED"}[b.Status]
				}
			}
			if status == "" {
				status = "RUNNING"
				f.mu.Unlock()
				time.Sleep(20 * time.Millisecond)
				f.mu.Lock()
			}
			writeJSON(w, 200, BoxOperation{ID: parts[1], Kind: "PULL_BASE", Status: status, Error: map[bool]string{true: "image unreachable"}[status == "FAILED"]})
			return
		}
		if strings.HasPrefix(parts[1], "op-build-") {
			// The build finishes once the fake marks its base READY.
			for _, b := range f.bases {
				if b.Status != "READY" {
					f.mu.Unlock()
					time.Sleep(20 * time.Millisecond)
					f.mu.Lock()
					writeJSON(w, 200, BoxOperation{ID: parts[1], Kind: "BUILD_BASE", Status: "RUNNING"})
					return
				}
			}
		}
		writeJSON(w, 200, BoxOperation{ID: parts[1], Status: "FINISHED"})

	case r.Method == "POST" && path == "/sandbox":
		if f.createErr != 0 {
			writeErr(w, f.createErr, f.createCode)
			return
		}
		var req CreateSandbox
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Integrations == nil || r.Header.Get("Idempotency-Key") == "" {
			writeErr(w, 400, "invalidUserInput")
			return
		}
		if req.NetworkMode != "INTERNET" && req.NetworkMode != "AIRGAPPED" {
			f.t.Errorf("sandbox created on network %q", req.NetworkMode)
		}
		known := false
		for _, b := range f.bases {
			known = known || (b.Digest == req.BaseDigest && b.Status == "READY")
		}
		if !known {
			writeErr(w, 404, "baseNotFound")
			return
		}
		sb := &fakeSandbox{
			id: f.id("sb-"), name: req.Name, digest: req.BaseDigest, network: req.NetworkMode,
			cpus: req.CPUs, memory: req.MemoryBytes, status: "RUNNING",
			files: map[string][]byte{}, modes: map[string]string{}, ended: make(chan struct{}),
		}
		f.boxes[sb.id] = sb
		f.order = append(f.order, sb.id)
		writeJSON(w, 200, map[string]any{
			"operation": BoxOperation{ID: f.id("op-"), Kind: "CREATE", Status: "FINISHED", SandboxID: sb.id},
			"sandboxes": []BoxSandbox{{ID: sb.id, Name: sb.name, Status: "RUNNING"}},
		})

	case r.Method == "GET" && path == "/sandbox-list":
		var items []BoxSandbox
		for _, id := range f.order {
			sb := f.boxes[id]
			if sb.status != "TERMINATED" {
				items = append(items, BoxSandbox{ID: sb.id, Name: sb.name, Status: sb.status})
			}
		}
		writeJSON(w, 200, map[string]any{"items": items})

	case len(parts) >= 2 && parts[0] == "sandbox":
		sb := f.boxes[parts[1]]
		if sb == nil {
			writeErr(w, 404, "sandboxNotFound")
			return
		}
		if r.Method == "GET" && len(parts) == 2 {
			writeJSON(w, 200, BoxSandbox{ID: sb.id, Name: sb.name, Status: sb.status})
			return
		}
		if r.Method == "DELETE" && len(parts) == 2 {
			if r.Header.Get("Idempotency-Key") == "" {
				writeErr(w, 400, "invalidUserInput")
				return
			}
			if sb.status != "TERMINATED" {
				sb.status = "TERMINATED"
				close(sb.ended)
			}
			writeJSON(w, 200, BoxOperation{ID: f.id("op-"), Kind: "TERMINATE", Status: "FINISHED"})
			return
		}
		if sb.status != "RUNNING" {
			writeErr(w, 409, "sandboxNotRunning")
			return
		}
		switch {
		case r.Method == "PUT" && len(parts) == 3 && parts[2] == "file":
			p, mode := r.URL.Query().Get("path"), r.URL.Query().Get("mode")
			data, _ := io.ReadAll(r.Body)
			sb.mu.Lock()
			sb.files[p], sb.modes[p] = data, mode
			sb.mu.Unlock()
			w.WriteHeader(204)

		case r.Method == "POST" && len(parts) == 3 && parts[2] == "exec":
			var req ExecRequest
			_ = json.NewDecoder(r.Body).Decode(&req)
			f.execs = append(f.execs, strings.Join(req.Command, " "))
			writeJSON(w, 200, f.exec(sb, req))

		case r.Method == "POST" && len(parts) == 3 && parts[2] == "process":
			if f.processErr != 0 {
				writeErr(w, f.processErr, "substrateFailed")
				return
			}
			var req ExecRequest
			_ = json.NewDecoder(r.Body).Decode(&req)
			s := &fakeSession{ID: f.id("sess-"), Status: "OPEN"}
			f.sess[s.ID] = s
			go f.runProc(sb, s, req)
			writeJSON(w, 200, s)

		default:
			writeErr(w, 404, "notFound")
		}

	case r.Method == "GET" && len(parts) == 2 && parts[0] == "session":
		s := f.sess[parts[1]]
		if s == nil {
			writeErr(w, 404, "sessionNotFound")
			return
		}
		writeJSON(w, 200, s)

	default:
		writeErr(w, 404, "notFound")
	}
}

func (f *fakeBox) exec(sb *fakeSandbox, req ExecRequest) ExecResult {
	zero := 0
	if len(req.Command) > 0 && req.Command[0] == "mkdir" {
		return ExecResult{ExitCode: &zero}
	}
	if len(req.Command) == 3 && req.Command[0] == "sh" && req.Command[1] == "-c" {
		data, _ := sb.file("")
		if m := readFromRE.FindStringSubmatch(req.Command[2]); m != nil {
			from, _ := strconv.Atoi(m[1])
			max, _ := strconv.Atoi(m[3])
			data, _ = sb.file(m[2])
			if from-1 < len(data) {
				data = data[from-1:]
			} else {
				data = nil
			}
			if len(data) > max {
				data = data[:max]
			}
			return ExecResult{ExitCode: &zero, Stdout: base64.StdEncoding.EncodeToString(data)}
		}
		if m := readTailRE.FindStringSubmatch(req.Command[2]); m != nil {
			n, _ := strconv.Atoi(m[1])
			data, _ = sb.file(m[2])
			if len(data) > n {
				data = data[len(data)-n:]
			}
			return ExecResult{ExitCode: &zero, Stdout: base64.StdEncoding.EncodeToString(data)}
		}
	}
	one := 1
	return ExecResult{ExitCode: &one, Stderr: "fake box: unknown command " + strings.Join(req.Command, " ")}
}

func (f *fakeBox) runProc(sb *fakeSandbox, s *fakeSession, req ExecRequest) {
	done := make(chan int, 1)
	go func() { done <- f.proc(sb, req) }()
	var timeout <-chan time.Time
	if req.TimeoutSeconds > 0 {
		timeout = time.After(time.Duration(req.TimeoutSeconds) * time.Second)
	}
	var code *int
	select {
	case c := <-done:
		if c != runsForever {
			code = &c
		} else {
			select {
			case <-timeout:
			case <-sb.ended:
			}
		}
	case <-timeout: // killed: no exit code
	case <-sb.ended:
	}
	f.mu.Lock()
	s.Status, s.ExitCode = "CLOSED", code
	f.mu.Unlock()
}

func (f *fakeBox) pullCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.pulls)
}

func (f *fakeBox) sandboxes() []*fakeSandbox {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []*fakeSandbox
	for _, id := range f.order {
		out = append(out, f.boxes[id])
	}
	return out
}

func (f *fakeBox) assertAllTerminated(t *testing.T) {
	t.Helper()
	for _, sb := range f.sandboxes() {
		f.mu.Lock()
		st := sb.status
		f.mu.Unlock()
		if st != "TERMINATED" {
			t.Errorf("sandbox %s (%s) left %s", sb.id, sb.name, st)
		}
	}
}

// writes returns a fakeProc that appends each chunk to path, pausing between them, then exits.
func writes(path string, exit int, chunks ...string) fakeProc {
	return func(sb *fakeSandbox, _ ExecRequest) int {
		for _, c := range chunks {
			sb.appendFile(path, []byte(c))
			time.Sleep(15 * time.Millisecond)
		}
		return exit
	}
}

func testJob(name string) SandboxJob {
	return SandboxJob{
		Name: name, BaseDigest: "sha256:default", NetworkMode: "INTERNET",
		Files:      []SandboxFile{{Path: jobDir + "/env", Mode: 0o600, Data: []byte("A='1'\n")}},
		Script:     jobScript(jobDir+"/out.log", jobDir+"/env", "exec sh /tmp/noola/cmd.sh"),
		StreamPath: jobDir + "/out.log", Timeout: 5 * time.Second, Poll: 5 * time.Millisecond,
	}
}

// ── runSandboxJob ────────────────────────────────────────────────────────────

func TestSandboxJobStreamsOutputAndTerminates(t *testing.T) {
	f := newFakeBox(t)
	// "wörld" is cut inside its ö across two writes: the stream still arrives byte-exact.
	f.proc = writes(jobDir+"/out.log", 0, "hello\n", "w\xc3", "\xb6rld\n")
	job := testJob("noola-test-1")
	var got bytes.Buffer
	started := 0
	job.OnChunk = func(b []byte) { got.Write(b) }
	job.OnStarted = func() { started++ }
	job.LogPath, job.LogTail = jobDir+"/out.log", 1<<10

	res, err := runSandboxJob(context.Background(), f.client(), job)
	if err != nil {
		t.Fatalf("runSandboxJob: %v", err)
	}
	if res.ExitCode != 0 || res.TimedOut {
		t.Fatalf("result = %+v, want exit 0", res)
	}
	if got.String() != "hello\nwörld\n" || string(res.Log) != "hello\nwörld\n" {
		t.Fatalf("streamed %q, log %q", got.String(), res.Log)
	}
	if started != 1 {
		t.Fatalf("OnStarted ran %d times", started)
	}
	sbs := f.sandboxes()
	if len(sbs) != 1 {
		t.Fatalf("%d sandboxes created, want 1", len(sbs))
	}
	if sbs[0].name != "noola-test-1" || sbs[0].network != "INTERNET" {
		t.Fatalf("sandbox %+v", sbs[0])
	}
	if env, _ := sbs[0].file(jobDir + "/env"); string(env) != "A='1'\n" || sbs[0].modes[jobDir+"/env"] != "0600" {
		t.Fatalf("env file %q mode %q", env, sbs[0].modes[jobDir+"/env"])
	}
	f.assertAllTerminated(t)
}

func TestSandboxJobLargeOutputArrivesWhole(t *testing.T) {
	f := newFakeBox(t)
	big := strings.Repeat("0123456789abcdef", (5*streamChunk/2)/16) // 2.5 chunks in one write
	f.proc = writes(jobDir+"/out.log", 0, big, "tail\n")
	job := testJob("noola-test-big")
	var got bytes.Buffer
	job.OnChunk = func(b []byte) { got.Write(b) }
	if _, err := runSandboxJob(context.Background(), f.client(), job); err != nil {
		t.Fatal(err)
	}
	if got.String() != big+"tail\n" {
		t.Fatalf("streamed %d bytes, want %d", got.Len(), len(big)+5)
	}
	f.assertAllTerminated(t)
}

func TestSandboxJobNonzeroExit(t *testing.T) {
	f := newFakeBox(t)
	f.proc = writes(jobDir+"/out.log", 3, "boom\n")
	res, err := runSandboxJob(context.Background(), f.client(), testJob("noola-test-exit"))
	if err != nil {
		t.Fatal(err)
	}
	if res.ExitCode != 3 {
		t.Fatalf("exit %d, want 3", res.ExitCode)
	}
	f.assertAllTerminated(t)
}

func TestSandboxJobWorkspaceFullIsAStartError(t *testing.T) {
	f := newFakeBox(t)
	f.createErr, f.createCode = 409, "workspaceFull"
	_, err := runSandboxJob(context.Background(), f.client(), testJob("noola-test-full"))
	if !isStartError(err) || !isWorkspaceFull(err) {
		t.Fatalf("err = %v, want a workspaceFull start error", err)
	}
	if n := len(f.sandboxes()); n != 0 {
		t.Fatalf("%d sandboxes created", n)
	}
}

func TestSandboxJobStaleBaseIsAStartError(t *testing.T) {
	f := newFakeBox(t)
	job := testJob("noola-test-stale")
	job.BaseDigest = "sha256:gone"
	_, err := runSandboxJob(context.Background(), f.client(), job)
	if !isStartError(err) || !isBaseNotFound(err) {
		t.Fatalf("err = %v, want a baseNotFound start error", err)
	}
}

func TestSandboxJobTerminatesWhenTheProcessCannotStart(t *testing.T) {
	f := newFakeBox(t)
	f.processErr = 500
	f.proc = writes(jobDir+"/out.log", 0)
	started := false
	job := testJob("noola-test-nostart")
	job.OnStarted = func() { started = true }
	_, err := runSandboxJob(context.Background(), f.client(), job)
	if !isStartError(err) {
		t.Fatalf("err = %v, want a start error", err)
	}
	if started {
		t.Fatal("OnStarted ran for a process that never started")
	}
	if len(f.sandboxes()) != 1 {
		t.Fatal("expected the sandbox to have been created")
	}
	f.assertAllTerminated(t)
}

func TestSandboxJobTimeout(t *testing.T) {
	f := newFakeBox(t)
	f.proc = func(sb *fakeSandbox, _ ExecRequest) int {
		sb.appendFile(jobDir+"/out.log", []byte("working…\n"))
		return runsForever
	}
	job := testJob("noola-test-timeout")
	job.Timeout = time.Second
	var got bytes.Buffer
	job.OnChunk = func(b []byte) { got.Write(b) }
	res, err := runSandboxJob(context.Background(), f.client(), job)
	if err != nil {
		t.Fatal(err)
	}
	if !res.TimedOut || res.ExitCode != -1 {
		t.Fatalf("result = %+v, want a timeout", res)
	}
	if got.String() != "working…\n" {
		t.Fatalf("streamed %q", got.String())
	}
	f.assertAllTerminated(t)
}

func TestSandboxJobShutdownTerminates(t *testing.T) {
	f := newFakeBox(t)
	f.proc = func(*fakeSandbox, ExecRequest) int { return runsForever }
	ctx, cancel := context.WithCancel(context.Background())
	job := testJob("noola-test-shutdown")
	ticks := 0
	job.OnTick = func() {
		if ticks++; ticks == 3 {
			cancel()
		}
	}
	_, err := runSandboxJob(ctx, f.client(), job)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	f.assertAllTerminated(t)
}

// ── the flow base ────────────────────────────────────────────────────────────

func TestFlowBaseBuildsOnceThenAnswersItsDigest(t *testing.T) {
	f := newFakeBox(t)
	f.buildReady = make(chan string, 1)
	dir := writeFlowDir(t, t.TempDir(), "v1")
	fb, err := newFlowBase(dir)
	if err != nil {
		t.Fatal(err)
	}
	box := f.client()
	if _, err := fb.Digest(context.Background(), box); !errors.Is(err, errFlowBaseBuilding) {
		t.Fatalf("first Digest: %v, want building", err)
	}
	if _, err := fb.Digest(context.Background(), box); !errors.Is(err, errFlowBaseBuilding) {
		t.Fatalf("second Digest: %v, want building", err)
	}
	f.buildReady <- fb.Name
	var digest string
	for i := 0; i < 200; i++ {
		if digest, err = fb.Digest(context.Background(), box); err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if digest != "sha256:"+fb.Name {
		t.Fatalf("digest %q (%v)", digest, err)
	}
	f.mu.Lock()
	builds := append([]string(nil), f.builds...)
	f.mu.Unlock()
	if len(builds) != 1 || builds[0] != fb.Name {
		t.Fatalf("builds = %v, want one of %s", builds, fb.Name)
	}

	// Another runner with the same sources finds the base READY and builds nothing.
	fb2, _ := newFlowBase(dir)
	if d, err := fb2.Digest(context.Background(), box); err != nil || d != digest {
		t.Fatalf("second runner: %q %v", d, err)
	}
	if len(f.builds) != 1 {
		t.Fatalf("builds = %v", f.builds)
	}
}

func TestFlowBaseFailedBuildIsReported(t *testing.T) {
	f := newFakeBox(t)
	dir := writeFlowDir(t, t.TempDir(), "v1")
	fb, _ := newFlowBase(dir)
	f.bases = append(f.bases, BoxBase{Name: fb.Name, Status: "FAILED", FailedReason: "npm install failed"})
	fb.rebuilt = true // this runner already rebuilt it once
	_, err := fb.Digest(context.Background(), f.client())
	if !errors.Is(err, errFlowBaseFailed) || !strings.Contains(err.Error(), "npm install failed") {
		t.Fatalf("err = %v", err)
	}
}

// ── the shell base ───────────────────────────────────────────────────────────

// waitDigest calls Digest until it answers something other than errShellBasePulling.
func waitDigest(t *testing.T, n *namedBase, box *Box) (string, error) {
	t.Helper()
	for i := 0; i < 300; i++ {
		d, err := n.Digest(context.Background(), box)
		if !errors.Is(err, errShellBasePulling) {
			return d, err
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("the shell base is still pulling")
	return "", nil
}

func TestShellBasePresentIsNotPulled(t *testing.T) {
	f := newFakeBox(t)
	n := &namedBase{name: "default", image: "https://example.test/base.tar.gz"}
	if d, err := n.Digest(context.Background(), f.client()); err != nil || d != "sha256:default" {
		t.Fatalf("digest %q (%v)", d, err)
	}
	if n := f.pullCount(); n != 0 {
		t.Fatalf("pulls = %d, want none", n)
	}
}

func TestShellBaseMissingIsPulledOnce(t *testing.T) {
	f := newFakeBox(t)
	f.bases = nil // a Box imported without its setup: no base at all
	f.pullReady = make(chan bool, 1)
	n := &namedBase{name: "default", image: "https://example.test/base.tar.gz"}
	box := f.client()
	for i := 0; i < 2; i++ {
		if _, err := n.Digest(context.Background(), box); !errors.Is(err, errShellBasePulling) {
			t.Fatalf("Digest %d: %v, want pulling", i, err)
		}
	}
	for i := 0; i < 300 && f.pullCount() == 0; i++ {
		time.Sleep(10 * time.Millisecond)
	}
	// Another runner on the same Box sees the pull under way and starts none of its own.
	other := &namedBase{name: "default", image: "https://example.test/base.tar.gz"}
	if _, err := other.Digest(context.Background(), box); !errors.Is(err, errShellBasePulling) {
		t.Fatalf("other runner: %v, want pulling", err)
	}
	f.pullReady <- true
	d, err := waitDigest(t, n, box)
	if err != nil || d != "sha256:pulled-1" {
		t.Fatalf("digest %q (%v)", d, err)
	}
	f.mu.Lock()
	pulls := append([]string(nil), f.pulls...)
	f.mu.Unlock()
	if len(pulls) != 1 || pulls[0] != "default https://example.test/base.tar.gz" {
		t.Fatalf("pulls = %v, want one of default", pulls)
	}
	if d2, err := waitDigest(t, other, box); err != nil || d2 != d {
		t.Fatalf("other runner: %q %v", d2, err)
	}
}

func TestShellBaseFailedPullIsRetried(t *testing.T) {
	defer func(d time.Duration) { shellPullRetry = d }(shellPullRetry)
	shellPullRetry = time.Hour
	f := newFakeBox(t)
	f.bases = []BoxBase{{Name: "default", Digest: "sha256:broken", Status: "FAILED"}}
	f.pullReady = make(chan bool, 2)
	n := &namedBase{name: "default", image: "https://example.test/base.tar.gz"}
	box := f.client()
	f.pullReady <- false
	if _, err := waitDigest(t, n, box); err == nil || !strings.Contains(err.Error(), "image unreachable") {
		t.Fatalf("failed pull: %v", err)
	}
	// Within shellPullRetry the failure is answered without another pull…
	if _, err := n.Digest(context.Background(), box); err == nil || errors.Is(err, errShellBasePulling) {
		t.Fatalf("Digest after the failure: %v", err)
	}
	if n := f.pullCount(); n != 1 {
		t.Fatalf("pulls = %d, want 1", n)
	}
	// …and after it the base is pulled again.
	n.mu.Lock()
	n.pullFailed = time.Now().Add(-2 * time.Hour)
	n.mu.Unlock()
	f.pullReady <- true
	if d, err := waitDigest(t, n, box); err != nil || d != "sha256:pulled-2" {
		t.Fatalf("second pull: %q %v", d, err)
	}
}

func TestShellBaseWithoutImageIsNotPulled(t *testing.T) {
	f := newFakeBox(t)
	f.bases = nil
	n := &namedBase{name: "default"}
	if _, err := n.Digest(context.Background(), f.client()); err == nil || errors.Is(err, errShellBasePulling) {
		t.Fatalf("err = %v", err)
	}
	if n := f.pullCount(); n != 0 {
		t.Fatalf("pulls = %d, want none", n)
	}
}

// A shell job that comes while its base pulls waits in the queue: nothing of it runs.
func TestShellJobWaitsForThePull(t *testing.T) {
	f := newFakeBox(t)
	f.bases = nil
	f.pullReady = make(chan bool, 1)
	box = f.client()
	shellBase = &namedBase{name: "default", image: "https://example.test/base.tar.gz"}
	t.Cleanup(func() { box, shellBase = nil, nil; f.pullReady <- true })
	_, _, err := runShell(context.Background(), nil, Job{RunID: "run-1", Cmd: "echo hi"})
	if !errors.Is(err, errShellBasePulling) {
		t.Fatalf("err = %v, want pulling", err)
	}
	if len(f.boxes) != 0 {
		t.Fatalf("a sandbox was created while the base pulled")
	}
}

// ── orphans ──────────────────────────────────────────────────────────────────

func TestSweepOrphansTerminatesOnlyThisRunnersSandboxes(t *testing.T) {
	f := newFakeBox(t)
	box = f.client()
	t.Cleanup(func() { box = nil })
	ctx := context.Background()
	mine, _ := box.CreateSandbox(ctx, CreateSandbox{BaseDigest: "sha256:default", NetworkMode: "INTERNET", Name: "noola-runnerstage-2-abc"}, "k1")
	other, _ := box.CreateSandbox(ctx, CreateSandbox{BaseDigest: "sha256:default", NetworkMode: "INTERNET", Name: "noola-runnerpool-1-abc"}, "k2")
	sandboxPrefix = "noola-runnerstage-2-"
	sweepOrphans(ctx)
	if f.boxes[mine].status != "TERMINATED" {
		t.Fatal("this runner's orphan was left running")
	}
	if f.boxes[other].status != "RUNNING" {
		t.Fatal("another runner's sandbox was terminated")
	}
}
