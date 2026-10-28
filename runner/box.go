package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Client for the Zerops Box workspace API (http://<box>:8080/api/rest/…). Every job runs in its
// own Box sandbox — a microVM with its own kernel — instead of a container on the runner's host:
// the runner creates the sandbox, starts the job in it, tails its output, and terminates it.
// Only the calls the runner needs are here; the full surface is the Box's own OpenAPI document
// at /api/rest/swagger/openapi.yml.

type Box struct {
	URL  string // e.g. http://box:8080, no trailing slash
	Key  string // the workspace API key (bearer)
	HTTP *http.Client
}

// BoxError is the API's {"error":{"code","message","meta"}} answer with its HTTP status.
type BoxError struct {
	Status  int
	Code    string
	Message string
	Meta    map[string]any
}

func (e *BoxError) Error() string {
	return fmt.Sprintf("box %d %s: %s", e.Status, e.Code, e.Message)
}

// isWorkspaceFull reports the Box refusing a create because its sandboxes already hold its CPU or
// memory (409 workspaceFull) — a capacity wait, not a failure of the job.
func isWorkspaceFull(err error) bool {
	var be *BoxError
	return errors.As(err, &be) && be.Code == "workspaceFull"
}

// isBaseNotFound reports a create naming a base the Box no longer has (pulled or built again under
// a new digest): the cached digest is stale.
func isBaseNotFound(err error) bool {
	var be *BoxError
	return errors.As(err, &be) && be.Code == "baseNotFound"
}

type BoxOperation struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Status    string `json:"status"` // PENDING | RUNNING | FINISHED | FAILED
	Error     string `json:"error"`
	SandboxID string `json:"sandboxId"`
}

type BoxBase struct {
	Name         string `json:"name"`
	Digest       string `json:"digest"`
	Status       string `json:"status"` // PULLING | FLATTENING | READY | FAILED
	FailedReason string `json:"failedReason"`
}

type BoxSandbox struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
}

type CreateSandbox struct {
	BaseDigest         string   `json:"baseDigest"`
	NetworkMode        string   `json:"networkMode"`
	Integrations       []string `json:"integrations"`
	Name               string   `json:"name,omitempty"`
	CPUs               int      `json:"cpus,omitempty"`
	MemoryBytes        int64    `json:"memoryBytes,omitempty"`
	IdleTTLSeconds     int      `json:"idleTtlSeconds,omitempty"`
	AbsoluteTTLSeconds int      `json:"absoluteTtlSeconds,omitempty"`
	WaitSeconds        int      `json:"waitSeconds,omitempty"`
}

type ExecRequest struct {
	Command        []string          `json:"command"`
	Env            map[string]string `json:"env,omitempty"`
	TimeoutSeconds int               `json:"timeoutSeconds,omitempty"`
	WorkingDir     string            `json:"workingDir,omitempty"`
}

type ExecResult struct {
	SessionID       string `json:"sessionId"`
	ExitCode        *int   `json:"exitCode"`
	Stdout          string `json:"stdout"`
	Stderr          string `json:"stderr"`
	StdoutTruncated bool   `json:"stdoutTruncated"`
	StderrTruncated bool   `json:"stderrTruncated"`
	TimedOut        bool   `json:"timedOut"`
}

// BoxSession is a background process started in a sandbox: OPEN while it runs, CLOSED once it
// exited (ExitCode set), FAILED when it could not run.
type BoxSession struct {
	ID       string `json:"id"`
	Status   string `json:"status"`
	ExitCode *int   `json:"exitCode"`
}

func newIdempotencyKey(prefix string) string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return prefix + "-" + hex.EncodeToString(b)
}

func (b *Box) client() *http.Client {
	if b.HTTP != nil {
		return b.HTTP
	}
	return http.DefaultClient
}

