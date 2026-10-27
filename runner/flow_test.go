package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// ── the flow's event stream ──────────────────────────────────────────────────

type relayed struct {
	subjects []string
	events   []string
	states   []string
}

func newTestRelay(r *relayed) *flowRelay {
	return &flowRelay{
		subject:   "run.r1",
		replayKey: "runs/t1/r1.webm",
		publish: func(subject string, data []byte) {
			r.subjects = append(r.subjects, subject)
			r.events = append(r.events, string(data))
		},
		saveState: func(res, nodes json.RawMessage) { r.states = append(r.states, string(res)+"|"+string(nodes)) },
	}
}

func TestFlowRelayAssemblesLinesAcrossChunks(t *testing.T) {
	var r relayed
	rl := newTestRelay(&r)
	stream := `{"type":"node-start","nodeId":"n1","kind":"goto"}` + "\n" +
		"[flow-exec] stray line, not an event\n" +
		`{"type":"state","resultJson":{"items":[{"json":{"a":1},"text":""}]},"nodeEvents":[{"nodeId":"n1"}],"error":null}` + "\n" +
		`{"nodeId":"n1"}` + "\n" + // no type: not an event
		`{"type":"node-done","nodeId":"n1","status":"ok"}` + "\n" +
		`{"type":"run-done","status":"ok"}`
	// Feed it a few bytes at a time, so every line is split somewhere.
	for i := 0; i < len(stream); i += 7 {
		end := i + 7
		if end > len(stream) {
			end = len(stream)
		}
		rl.Write([]byte(stream[i:end]))
	}
	rl.Flush() // the last event had no newline

	want := []string{
		`{"type":"node-start","nodeId":"n1","kind":"goto"}`,
		`{"type":"node-done","nodeId":"n1","status":"ok"}`,
		`{"type":"run-done","status":"ok"}`,
	}
	if strings.Join(r.events, "\n") != strings.Join(want, "\n") {
		t.Fatalf("published:\n%s", strings.Join(r.events, "\n"))
	}
	for _, s := range r.subjects {
		if s != "run.r1" {
			t.Fatalf("published to %s", s)
		}
	}
	if len(r.states) != 1 || r.states[0] != `{"items":[{"json":{"a":1},"text":""}]}|[{"nodeId":"n1"}]` {
		t.Fatalf("states = %v", r.states)
	}
}

func TestFlowRelayKeepsTheFlowsError(t *testing.T) {
	var r relayed
	rl := newTestRelay(&r)
	rl.Write([]byte(`{"type":"state","resultJson":{"items":[]},"nodeEvents":[],"error":"No Anthropic API key"}` + "\n"))
	if rl.Error != "No Anthropic API key" {
		t.Fatalf("Error = %q", rl.Error)
	}
}

func TestFlowRelayReplayOnlyForItsOwnKey(t *testing.T) {
	var r relayed
	rl := newTestRelay(&r)
	rl.Write([]byte(`{"type":"replay","key":"runs/other-tenant/r9.webm"}` + "\n"))
	if rl.ReplaySet {
		t.Fatal("a replay event naming another key set the replay")
	}
	rl.Write([]byte(`{"type":"replay","key":"runs/t1/r1.webm"}` + "\n"))
	if !rl.ReplaySet {
		t.Fatal("the run's own replay was not set")
	}
	if len(r.events) != 0 {
		t.Fatalf("replay events are the runner's, not the canvas's: %v", r.events)
	}
}

func TestFlowRelayDropsOverlongLinesAndOversizedEvents(t *testing.T) {
	var r relayed
	rl := newTestRelay(&r)
	rl.maxPub = 100
	rl.Write([]byte(`{"type":"frame","data":"` + strings.Repeat("x", 200) + `"}` + "\n"))
	rl.Write([]byte(`{"type":"ok"}` + "\n"))
	long := `{"type":"frame","data":"` + strings.Repeat("y", maxEventLine) + `"}`
	rl.Write([]byte(long[:maxEventLine/2]))
	rl.Write([]byte(long[maxEventLine/2:]))
	rl.Write([]byte("\n" + `{"type":"after"}` + "\n"))
	if strings.Join(r.events, ",") != `{"type":"ok"},{"type":"after"}` {
		t.Fatalf("published %d events: %.200v", len(r.events), r.events)
	}
}

// ── a shell run's live output ────────────────────────────────────────────────

