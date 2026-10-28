package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func getHealth(t *testing.T, h *healthCheck) (int, healthReport) {
	t.Helper()
	srv := httptest.NewServer(h)
	defer srv.Close()
	res, err := http.Get(srv.URL + "/health")
	if err != nil {
		t.Fatalf("GET /health: %v", err)
	}
	defer res.Body.Close()
	var r healthReport
	if err := json.NewDecoder(res.Body).Decode(&r); err != nil {
		t.Fatalf("decode /health: %v", err)
	}
	return res.StatusCode, r
}

func freshSandboxLog(t *testing.T) {
	saved := recentSandboxes
	recentSandboxes = &sandboxLog{}
	t.Cleanup(func() { recentSandboxes = saved })
}

func TestHealthReadyShowsTheBasesAndTheTerminatedSandbox(t *testing.T) {
	freshSandboxLog(t)
	f := newFakeBox(t)
	f.bases = append(f.bases, BoxBase{Name: "noola-flow-runner-test", Digest: "sha256:flow", Status: "READY"})
	f.proc = writes(jobDir+"/out.log", 0, "hi\n")
	job := testJob("noola-test-health")
	job.RunID = "run-h"
	if _, err := runSandboxJob(context.Background(), f.client(), job); err != nil {
		t.Fatalf("runSandboxJob: %v", err)
	}
	h := &healthCheck{
		box: f.client(), shell: &namedBase{name: "default"}, flow: &flowBase{Name: "noola-flow-runner-test"},
		nats: func() bool { return true }, db: true, runs: func() int { return 0 }, maxRuns: 3,
		sandboxes: recentSandboxes,
	}
	code, r := getHealth(t, h)
	if code != 200 || !r.OK || !r.Box.Reachable || !r.NATSConnected || !r.DBConnected {
		t.Fatalf("health %d %+v", code, r)
	}
	if r.ShellBase != (baseHealth{Name: "default", Status: "READY", Digest: "sha256:default"}) {
		t.Fatalf("shell base %+v", r.ShellBase)
	}
	if r.FlowBase != (baseHealth{Name: "noola-flow-runner-test", Status: "READY", Digest: "sha256:flow"}) {
		t.Fatalf("flow base %+v", r.FlowBase)
	}
	if len(r.Sandboxes) != 1 || r.Sandboxes[0].Run != "run-h" || r.Sandboxes[0].Name != "noola-test-health" || r.Sandboxes[0].Status != "TERMINATED" {
		t.Fatalf("sandboxes %+v", r.Sandboxes)
	}
	if s := r.summary(); !strings.HasPrefix(s, "health: ok · Box reachable · shell base default READY (sha256:default) · flow base noola-flow-runner-test READY (sha256:flow) · NATS connected") {
		t.Fatalf("summary %q", s)
	}
}

// On a Box imported without its setup the report follows the pull and the build until both are READY.
func TestHealthFollowsThePullAndTheBuild(t *testing.T) {
	freshSandboxLog(t)
	f := newFakeBox(t)
	f.bases = nil
	f.pullReady = make(chan bool, 1)
	f.buildReady = make(chan string, 1)
	box := f.client()
	shell := &namedBase{name: "default", image: "https://example.test/base.tar.gz"}
	flow := &flowBase{Name: "noola-flow-runner-test", context: []byte("context")}
	var nats atomic.Bool
	h := &healthCheck{
		box: box, shell: shell, flow: flow,
		nats: nats.Load, runs: func() int { return 0 }, maxRuns: 3, sandboxes: recentSandboxes,
	}
	if r := h.report(context.Background(), true); r.OK || r.ShellBase.Status != "MISSING" || r.FlowBase.Status != "MISSING" {
		t.Fatalf("before: %+v", r)
	}
	if _, err := shell.Digest(context.Background(), box); !errors.Is(err, errShellBasePulling) {
		t.Fatalf("shell Digest: %v", err)
	}
	if _, err := flow.Digest(context.Background(), box); !errors.Is(err, errFlowBaseBuilding) {
		t.Fatalf("flow Digest: %v", err)
	}
	// The runner's own pull and build show before the Box lists them, then as the Box lists them.
	r := h.report(context.Background(), true)
	if r.OK || r.ShellBase.Status != "PULLING" || r.FlowBase.Status != "BUILDING" && r.FlowBase.Status != "FLATTENING" {
		t.Fatalf("while making them: %+v", r)
	}
	code, _ := getHealth(t, h)
	if code != http.StatusServiceUnavailable {
		t.Fatalf("status %d while not ready, want 503", code)
	}
	f.pullReady <- true
	f.buildReady <- flow.Name
	nats.Store(true)
	for i := 0; i < 300; i++ {
		if r = h.report(context.Background(), true); r.OK {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !r.OK || r.ShellBase.Digest != "sha256:pulled-1" || r.FlowBase.Digest != "sha256:"+flow.Name {
		t.Fatalf("after: %+v", r)
	}
}

func TestHealthFailedPullShowsWhy(t *testing.T) {
	freshSandboxLog(t)
	f := newFakeBox(t)
	f.bases = nil
	f.pullReady = make(chan bool, 1)
	f.pullReady <- false
	box := f.client()
	shell := &namedBase{name: "default", image: "https://example.test/base.tar.gz"}
	if _, err := waitDigest(t, shell, box); err == nil {
		t.Fatal("the pull did not fail")
	}
	h := &healthCheck{
		box: box, shell: shell, flow: nil, flowErr: errors.New("no flow-runner sources"),
		nats: func() bool { return true }, runs: func() int { return 0 }, sandboxes: recentSandboxes,
	}
	r := h.report(context.Background(), false)
	if r.OK || r.ShellBase.Status != "FAILED" || !strings.Contains(r.ShellBase.Error, "image unreachable") {
		t.Fatalf("shell base %+v", r.ShellBase)
	}
	if r.FlowBase.Status != "DISABLED" || r.FlowBase.Error != "no flow-runner sources" {
		t.Fatalf("flow base %+v", r.FlowBase)
	}
}

func TestHealthBoxUnreachable(t *testing.T) {
	freshSandboxLog(t)
	srv := httptest.NewServer(http.NotFoundHandler())
	srv.Close()
	h := &healthCheck{
		box: &Box{URL: srv.URL, Key: "k"}, shell: &namedBase{name: "default"}, flow: &flowBase{Name: "noola-flow-runner-test"},
		nats: func() bool { return true }, runs: func() int { return 0 }, sandboxes: recentSandboxes,
	}
	code, r := getHealth(t, h)
	if code != http.StatusServiceUnavailable || r.OK || r.Box.Reachable || r.Box.Error == "" {
		t.Fatalf("health %d %+v", code, r)
	}
	if r.ShellBase.Status != "UNKNOWN" || r.FlowBase.Status != "UNKNOWN" {
		t.Fatalf("bases %+v %+v", r.ShellBase, r.FlowBase)
	}
	if s := r.summary(); !strings.Contains(s, "health: not ready · Box unreachable (") {
		t.Fatalf("summary %q", s)
	}
}
