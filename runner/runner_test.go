package main

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nats-io/nats.go/jetstream"
)

// handleJob end to end against the fake Box: which sandbox a job gets, what goes into it, what is
// relayed live, and how its message is settled.

type fakeMsg struct {
	jetstream.Msg // unimplemented methods panic
	data          []byte
	delivered     uint64

	mu      sync.Mutex
	settled []string
}

func (m *fakeMsg) Data() []byte { return m.data }
func (m *fakeMsg) Metadata() (*jetstream.MsgMetadata, error) {
	return &jetstream.MsgMetadata{NumDelivered: m.delivered}, nil
}
func (m *fakeMsg) settle(s string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.settled = append(m.settled, s)
	return nil
}
func (m *fakeMsg) Ack() error                         { return m.settle("ack") }
func (m *fakeMsg) Nak() error                         { return m.settle("nak") }
func (m *fakeMsg) NakWithDelay(d time.Duration) error { return m.settle("nak " + d.String()) }
func (m *fakeMsg) Term() error                        { return m.settle("term") }
func (m *fakeMsg) InProgress() error                  { return nil }

func (m *fakeMsg) outcome() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return strings.Join(m.settled, ",")
}

func jobMsg(t *testing.T, job Job) *fakeMsg {
	t.Helper()
	data, err := json.Marshal(job)
	if err != nil {
		t.Fatal(err)
	}
	return &fakeMsg{data: data, delivered: 1}
}

type liveEvents struct {
	mu     sync.Mutex
	events []string
}

func (l *liveEvents) all() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.events...)
}

// useFakeBox points the runner's globals at a fake Box and captures what it publishes live.
func useFakeBox(t *testing.T) (*fakeBox, *liveEvents) {
	f := newFakeBox(t)
	live := &liveEvents{}
	oldPublish, oldPoll, oldTimeout := publishLive, sandboxPoll, jobTimeout
	box, shellBase, networkMode = f.client(), &namedBase{name: "default"}, "INTERNET"
	sandboxPrefix = "noola-test-1-"
	globalSem = make(chan struct{}, 3)
	inflight = map[string]int{}
	tenantMax = 2
	sandboxPoll, jobTimeout = 5*time.Millisecond, 5*time.Second
	publishLive = func(subject string, data []byte) {
		live.mu.Lock()
		defer live.mu.Unlock()
		live.events = append(live.events, subject+" "+string(data))
	}
	t.Cleanup(func() {
		box, flow, flowErr = nil, nil, nil
		publishLive, sandboxPoll, jobTimeout = oldPublish, oldPoll, oldTimeout
	})
	return f, live
}

func TestShellJobRunsInItsOwnSandbox(t *testing.T) {
	f, live := useFakeBox(t)
	f.proc = writes(jobDir+"/out.log", 0, "hi from ", "the sandbox\n")
	msg := jobMsg(t, Job{RunID: "run-1234-abcd", TenantID: "t1", Cmd: "echo hi from the sandbox"})
	handleJob(context.Background(), msg)

	if got := msg.outcome(); got != "ack" {
		t.Fatalf("settled %q, want ack", got)
	}
	sbs := f.sandboxes()
	if len(sbs) != 1 {
		t.Fatalf("%d sandboxes", len(sbs))
	}
	sb := sbs[0]
	if !strings.HasPrefix(sb.name, "noola-test-1-run-1234-") || sb.digest != "sha256:default" || sb.memory != memoryBytes {
		t.Fatalf("sandbox %+v", sb)
	}
	if cmd, _ := sb.file(jobDir + "/cmd.sh"); string(cmd) != "echo hi from the sandbox\n" {
		t.Fatalf("cmd.sh = %q", cmd)
	}
	var out strings.Builder
	for _, ev := range live.all() {
		subject, data, _ := strings.Cut(ev, " ")
		var e struct{ Type, Data string }
		_ = json.Unmarshal([]byte(data), &e)
		if subject != "run.run-1234-abcd" || e.Type != "output" {
			t.Fatalf("live event %s", ev)
		}
		out.WriteString(e.Data)
	}
	if out.String() != "hi from the sandbox\n" {
		t.Fatalf("live output %q", out.String())
	}
	f.assertAllTerminated(t)
}