func TestOutputEventsHoldsBackACutCharacter(t *testing.T) {
	evs, rest := outputEvents(nil, []byte("ab\xe2\x82"), 1024) // "ab" + the first 2 bytes of €
	if len(evs) != 1 || string(rest) != "\xe2\x82" {
		t.Fatalf("events %q rest %q", evs, rest)
	}
	var ev struct{ Type, Data string }
	_ = json.Unmarshal(evs[0], &ev)
	if ev.Type != "output" || ev.Data != "ab" {
		t.Fatalf("event %s", evs[0])
	}
	evs, rest = outputEvents(rest, []byte("\xac!"), 1024)
	_ = json.Unmarshal(evs[0], &ev)
	if ev.Data != "€!" || len(rest) != 0 {
		t.Fatalf("event %s rest %q", evs[0], rest)
	}
}

func TestOutputEventsSplitsOnCharacterBoundaries(t *testing.T) {
	text := strings.Repeat("žluťoučký kůň ", 50)
	evs, rest := outputEvents(nil, []byte(text), 10)
	if len(rest) != 0 {
		t.Fatalf("rest %q", rest)
	}
	var b strings.Builder
	for _, e := range evs {
		var ev struct{ Data string }
		if err := json.Unmarshal(e, &ev); err != nil {
			t.Fatal(err)
		}
		if len(ev.Data) > 10 || !utf8.ValidString(ev.Data) {
			t.Fatalf("event data %q", ev.Data)
		}
		b.WriteString(ev.Data)
	}
	if b.String() != text {
		t.Fatal("events do not add up to the output")
	}
}

func TestTailBufferKeepsTheEnd(t *testing.T) {
	tb := &tailBuffer{max: 8}
	tb.Write([]byte("0123"))
	tb.Write([]byte("456789ab"))
	if string(tb.b) != "456789ab" || !tb.cut {
		t.Fatalf("buffer %q cut %v", tb.b, tb.cut)
	}
	if !strings.HasSuffix(tb.String(), "456789ab") || !strings.HasPrefix(tb.String(), "…") {
		t.Fatalf("String %q", tb.String())
	}
}

// ── the job's env file ───────────────────────────────────────────────────────

func TestEnvFileRoundTripsThroughSh(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("no sh")
	}
	nasty := "it's $HOME `id` \"quoted\" \\ back\nslash\n\ttab ünï"
	data, err := envFile([][2]string{{"SECRET", nasty}, {"EMPTY", ""}})
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	envPath, logPath := filepath.Join(dir, "env"), filepath.Join(dir, "out.log")
	if err := os.WriteFile(envPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	script := jobScript(logPath, envPath, `exec sh -c 'printf "%s|%s|" "$SECRET" "${EMPTY-unset}"; [ -e "$0" ] && echo kept || echo removed' `+shQuote(envPath))
	if out, err := exec.Command("sh", "-c", script).CombinedOutput(); err != nil {
		t.Fatalf("sh: %v %s", err, out)
	}
	got, _ := os.ReadFile(logPath)
	if string(got) != nasty+"||removed\n" {
		t.Fatalf("job saw %q", got)
	}
}

func TestEnvFileRefusesBadNames(t *testing.T) {
	for _, bad := range []string{"", "1X", "A-B", "A B", "A=B", "X;rm"} {
		if _, err := envFile([][2]string{{bad, "v"}}); err == nil {
			t.Errorf("envFile accepted %q", bad)
		}
	}
	for _, good := range []string{"A", "_X", "GITHUB_TOKEN", "a1"} {
		if !validEnvName(good) {
			t.Errorf("validEnvName(%q) = false", good)
		}
	}
}

// ── replay upload URL ────────────────────────────────────────────────────────

