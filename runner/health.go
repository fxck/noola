package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// The runner's health, GET /health on RUNNER_HEALTH_PORT (8080): what the Box answers now — is it
// reachable, are the shell and flow bases READY — whether NATS is connected, and how the Box lists
// the last sandboxes this runner created. 200 when the runner can run both kinds of job, 503
// otherwise, the report as JSON either way. The same summary is logged whenever it changes, so the
// runtime log tells it too. Zerops does not act on it (it is no healthCheck): a base the Box takes
// minutes to pull or build would only get the runner restarted.

// baseHealth is one base by name. Status is the Box's (READY, PULLING, FLATTENING, FAILED), or the
// runner's own: PULLING or BUILDING for one it has started that the Box does not list yet, MISSING
// for none at all, UNKNOWN while the Box is unreachable, DISABLED for flow jobs without their sources.
type baseHealth struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Digest string `json:"digest,omitempty"`
	Error  string `json:"error,omitempty"`
}

type boxHealth struct {
	URL       string `json:"url"`
	Reachable bool   `json:"reachable"`
	Error     string `json:"error,omitempty"`
}

// sandboxHealth is one of this runner's recent sandboxes; Status is the Box's (TERMINATED once its
// job is over).
type sandboxHealth struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Run    string `json:"run"`
	Status string `json:"status,omitempty"`
	Error  string `json:"error,omitempty"`
}

type healthReport struct {
	OK            bool            `json:"ok"`
	Box           boxHealth       `json:"box"`
	ShellBase     baseHealth      `json:"shellBase"`
	FlowBase      baseHealth      `json:"flowBase"`
	NATSConnected bool            `json:"natsConnected"`
	DBConnected   bool            `json:"dbConnected"` // false: jobs run, but the app never sees their results
	Runs          int             `json:"runs"`        // jobs running now
	MaxRuns       int             `json:"maxRuns"`
	Sandboxes     []sandboxHealth `json:"sandboxes"` // newest first
}

// summary is the report as one log line.
func (r healthReport) summary() string {
	state, boxState, nats := "not ready", "Box reachable", "NATS connected"
	if r.OK {
		state = "ok"
	}
	if !r.Box.Reachable {
		boxState = "Box unreachable (" + r.Box.Error + ")"
	}
	if !r.NATSConnected {
		nats = "NATS disconnected"
	}
	return fmt.Sprintf("health: %s · %s · shell base %s · flow base %s · %s",
		state, boxState, r.ShellBase.summary(), r.FlowBase.summary(), nats)
}

func (b baseHealth) summary() string {
	s := b.Name + " " + b.Status
	if b.Digest != "" {
		s += " (" + firstN(b.Digest, 19) + ")"
	}
	if b.Error != "" {
		s += ": " + b.Error
	}
	return s
}

type healthCheck struct {
	box       *Box
	shell     *namedBase
	flow      *flowBase // nil: flow jobs disabled, for flowErr
	flowErr   error
	nats      func() bool
	db        bool
	runs      func() int
	maxRuns   int
	sandboxes *sandboxLog
}

func (h *healthCheck) report(ctx context.Context, withSandboxes bool) healthReport {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	r := healthReport{Box: boxHealth{URL: h.box.URL}, NATSConnected: h.nats(), DBConnected: h.db, Runs: h.runs(), MaxRuns: h.maxRuns}
	bases, err := h.box.Bases(ctx)
	if err != nil {
		r.Box.Error = err.Error()
	} else {
		r.Box.Reachable = true
	}

	pulling, pullErr := h.shell.state()
	r.ShellBase = listedBase(bases, r.Box.Reachable, h.shell.name, pulling, "PULLING", pullErr)
	if h.flow == nil {
		r.FlowBase = baseHealth{Status: "DISABLED", Error: fmt.Sprint(h.flowErr)}
	} else {
		building, buildErr := h.flow.state()
		r.FlowBase = listedBase(bases, r.Box.Reachable, h.flow.Name, building, "BUILDING", buildErr)
	}
	r.OK = r.Box.Reachable && r.ShellBase.Status == "READY" && r.FlowBase.Status == "READY" && r.NATSConnected

	r.Sandboxes = []sandboxHealth{}
	if withSandboxes {
		for _, ref := range h.sandboxes.list() {
			s := sandboxHealth{ID: ref.ID, Name: ref.Name, Run: ref.Run}
			if sb, err := h.box.Sandbox(ctx, ref.ID); err != nil {
				s.Error = err.Error()
			} else {
				s.Status = sb.Status
			}
			r.Sandboxes = append(r.Sandboxes, s)
		}
	}
	return r
}

// listedBase is the base named name as the Box lists it, with the runner's own pull or build of it
// (busy, as busyStatus) and why its last one failed.
func listedBase(bases []BoxBase, reachable bool, name string, busy bool, busyStatus string, err error) baseHealth {
	h := baseHealth{Name: name, Status: "MISSING"}
	if !reachable {
		h.Status = "UNKNOWN"
	}
	for _, b := range bases {
		if b.Name == name && h.Status != "READY" {
			h.Status, h.Digest, h.Error = b.Status, b.Digest, b.FailedReason
		}
	}
	if busy && h.Status == "MISSING" {
		h.Status = busyStatus
	}
	if h.Status != "READY" && h.Error == "" && err != nil {
		h.Error = err.Error()
	}
	return h
}

func (h *healthCheck) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	r := h.report(req.Context(), true)
	w.Header().Set("Content-Type", "application/json")
	if !r.OK {
		w.WriteHeader(http.StatusServiceUnavailable)
	}
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(r)
}

// watch logs the summary at once and again whenever it changes.
func (h *healthCheck) watch(ctx context.Context, every time.Duration) {
	last := ""
	for {
		s := h.report(ctx, false).summary()
		if ctx.Err() != nil {
			return
		}
		if s != last {
			logf("%s", s)
			last = s
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(every):
		}
	}
}

// ── the runner's recent sandboxes ────────────────────────────────────────────

type sandboxRef struct{ ID, Name, Run string }

// sandboxLog keeps the last few sandboxes this runner created, newest first.
type sandboxLog struct {
	mu    sync.Mutex
	items []sandboxRef
}

const recentSandboxCount = 5

var recentSandboxes = &sandboxLog{}

func (l *sandboxLog) add(ref sandboxRef) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.items = append([]sandboxRef{ref}, l.items...)
	if len(l.items) > recentSandboxCount {
		l.items = l.items[:recentSandboxCount]
	}
}

func (l *sandboxLog) list() []sandboxRef {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]sandboxRef(nil), l.items...)
}