// do sends one API call. body is JSON-encoded unless it is an io.Reader (sent as octet-stream);
// out, when non-nil, receives the decoded JSON answer.
func (b *Box) do(ctx context.Context, method, path string, q url.Values, idemKey string, body, out any) error {
	u := b.URL + "/api/rest" + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	var rd io.Reader
	ctype := ""
	switch v := body.(type) {
	case nil:
	case io.Reader:
		rd, ctype = v, "application/octet-stream"
	default:
		buf, err := json.Marshal(v)
		if err != nil {
			return err
		}
		rd, ctype = bytes.NewReader(buf), "application/json"
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+b.Key)
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	if idemKey != "" {
		req.Header.Set("Idempotency-Key", idemKey)
	}
	res, err := b.client().Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return err
	}
	if res.StatusCode >= 300 {
		var env struct {
			Error struct {
				Code    string         `json:"code"`
				Message string         `json:"message"`
				Meta    map[string]any `json:"meta"`
			} `json:"error"`
		}
		_ = json.Unmarshal(raw, &env)
		be := &BoxError{Status: res.StatusCode, Code: env.Error.Code, Message: env.Error.Message, Meta: env.Error.Meta}
		if be.Code == "" {
			be.Code = http.StatusText(res.StatusCode)
			be.Message = firstN(strings.TrimSpace(string(raw)), 300)
		}
		return be
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return fmt.Errorf("box %s %s: decode answer: %w", method, path, err)
		}
	}
	return nil
}

func (b *Box) Bases(ctx context.Context) ([]BoxBase, error) {
	var res struct {
		Items []BoxBase `json:"items"`
	}
	if err := b.do(ctx, http.MethodGet, "/base-list", nil, "", nil, &res); err != nil {
		return nil, err
	}
	return res.Items, nil
}

// BaseDigest answers the digest of the READY base holding name. Read at startup rather than kept in
// code: a base pulled or built again under the same name gets a new digest.
func (b *Box) BaseDigest(ctx context.Context, name string) (string, error) {
	bases, err := b.Bases(ctx)
	if err != nil {
		return "", err
	}
	for _, bs := range bases {
		if bs.Name == name && bs.Status == "READY" {
			return bs.Digest, nil
		}
	}
	return "", fmt.Errorf("box has no READY base named %q", name)
}

// PullBase starts a pull of imageRef (an image tarball URL or a registry reference) into a base
// that takes name, moved from any base that held it; the answer is the PULL_BASE operation to wait on.
func (b *Box) PullBase(ctx context.Context, imageRef, name string) (BoxOperation, error) {
	var op BoxOperation
	body := map[string]string{"imageRef": imageRef, "name": name}
	err := b.do(ctx, http.MethodPost, "/base", nil, newIdempotencyKey("pull-"+name), body, &op)
	return op, err
}

// BuildBase starts a Dockerfile build of a base from a .tar.gz build context (Dockerfile at its
// root) under name; the answer is the BUILD_BASE operation to wait on.
func (b *Box) BuildBase(ctx context.Context, name string, contextTarGz []byte) (BoxOperation, error) {
	var op BoxOperation
	err := b.do(ctx, http.MethodPost, "/base-build", url.Values{"name": {name}}, "", bytes.NewReader(contextTarGz), &op)
	return op, err
}

// WaitOperation long-polls an operation until it is FINISHED or FAILED (FAILED is an error).
func (b *Box) WaitOperation(ctx context.Context, id string) (BoxOperation, error) {
	for {
		var op BoxOperation
		if err := b.do(ctx, http.MethodGet, "/operation/"+url.PathEscape(id), url.Values{"waitSeconds": {"30"}}, "", nil, &op); err != nil {
			return op, err
		}
		switch op.Status {
		case "FINISHED":
			return op, nil
		case "FAILED":
			return op, fmt.Errorf("box operation %s %s failed: %s", op.Kind, op.ID, op.Error)
		}
		if err := ctx.Err(); err != nil {
			return op, err
		}
	}
}