func TestPresignMatchesTheAWSExample(t *testing.T) {
	// AWS's own query-string SigV4 example (s3 "Authenticating Requests: Using Query Parameters").
	u, err := presignURL("GET", "https://examplebucket.s3.amazonaws.com/test.txt", "us-east-1",
		"AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
		86400*time.Second, time.Date(2013, 5, 24, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(u, "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404") {
		t.Fatalf("url %s", u)
	}
}

func TestPresignPutIsPathStyleForOneKey(t *testing.T) {
	u, err := presignPut("https://storage-prg1.zerops.io/", "us-east-1", "bucket1", "runs/t1/r1.webm", "AK", "SK", time.Hour, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(u, "https://storage-prg1.zerops.io/bucket1/runs/t1/r1.webm?X-Amz-Algorithm=AWS4-HMAC-SHA256&") {
		t.Fatalf("url %s", u)
	}
	if strings.Contains(u, "SK") {
		t.Fatal("the secret key is in the URL")
	}
	if _, err := presignPut("not a url", "us-east-1", "b", "k", "a", "s", time.Hour, time.Now()); err == nil {
		t.Fatal("a bad endpoint was accepted")
	}
}

// ── the flow base's build context ────────────────────────────────────────────

func writeFlowDir(t *testing.T, dir, version string) string {
	t.Helper()
	files := map[string]string{
		"Dockerfile":          "FROM node:22-bookworm-slim\n",
		"exec.mts":            "console.log('" + version + "')\n",
		"package.json":        "{}\n",
		"flow-core/index.ts":  "export {}\n",
		"node_modules/x/a.js": "ignored\n",
		"exec.mjs":            "ignored bundle\n",
		"package-lock.json":   "{}\n",
	}
	for name, body := range files {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestFlowContextIsDeterministic(t *testing.T) {
	a := writeFlowDir(t, t.TempDir(), "v1")
	b := writeFlowDir(t, t.TempDir(), "v1")
	old := time.Now().Add(-48 * time.Hour)
	_ = os.Chtimes(filepath.Join(b, "exec.mts"), old, old)
	_ = os.Chmod(filepath.Join(b, "Dockerfile"), 0o600)
	tarA, hashA, err := packFlowContext(a)
	if err != nil {
		t.Fatal(err)
	}
	_, hashB, _ := packFlowContext(b)
	if hashA != hashB {
		t.Fatal("same sources, different hashes")
	}
	c := writeFlowDir(t, t.TempDir(), "v2")
	if _, hashC, _ := packFlowContext(c); hashC == hashA {
		t.Fatal("changed exec.mts, same hash")
	}

	zr, err := gzip.NewReader(bytes.NewReader(tarA))
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(zr)
	var names []string
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, h.Name)
	}
	if got := strings.Join(names, ","); got != "Dockerfile,exec.mts,flow-core/index.ts,package-lock.json,package.json" {
		t.Fatalf("context holds %s", got)
	}
	fb, _ := newFlowBase(a)
	if fb.Name != "noola-flow-runner-"+hashA[:12] {
		t.Fatalf("base name %s", fb.Name)
	}
}

func TestFlowContextNeedsTheVendoredCore(t *testing.T) {
	dir := writeFlowDir(t, t.TempDir(), "v1")
	_ = os.RemoveAll(filepath.Join(dir, "flow-core"))
	if _, _, err := packFlowContext(dir); err == nil || !strings.Contains(err.Error(), "flow-core/index.ts") {
		t.Fatalf("err = %v", err)
	}
}

// ── config ───────────────────────────────────────────────────────────────────

func TestSandboxNetworkModeIsInternetOrNothing(t *testing.T) {
	for in, want := range map[string]string{"": "INTERNET", "internet": "INTERNET", " AIRGAPPED ": "AIRGAPPED"} {
		if got, err := sandboxNetworkMode(in); err != nil || got != want {
			t.Errorf("sandboxNetworkMode(%q) = %q, %v", in, got, err)
		}
	}
	for _, bad := range []string{"PROJECT", "PROJECT_INTERNET", "host"} {
		if _, err := sandboxNetworkMode(bad); err == nil {
			t.Errorf("sandboxNetworkMode(%q) accepted", bad)
		}
	}
}

func TestHostTag(t *testing.T) {
	for in, want := range map[string]string{
		"node-id-2.runtime.runnerstage.zerops":  "runnerstage-2",
		"node-id-14.runtime.runnerpool1.zerops": "runnerpool1-14",
		"My_Laptop.local":                       "my-laptop-local",
		"":                                      "runner",
	} {
		if got := hostTag(in); got != want {
			t.Errorf("hostTag(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestEnvMiBRoundsToTheBoxStep(t *testing.T) {
	t.Setenv("X_MB", "1000")
	if got := envMiB("X_MB", 512); got != 1008<<20 {
		t.Fatalf("1000 MiB → %d MiB", got>>20)
	}
	t.Setenv("X_MB", "-4")
	if got := envMiB("X_MB", 512); got != 512<<20 {
		t.Fatalf("bad value → %d MiB", got>>20)
	}
}
