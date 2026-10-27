//go:build live

package main

// Live checks against a real Zerops Box, run from a container that has the runner's env (its dev
// pool's lease, or the runner itself):
//
//	go test -tags live -run Live -count=1 -v ./...
//
// Each test runs real jobs through runSandboxJob and checks that its sandbox is gone afterwards.

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

func liveBox(t *testing.T) *Box {
	t.Helper()
	u, k := strings.TrimRight(os.Getenv("BOX_API_URL"), "/"), os.Getenv("BOX_API_KEY")
	if u == "" || k == "" {
		t.Skip("BOX_API_URL / BOX_API_KEY not set")
	}
	return &Box{URL: u, Key: k, HTTP: &http.Client{Timeout: 2 * time.Minute}}
}

// liveRun runs script in a fresh sandbox of the default base and answers its result and the
// streamed bytes; it fails the test if a sandbox of that name is still live afterwards.
func liveRun(t *testing.T, box *Box, network string, timeout time.Duration, files []SandboxFile, script string) (SandboxResult, string) {
	t.Helper()
	ctx := context.Background()
	digest, err := box.BaseDigest(ctx, "default")
	if err != nil {
		t.Fatalf("default base: %v", err)
	}
	name := newIdempotencyKey("noola-livetest")
	var streamed strings.Builder
	res, err := runSandboxJob(ctx, box, SandboxJob{
		Name:        name,
		BaseDigest:  digest,
		NetworkMode: network,
		CPUs:        1,
		MemoryBytes: 512 << 20,
		Files:       files,
		Script:      script,
		StreamPath:  jobDir + "/out.log",
		LogPath:     jobDir + "/out.log",
		LogTail:     64 << 10,
		Timeout:     timeout,
		Poll:        300 * time.Millisecond,
		OnChunk:     func(b []byte) { streamed.Write(b) },
	})
	if err != nil {
		t.Fatalf("job: %v", err)
	}
	live, err := box.Sandboxes(ctx, "")
	if err != nil {
		t.Fatalf("sandbox list: %v", err)
	}
	for _, s := range live {
		if s.Name == name && s.Status != "TERMINATED" {
			t.Fatalf("sandbox %s (%s) still %s after the job", s.ID, name, s.Status)
		}
	}
	return res, streamed.String()
}

func TestLiveShellJobStreamsAndTerminates(t *testing.T) {
	box := liveBox(t)
	env, err := envFile([][2]string{{"NOOLA_SECRET", "it's a secret"}})
	if err != nil {
		t.Fatal(err)
	}
	cmd := `echo "secret=$NOOLA_SECRET"; for i in 1 2 3; do echo "line $i"; sleep 1; done
test -e /tmp/noola/env && echo "env file still there" || echo "env file gone"
echo "user=$(id -un) node=$(command -v node || echo none)"
echo oops >&2; exit 3`
	files := []SandboxFile{
		{Path: jobDir + "/env", Mode: 0o600, Data: env},
		{Path: jobDir + "/cmd.sh", Mode: 0o600, Data: []byte(cmd)},
	}
	start := time.Now()
	res, streamed := liveRun(t, box, "INTERNET", 10*time.Minute, files,
		jobScript(jobDir+"/out.log", jobDir+"/env", "exec sh "+shQuote(jobDir+"/cmd.sh")))
	t.Logf("took %s, exit %d\n%s", time.Since(start).Round(time.Millisecond), res.ExitCode, streamed)
	if res.ExitCode != 3 || res.TimedOut {
		t.Fatalf("exit %d timedOut %v, want 3", res.ExitCode, res.TimedOut)
	}
	for _, want := range []string{"secret=it's a secret", "line 1", "line 3", "env file gone", "oops"} {
		if !strings.Contains(streamed, want) {
			t.Errorf("streamed output lacks %q", want)
		}
		if !strings.Contains(string(res.Log), want) {
			t.Errorf("log tail lacks %q", want)
		}
	}
}