func TestShellJobFailingCommandIsNotRepeated(t *testing.T) {
	f, _ := useFakeBox(t)
	f.proc = writes(jobDir+"/out.log", 2, "nope\n")
	msg := jobMsg(t, Job{RunID: "run-fail", TenantID: "t1", Cmd: "exit 2"})
	handleJob(context.Background(), msg)
	if got := msg.outcome(); got != "ack" {
		t.Fatalf("settled %q, want ack (a run whose code ran is never redelivered)", got)
	}
	f.assertAllTerminated(t)
}

func TestShellJobWaitsWhileTheBoxIsFull(t *testing.T) {
	f, _ := useFakeBox(t)
	f.createErr, f.createCode = 409, "workspaceFull"
	msg := jobMsg(t, Job{RunID: "run-full", TenantID: "t1", Cmd: "true"})
	handleJob(context.Background(), msg)
	if got := msg.outcome(); got != "nak 5s" {
		t.Fatalf("settled %q, want nak 5s", got)
	}

	// Out of deliveries: failed for good rather than left queued.
	msg = jobMsg(t, Job{RunID: "run-full", TenantID: "t1", Cmd: "true"})
	msg.delivered = maxDeliver
	handleJob(context.Background(), msg)
	if got := msg.outcome(); got != "term" {
		t.Fatalf("settled %q, want term", got)
	}
}

func TestShellJobRereadsAStaleBase(t *testing.T) {
	f, _ := useFakeBox(t)
	f.proc = writes(jobDir+"/out.log", 0, "ok\n")
	shellBase.digest = "sha256:old"
	msg := jobMsg(t, Job{RunID: "run-stale", TenantID: "t1", Cmd: "true"})
	handleJob(context.Background(), msg)
	if got := msg.outcome(); got != "nak 5s" {
		t.Fatalf("settled %q, want a requeue", got)
	}
	msg = jobMsg(t, Job{RunID: "run-stale", TenantID: "t1", Cmd: "true"})
	handleJob(context.Background(), msg)
	if got := msg.outcome(); got != "ack" || shellBase.digest != "sha256:default" {
		t.Fatalf("settled %q with digest %q", got, shellBase.digest)
	}
}

func TestShellJobInterruptedByShutdownIsRequeued(t *testing.T) {
	f, _ := useFakeBox(t)
	ctx, cancel := context.WithCancel(context.Background())
	f.proc = func(*fakeSandbox, ExecRequest) int {
		cancel()
		return runsForever
	}
	msg := jobMsg(t, Job{RunID: "run-stop", TenantID: "t1", Cmd: "sleep 600"})
	handleJob(ctx, msg)
	if got := msg.outcome(); got != "nak" {
		t.Fatalf("settled %q, want nak", got)
	}
	f.assertAllTerminated(t)
}

func TestFlowJobWithoutAGraphIsDropped(t *testing.T) {
	useFakeBox(t)
	msg := jobMsg(t, Job{RunID: "run-nograph", TenantID: "t1", Mode: "flow"})
	handleJob(context.Background(), msg)
	if got := msg.outcome(); got != "term" {
		t.Fatalf("settled %q, want term", got)
	}
}

func TestFlowJobWaitsForItsBase(t *testing.T) {
	f, _ := useFakeBox(t)
	f.buildReady = make(chan string, 1)
	var err error
	if flow, err = newFlowBase(writeFlowDir(t, t.TempDir(), "v1")); err != nil {
		t.Fatal(err)
	}
	msg := jobMsg(t, Job{RunID: "run-wait", TenantID: "t1", Mode: "flow", Graph: `{"nodes":[],"edges":[]}`})
	handleJob(context.Background(), msg)
	if got := msg.outcome(); got != "nak 15s" {
		t.Fatalf("settled %q, want nak 15s", got)
	}
	if len(f.sandboxes()) != 0 {
		t.Fatal("a sandbox was created before its base was ready")
	}
	f.buildReady <- flow.Name
}

