package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// ── the flow sandbox base ────────────────────────────────────────────────────
// Flow jobs need Chromium, Playwright, Stagehand and ffmpeg, which the Box's `default` base does not
// have, so they boot from a base the Box builds from runner/flow-runner/Dockerfile. The base is
// named after a hash of its build context — noola-flow-runner-<hash> — so a runner finds the base
// that matches its own flow-runner sources, and a change to them (exec.mts, the Dockerfile,
// package.json, the vendored flow-core) builds a new one. The build runs on the Box with the
// project's network, which is fine for this Dockerfile only because it is ours.

var (
	errFlowBaseBuilding = errors.New("the flow sandbox base is still building")
	// errFlowBaseFailed: the base did not build, so no flow job can run until the flow-runner
	// sources change (a runner deploy) or the runner restarts and tries again.
	errFlowBaseFailed = errors.New("the flow sandbox base failed to build")
)

type flowBase struct {
	Name    string
	context []byte // the build context, .tar.gz

	mu       sync.Mutex
	digest   string
	building bool
	failed   error // this runner's own build failed: flow jobs fail until it restarts
	rebuilt  bool  // a FAILED base of this name was already rebuilt once by this runner
}

// flowContextSkip is never part of the build context: installed deps and the local bundle.
var flowContextSkip = map[string]bool{"node_modules": true, "exec.mjs": true}

// packFlowContext packs dir into a deterministic .tar.gz (sorted paths, zeroed times and owners) and
// answers it with its content hash.
func packFlowContext(dir string) ([]byte, string, error) {
	var files []string
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
		if rel == "." {
			return nil
		}
		if flowContextSkip[d.Name()] {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type().IsRegular() {
			files = append(files, filepath.ToSlash(rel))
		}
		return nil
	})
	if err != nil {
		return nil, "", err
	}
	sort.Strings(files)
	has := map[string]bool{}
	for _, f := range files {
		has[f] = true
	}
	for _, need := range []string{"Dockerfile", "exec.mts", "package.json", "flow-core/index.ts"} {
		if !has[need] {
			return nil, "", fmt.Errorf("flow-runner context %s has no %s", dir, need)
		}
	}
	var tarBuf bytes.Buffer
	tw := tar.NewWriter(&tarBuf)
	for _, f := range files {
		data, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(f)))
		if err != nil {
			return nil, "", err
		}
		if err := tw.WriteHeader(&tar.Header{
			Name: f, Mode: 0o644, Size: int64(len(data)),
			ModTime: time.Unix(0, 0), Typeflag: tar.TypeReg, Format: tar.FormatPAX,
		}); err != nil {
			return nil, "", err
		}
		if _, err := tw.Write(data); err != nil {
			return nil, "", err
		}
	}
	if err := tw.Close(); err != nil {
		return nil, "", err
	}
	sum := sha256.Sum256(tarBuf.Bytes())
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	if _, err := zw.Write(tarBuf.Bytes()); err != nil {
		return nil, "", err
	}
	if err := zw.Close(); err != nil {
		return nil, "", err
	}
	return gz.Bytes(), hex.EncodeToString(sum[:]), nil
}

func newFlowBase(dir string) (*flowBase, error) {
	ctxTar, hash, err := packFlowContext(dir)
	if err != nil {
		return nil, err
	}
	return &flowBase{Name: "noola-flow-runner-" + hash[:12], context: ctxTar}, nil
}

// Digest answers the READY base's digest, or errFlowBaseBuilding while it builds (starting the
// build when the Box has no base of this name yet).
func (f *flowBase) Digest(ctx context.Context, box *Box) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.digest != "" {
		return f.digest, nil
	}
	if f.failed != nil {
		return "", f.failed
	}
	if f.building {
		return "", errFlowBaseBuilding
	}
	bases, err := box.Bases(ctx)
	if err != nil {
		return "", err
	}
	for _, b := range bases {
		if b.Name != f.Name {
			continue
		}
		switch b.Status {
		case "READY":
			f.digest = b.Digest
			return f.digest, nil
		case "FAILED":
			if f.rebuilt {
				return "", fmt.Errorf("%w (%s): %s", errFlowBaseFailed, f.Name, b.FailedReason)
			}
		default: // PULLING / FLATTENING: another runner's build of the same sources
			return "", errFlowBaseBuilding
		}
	}
	f.building, f.rebuilt = true, true
	go f.build(box)
	return "", errFlowBaseBuilding
}

// Forget drops a cached digest the Box no longer has (a create answered baseNotFound), so the next
// Digest looks again and builds the base anew if it is gone.
func (f *flowBase) Forget(digest string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.digest == digest {
		f.digest = ""
	}
}

