package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// One job = one Box sandbox: create it, write the job's files into it, start the job as a
// background process, tail the file it writes while it runs, read its exit code, terminate it.
// Nothing of one job reaches the next, and the sandbox reads none of the runner's own env: it gets
// only the files written for it here.

// jobDir holds a job's files inside its sandbox.
const jobDir = "/tmp/noola"

// streamChunk is the most a single poll reads of the streamed file (base64 in the exec answer,
// whose stdout is capped at 4 MiB).
const streamChunk = 1 << 20

type SandboxFile struct {
	Path string
	Mode int
	Data []byte
}

type SandboxJob struct {
	RunID       string // the run it is for, in the log and in /health
	Name        string // sandbox name: noola-<runner host>-<run id>, so a restarted runner finds its orphans
	BaseDigest  string
	NetworkMode string
	CPUs        int
	MemoryBytes int64
	Files       []SandboxFile
	// Script is the job's process, run as `sh -c Script`; it redirects its own output to files.
	Script string
	// StreamPath is tailed while the process runs; every new byte goes to OnChunk, in order.
	StreamPath string
	// LogPath's last LogTail bytes are read once the process ended (the run's recorded output).
	LogPath string
	LogTail int
	Timeout time.Duration
	Poll    time.Duration
	OnChunk func([]byte)
	// OnStarted runs once the job's process runs in the sandbox; OnTick on every poll after that.
	OnStarted func()
	OnTick    func()
}

type SandboxResult struct {
	ExitCode int
	TimedOut bool
	Log      []byte
}

// startError is a failure before the job's own code ran (create, files, process start): the job
// can run again elsewhere without repeating any of its effects. A workspaceFull create is one.
type startError struct{ err error }

func (e *startError) Error() string { return e.err.Error() }
func (e *startError) Unwrap() error { return e.err }

func isStartError(err error) bool {
	var se *startError
	return errors.As(err, &se)
}

func runSandboxJob(ctx context.Context, box *Box, job SandboxJob) (res SandboxResult, err error) {
	if job.Poll <= 0 {
		job.Poll = 500 * time.Millisecond
	}
	if job.Timeout <= 0 {
		job.Timeout = 10 * time.Minute
	}
	id, err := box.CreateSandbox(ctx, CreateSandbox{
		BaseDigest:  job.BaseDigest,
		NetworkMode: job.NetworkMode,
		Name:        job.Name,
		CPUs:        job.CPUs,
		MemoryBytes: job.MemoryBytes,
		// Not enforced by the Box yet — the terminate below is what frees the sandbox — but set, so
		// a runner killed mid-job does not leave its sandbox running forever once they are.
		IdleTTLSeconds:     int(job.Timeout.Seconds()) + 300,
		AbsoluteTTLSeconds: int(job.Timeout.Seconds()) + 300,
	}, newIdempotencyKey("noola-create"))
	if id != "" {
		recentSandboxes.add(sandboxRef{ID: id, Name: job.Name, Run: job.RunID})
		logf("sandbox %s created for run %s", id, job.RunID)
		defer func() {
			if terr := box.terminateDetached(id); terr != nil {
				logf("sandbox %s terminate failed: %v", id, terr)
			} else {
				logf("sandbox %s terminated", id)
			}
		}()
	}
	if err != nil {
		return res, &startError{fmt.Errorf("create sandbox: %w", err)}
	}

	if _, err := box.Exec(ctx, id, ExecRequest{Command: []string{"mkdir", "-p", "-m", "0700", jobDir}, TimeoutSeconds: 30}); err != nil {
		return res, &startError{fmt.Errorf("prepare sandbox: %w", err)}
	}
	for _, f := range job.Files {
		if err := box.PutFile(ctx, id, f.Path, f.Mode, f.Data); err != nil {
			return res, &startError{fmt.Errorf("write %s: %w", f.Path, err)}
		}
	}
	sess, err := box.StartProcess(ctx, id, ExecRequest{
		Command:        []string{"sh", "-c", job.Script},
		TimeoutSeconds: int(job.Timeout.Seconds()),
	})
	if err != nil {
		return res, &startError{fmt.Errorf("start job process: %w", err)}
	}
	if job.OnStarted != nil {
		job.OnStarted()
	}

	// From here on the job's code runs: a failure is the run's, never retried.
	runCtx, cancel := context.WithTimeout(ctx, job.Timeout+15*time.Second)
	defer cancel()
	var offset int64
	failures := 0
	for {
		s, serr := box.Session(runCtx, sess.ID)
		ended := serr == nil && s.Status != "OPEN"
		for job.StreamPath != "" {
			chunk, rerr := readFrom(runCtx, box, id, job.StreamPath, offset, streamChunk)
			if rerr != nil {
				serr = errors.Join(serr, rerr)
				break
			}
			if len(chunk) > 0 {
				offset += int64(len(chunk))
				if job.OnChunk != nil {
					job.OnChunk(chunk)
				}
			}
			if len(chunk) < streamChunk {
				break
			}
		}
		if ended {
			switch {
			case s.ExitCode != nil:
				res.ExitCode = *s.ExitCode
			case s.Status == "FAILED":
				return res, fmt.Errorf("job process failed in sandbox %s", id)
			default: // killed by its timeout
				res.ExitCode, res.TimedOut = -1, true
			}
			break
		}
		if runCtx.Err() != nil {
			if ctx.Err() != nil {
				return res, ctx.Err() // runner shutting down
			}
			res.ExitCode, res.TimedOut = -1, true
			break
		}
		if serr != nil {
			if failures++; failures >= 20 {
				return res, fmt.Errorf("lost the job's sandbox %s: %w", id, serr)
			}
		} else {
			failures = 0
		}
		if job.OnTick != nil {
			job.OnTick()
		}
		select {
		case <-runCtx.Done():
		case <-time.After(job.Poll):
		}
	}

	if job.LogPath != "" && job.LogTail > 0 {
		logCtx, cancelLog := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancelLog()
		if b, lerr := readTail(logCtx, box, id, job.LogPath, job.LogTail); lerr == nil {
			res.Log = b
		} else {
			logf("sandbox %s: read %s: %v", id, job.LogPath, lerr)
		}
	}
	return res, nil
}