func TestLiveTimeoutKillsTheJob(t *testing.T) {
	box := liveBox(t)
	files := []SandboxFile{{Path: jobDir + "/env", Mode: 0o600}}
	res, streamed := liveRun(t, box, "AIRGAPPED", 3*time.Second, files,
		jobScript(jobDir+"/out.log", jobDir+"/env", "echo started; sleep 60; echo never"))
	if !res.TimedOut {
		t.Fatalf("exit %d, want a timeout", res.ExitCode)
	}
	if !strings.Contains(streamed, "started") || strings.Contains(streamed, "never") {
		t.Fatalf("streamed %q", streamed)
	}
}

// An INTERNET sandbox reaches the internet and object storage's public endpoint, never a project
// service; an AIRGAPPED one reaches nothing.
func TestLiveNetworkModes(t *testing.T) {
	box := liveBox(t)
	probe := func(host string, port int) string {
		return fmt.Sprintf(`python3 - <<'PY'
import socket
host, port = %q, %d
try:
    socket.create_connection((host, port), 4).close()
    print("REACHED", host)
except Exception as e:
    print("BLOCKED", host, type(e).__name__)
PY`, host, port)
	}
	script := strings.Join([]string{probe("example.com", 443), probe("db.zerops", 5432), probe("box.zerops", 8080)}, "\n")
	files := []SandboxFile{{Path: jobDir + "/env", Mode: 0o600}}

	_, out := liveRun(t, box, "INTERNET", time.Minute, files, jobScript(jobDir+"/out.log", jobDir+"/env", script))
	t.Logf("INTERNET:\n%s", out)
	if !strings.Contains(out, "REACHED example.com") {
		t.Error("an INTERNET sandbox should reach the internet")
	}
	if !strings.Contains(out, "BLOCKED db.zerops") || !strings.Contains(out, "BLOCKED box.zerops") {
		t.Error("an INTERNET sandbox must not reach a project service")
	}

	_, out = liveRun(t, box, "AIRGAPPED", time.Minute, files, jobScript(jobDir+"/out.log", jobDir+"/env", script))
	t.Logf("AIRGAPPED:\n%s", out)
	if strings.Contains(out, "REACHED") {
		t.Error("an AIRGAPPED sandbox must reach nothing")
	}
}

// The replay path: a sandbox PUTs to a presigned URL with no storage keys of its own.
func TestLivePresignedUploadFromSandbox(t *testing.T) {
	box := liveBox(t)
	endpoint, bucket := os.Getenv("STORAGE_ENDPOINT"), os.Getenv("STORAGE_BUCKET")
	ak, sk := os.Getenv("STORAGE_ACCESS_KEY"), os.Getenv("STORAGE_SECRET_KEY")
	if endpoint == "" || bucket == "" || ak == "" || sk == "" {
		t.Skip("storage env not set")
	}
	region := envStr("STORAGE_REGION", "us-east-1")
	key := "runs/livetest/" + newIdempotencyKey("replay") + ".webm"
	put, err := presignPut(endpoint, region, bucket, key, ak, sk, 10*time.Minute, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	env, _ := envFile([][2]string{{"PUT_URL", put}})
	files := []SandboxFile{{Path: jobDir + "/env", Mode: 0o600, Data: env}}
	script := `python3 - <<'PY'
import os, urllib.request
req = urllib.request.Request(os.environ["PUT_URL"], data=b"webm-bytes", method="PUT", headers={"Content-Type": "video/webm"})
print("PUT", urllib.request.urlopen(req, timeout=20).status)
PY`
	_, out := liveRun(t, box, "INTERNET", time.Minute, files, jobScript(jobDir+"/out.log", jobDir+"/env", script))
	t.Logf("sandbox: %s", strings.TrimSpace(out))
	if !strings.Contains(out, "PUT 200") {
		t.Fatalf("upload from the sandbox failed")
	}

	base := strings.TrimRight(endpoint, "/") + "/" + bucket + "/" + key
	get, _ := presignURL("GET", base, region, ak, sk, time.Minute, time.Now())
	resp, err := http.Get(get)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("object not there: GET %d", resp.StatusCode)
	}
	del, _ := presignURL("DELETE", base, region, ak, sk, time.Minute, time.Now())
	req, _ := http.NewRequest("DELETE", del, nil)
	if resp, err := http.DefaultClient.Do(req); err == nil {
		resp.Body.Close()
	}
}