func TestFlowJobRelaysItsEventsAndKeepsItsState(t *testing.T) {
	f, live := useFakeBox(t)
	t.Setenv("STORAGE_ENDPOINT", "https://storage.example")
	t.Setenv("STORAGE_BUCKET", "b1")
	t.Setenv("STORAGE_ACCESS_KEY", "AK")
	t.Setenv("STORAGE_SECRET_KEY", "SK")
	var err error
	if flow, err = newFlowBase(writeFlowDir(t, t.TempDir(), "v1")); err != nil {
		t.Fatal(err)
	}
	f.bases = append(f.bases, BoxBase{Name: flow.Name, Digest: "sha256:flow", Status: "READY"})
	events := jobDir + "/events.jsonl"
	f.proc = writes(events, 0,
		`{"type":"node-start","nodeId":"n1","kind":"goto"}`+"\n",
		`{"type":"state","resultJson":{"items":[]},"nodeEvents":[],"error":null}`+"\n"+`{"type":"node-do`,
		`ne","nodeId":"n1","status":"ok"}`+"\n",
		`{"type":"run-done","status":"ok"}`+"\n"+`{"type":"replay","key":"runs/t1/run-flow.webm"}`+"\n",
	)
	graph := `{"nodes":[{"id":"n1","type":"item","config":{"kind":"goto"}}],"edges":[]}`
	msg := jobMsg(t, Job{RunID: "run-flow", TenantID: "t1", Mode: "flow", Graph: graph, Input: `{"json":{},"text":""}`})
	handleJob(context.Background(), msg)

	if got := msg.outcome(); got != "ack" {
		t.Fatalf("settled %q", got)
	}
	sbs := f.sandboxes()
	if len(sbs) != 1 || sbs[0].digest != "sha256:flow" || sbs[0].memory != flowMemoryBytes {
		t.Fatalf("sandboxes %+v", sbs)
	}
	sb := sbs[0]
	if g, _ := sb.file(jobDir + "/graph.json"); string(g) != graph {
		t.Fatalf("graph.json = %q", g)
	}
	env, _ := sb.file(jobDir + "/env")
	for _, want := range []string{"RUN_ID='run-flow'", "EVENTS_FILE='" + events + "'", "REPLAY_KEY='runs/t1/run-flow.webm'", "REPLAY_PUT_URL='https://storage.example/b1/runs/t1/run-flow.webm?"} {
		if !strings.Contains(string(env), want) {
			t.Errorf("env file has no %s", want)
		}
	}
	if strings.Contains(string(env), "SK") || strings.Contains(string(env), "STORAGE_") || strings.Contains(string(env), "DB_") || strings.Contains(string(env), "NATS_") {
		t.Errorf("env file carries the runner's own credentials:\n%s", env)
	}
	want := []string{
		`run.run-flow {"type":"node-start","nodeId":"n1","kind":"goto"}`,
		`run.run-flow {"type":"node-done","nodeId":"n1","status":"ok"}`,
		`run.run-flow {"type":"run-done","status":"ok"}`,
	}
	if got := live.all(); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("live events:\n%s", strings.Join(got, "\n"))
	}
	f.assertAllTerminated(t)
}

func TestFlowJobFailureCarriesTheFlowsOwnError(t *testing.T) {
	f, _ := useFakeBox(t)
	var err error
	if flow, err = newFlowBase(writeFlowDir(t, t.TempDir(), "v1")); err != nil {
		t.Fatal(err)
	}
	f.bases = append(f.bases, BoxBase{Name: flow.Name, Digest: "sha256:flow", Status: "READY"})
	f.proc = func(sb *fakeSandbox, _ ExecRequest) int {
		sb.appendFile(jobDir+"/events.jsonl", []byte(`{"type":"state","resultJson":{"items":[]},"nodeEvents":[],"error":"browser init timed out"}`+"\n"))
		sb.appendFile(jobDir+"/out.log", []byte("[flow-exec] fatal\n"))
		return 1
	}
	job := Job{RunID: "run-ff", TenantID: "t1", Mode: "flow", Graph: `{"nodes":[],"edges":[]}`}
	output, failure, err := runFlow(context.Background(), jobMsg(t, job), job)
	if err != nil || failure != "browser init timed out" || output != "[flow-exec] fatal" {
		t.Fatalf("output %q failure %q err %v", output, failure, err)
	}
	f.assertAllTerminated(t)
}