// CreateSandbox creates one sandbox and waits until it runs.
func (b *Box) CreateSandbox(ctx context.Context, req CreateSandbox, idemKey string) (string, error) {
	if req.Integrations == nil {
		req.Integrations = []string{}
	}
	if req.WaitSeconds == 0 {
		req.WaitSeconds = 30
	}
	var res struct {
		Operation BoxOperation `json:"operation"`
		Sandboxes []BoxSandbox `json:"sandboxes"`
	}
	if err := b.do(ctx, http.MethodPost, "/sandbox", nil, idemKey, req, &res); err != nil {
		return "", err
	}
	id := ""
	if len(res.Sandboxes) > 0 {
		id = res.Sandboxes[0].ID
	}
	if id == "" {
		id = res.Operation.SandboxID
	}
	if id == "" {
		return "", fmt.Errorf("box create answered no sandbox (operation %s %s)", res.Operation.ID, res.Operation.Status)
	}
	if res.Operation.Status != "FINISHED" {
		if _, err := b.WaitOperation(ctx, res.Operation.ID); err != nil {
			return id, err
		}
	}
	return id, nil
}

func (b *Box) Exec(ctx context.Context, sandboxID string, req ExecRequest) (ExecResult, error) {
	var res ExecResult
	err := b.do(ctx, http.MethodPost, "/sandbox/"+url.PathEscape(sandboxID)+"/exec", nil, "", req, &res)
	return res, err
}

// StartProcess starts a background process in the sandbox and answers its session at once.
func (b *Box) StartProcess(ctx context.Context, sandboxID string, req ExecRequest) (BoxSession, error) {
	var s BoxSession
	err := b.do(ctx, http.MethodPost, "/sandbox/"+url.PathEscape(sandboxID)+"/process", nil, "", req, &s)
	return s, err
}

func (b *Box) Session(ctx context.Context, sessionID string) (BoxSession, error) {
	var s BoxSession
	err := b.do(ctx, http.MethodGet, "/session/"+url.PathEscape(sessionID), nil, "", nil, &s)
	return s, err
}

// PutFile writes data to an absolute path in the sandbox with the given octal mode (e.g. 0600).
func (b *Box) PutFile(ctx context.Context, sandboxID, path string, mode int, data []byte) error {
	q := url.Values{"path": {path}, "mode": {"0" + strconv.FormatInt(int64(mode), 8)}}
	return b.do(ctx, http.MethodPut, "/sandbox/"+url.PathEscape(sandboxID)+"/file", q, "", bytes.NewReader(data), nil)
}

// Terminate ends a sandbox and waits for its TERMINATE operation. Every sandbox the runner creates
// is terminated by it: the Box does not enforce idle or absolute TTLs yet, so a forgotten sandbox
// keeps running and keeps its share of the Box.
func (b *Box) Terminate(ctx context.Context, sandboxID string) error {
	var op BoxOperation
	if err := b.do(ctx, http.MethodDelete, "/sandbox/"+url.PathEscape(sandboxID), nil, "terminate-"+sandboxID, nil, &op); err != nil {
		var be *BoxError
		if errors.As(err, &be) && be.Status == http.StatusNotFound {
			return nil // already gone
		}
		return err
	}
	if op.ID == "" || op.Status == "FINISHED" {
		return nil
	}
	_, err := b.WaitOperation(ctx, op.ID)
	return err
}

// Sandboxes lists the workspace's sandboxes in one status (RUNNING, PARKED, …), newest first.
func (b *Box) Sandboxes(ctx context.Context, status string) ([]BoxSandbox, error) {
	q := url.Values{"limit": {"100"}}
	if status != "" {
		q.Set("status", status)
	}
	var res struct {
		Items []BoxSandbox `json:"items"`
	}
	if err := b.do(ctx, http.MethodGet, "/sandbox-list", q, "", nil, &res); err != nil {
		return nil, err
	}
	return res.Items, nil
}

// terminateDetached terminates a sandbox on a context of its own, so a job whose context already
// ended (timeout, shutdown) still frees its sandbox.
func (b *Box) terminateDetached(sandboxID string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	return b.Terminate(ctx, sandboxID)
}