// readFrom answers up to max bytes of path from offset on. The bytes travel base64-encoded, so a
// chunk cut inside a UTF-8 character (or binary output) arrives exactly as written.
func readFrom(ctx context.Context, box *Box, id, path string, offset int64, max int) ([]byte, error) {
	cmd := fmt.Sprintf("tail -c +%d %s 2>/dev/null | head -c %d | base64 -w0", offset+1, shQuote(path), max)
	return execBase64(ctx, box, id, cmd)
}

func readTail(ctx context.Context, box *Box, id, path string, n int) ([]byte, error) {
	cmd := fmt.Sprintf("tail -c %d %s 2>/dev/null | base64 -w0", n, shQuote(path))
	return execBase64(ctx, box, id, cmd)
}

func execBase64(ctx context.Context, box *Box, id, cmd string) ([]byte, error) {
	r, err := box.Exec(ctx, id, ExecRequest{Command: []string{"sh", "-c", cmd}, TimeoutSeconds: 30})
	if err != nil {
		return nil, err
	}
	if r.ExitCode == nil || *r.ExitCode != 0 {
		return nil, fmt.Errorf("read in sandbox exited %v: %s", r.ExitCode, firstN(r.Stderr, 200))
	}
	return base64.StdEncoding.DecodeString(strings.TrimSpace(r.Stdout))
}

// ── the job's env file ───────────────────────────────────────────────────────
// Secrets (a tenant's credentials, its Anthropic key) reach the job through a 0600 file in its own
// sandbox that the job's shell sources and deletes before the job's code starts — never through
// the exec request's env, which the Box keeps in its session records.

var envNameRE = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func validEnvName(name string) bool { return envNameRE.MatchString(name) }

// shQuote quotes s for sh as one word.
func shQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// envFile renders vars as a file `set -a; . file` exports: one NAME='value' per name, in order.
func envFile(vars [][2]string) ([]byte, error) {
	var b strings.Builder
	for _, kv := range vars {
		if !validEnvName(kv[0]) {
			return nil, fmt.Errorf("invalid env name %q", kv[0])
		}
		b.WriteString(kv[0] + "=" + shQuote(kv[1]) + "\n")
	}
	return []byte(b.String()), nil
}

// jobScript is the process every job runs: output to the log, the env file sourced and removed,
// then the job itself in place of the shell.
func jobScript(logPath, envPath, run string) string {
	return strings.Join([]string{
		"exec >" + shQuote(logPath) + " 2>&1",
		"set -a",
		". " + shQuote(envPath),
		"set +a",
		"rm -f " + shQuote(envPath),
		run,
	}, "\n")
}