func (f *flowBase) build(box *Box) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Minute)
	defer cancel()
	logf("building flow sandbox base %s on the Box (%d KiB context)", f.Name, len(f.context)/1024)
	t0 := time.Now()
	op, err := box.BuildBase(ctx, f.Name, f.context)
	if err == nil {
		_, err = box.WaitOperation(ctx, op.ID)
	}
	var digest string
	if err == nil {
		digest, err = box.BaseDigest(ctx, f.Name)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.building = false
	if err != nil {
		f.failed = fmt.Errorf("%w (%s): %v", errFlowBaseFailed, f.Name, err)
		logf("%v", f.failed)
		return
	}
	f.digest = digest
	logf("flow sandbox base %s ready in %s", f.Name, time.Since(t0).Round(time.Second))
}

// ── the flow's event stream ──────────────────────────────────────────────────
// exec.mjs, in the sandbox, writes one JSON event per line to its events file. The runner tails it
// and relays each event to the run's live channel (core NATS run.<id>, where the api relays it onto
// the canvas), except two it keeps for itself: `state` (the run's items and per-node trace, written
// to runner_runs) and `replay` (the replay's object key, once uploaded). The sandbox holds no NATS,
// database or storage credentials.

// maxEventLine bounds one event line; a longer one is dropped rather than buffered without end.
const maxEventLine = 16 << 20

type flowRelay struct {
	subject   string
	replayKey string // the only key a replay event may set
	publish   func(subject string, data []byte)
	maxPub    int // largest live event to publish (the NATS server's payload limit)
	saveState func(resultJSON, nodeEvents json.RawMessage)

	buf      []byte
	dropping bool // inside an over-long line, skipping to its end

	Error     string // the flow's own error, from its last state
	ReplaySet bool
}

func (r *flowRelay) Write(chunk []byte) {
	for len(chunk) > 0 {
		i := bytes.IndexByte(chunk, '\n')
		if i < 0 {
			if !r.dropping {
				r.buf = append(r.buf, chunk...)
				if len(r.buf) > maxEventLine {
					r.buf, r.dropping = r.buf[:0], true
				}
			}
			return
		}
		if r.dropping {
			r.dropping = false
		} else {
			r.handle(append(r.buf, chunk[:i]...))
		}
		r.buf = r.buf[:0]
		chunk = chunk[i+1:]
	}
}

// Flush handles a last event written without its newline.
func (r *flowRelay) Flush() {
	if len(r.buf) > 0 && !r.dropping {
		r.handle(r.buf)
	}
	r.buf, r.dropping = r.buf[:0], false
}

func (r *flowRelay) handle(line []byte) {
	line = bytes.TrimSpace(line)
	if len(line) == 0 {
		return
	}
	var ev struct {
		Type       string          `json:"type"`
		ResultJSON json.RawMessage `json:"resultJson"`
		NodeEvents json.RawMessage `json:"nodeEvents"`
		Error      string          `json:"error"`
		Key        string          `json:"key"`
	}
	if err := json.Unmarshal(line, &ev); err != nil || ev.Type == "" {
		return // not an event (stray output) — skip
	}
	switch ev.Type {
	case "state":
		if r.saveState != nil && len(ev.ResultJSON) > 0 && len(ev.NodeEvents) > 0 {
			r.saveState(ev.ResultJSON, ev.NodeEvents)
		}
		r.Error = ev.Error
	case "replay":
		r.ReplaySet = ev.Key != "" && ev.Key == r.replayKey
	default:
		if r.publish != nil && (r.maxPub <= 0 || len(line) <= r.maxPub) {
			r.publish(r.subject, append([]byte(nil), line...))
		}
	}
}

// ── a shell run's live output ────────────────────────────────────────────────

// outputEvents splits a chunk of a shell run's output into `output` events of at most max bytes of
// data each, holding back a UTF-8 character cut at the chunk's end (carry) for the next chunk.
func outputEvents(carry, chunk []byte, max int) (events [][]byte, rest []byte) {
	data := append(append([]byte(nil), carry...), chunk...)
	cut := len(data)
	// Back up over at most 3 bytes of an incomplete trailing character.
	for i := 1; i <= 3 && i <= len(data); i++ {
		c := data[len(data)-i]
		if c&0xC0 == 0x80 {
			continue // continuation byte
		}
		if c >= 0xC0 { // a lead byte: complete only if its sequence fits
			need := 2
			if c >= 0xF0 {
				need = 4
			} else if c >= 0xE0 {
				need = 3
			}
			if i < need {
				cut = len(data) - i
			}
		}
		break
	}
	rest = append([]byte(nil), data[cut:]...)
	data = data[:cut]
	for len(data) > 0 {
		n := len(data)
		if n > max {
			n = max
			for n > 0 && data[n]&0xC0 == 0x80 { // don't split a character
				n--
			}
			if n == 0 {
				n = max
			}
		}
		b, _ := json.Marshal(map[string]string{"type": "output", "data": string(data[:n])})
		events = append(events, b)
		data = data[n:]
	}
	return events, rest
}

// ── helpers ──────────────────────────────────────────────────────────────────

func flowReplayKey(tenantID, runID string) string { return "runs/" + tenantID + "/" + runID + ".webm" }

func trimLog(b []byte) string { return strings.TrimSpace(strings.ToValidUTF8(string(b), "�")) }
