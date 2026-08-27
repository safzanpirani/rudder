package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestControlSocketLocationIsPrivateAndLengthSafe(t *testing.T) {
	stateDir, err := os.MkdirTemp("/tmp", "rr-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(stateDir) })
	path, privateDir, err := controlSocketLocation(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if privateDir != "" {
		t.Fatalf("short state directory unexpectedly used fallback %q", privateDir)
	}
	if filepath.Dir(path) != stateDir {
		t.Fatalf("socket path %q is outside state directory %q", path, stateDir)
	}

	longStateDir := filepath.Join(stateDir, strings.Repeat("long-segment-", 12))
	path, privateDir, err = controlSocketLocation(longStateDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(privateDir) })
	if privateDir == "" || filepath.Dir(path) != privateDir {
		t.Fatalf("long path did not use a private fallback: path=%q dir=%q", path, privateDir)
	}
	if len([]byte(path)) > maxControlSocketPathBytes {
		t.Fatalf("fallback socket path is too long: %d bytes", len([]byte(path)))
	}
	info, err := os.Stat(privateDir)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o700 {
		t.Fatalf("fallback directory mode = %o, want 700", info.Mode().Perm())
	}
}

func TestControlCleanupDoesNotRemoveUnownedSocketPath(t *testing.T) {
	dir := t.TempDir()
	socketPath := filepath.Join(dir, ".rudder.sock")
	if err := os.WriteFile(socketPath, []byte("not a socket"), 0o600); err != nil {
		t.Fatal(err)
	}
	r := &controller{store: &stateStore{state: runState{SocketPath: socketPath}}}
	r.closeControlServer()
	if _, err := os.Stat(socketPath); err != nil {
		t.Fatalf("cleanup removed unowned socket path: %v", err)
	}
}

func TestStateDoesNotPersistPromptText(t *testing.T) {
	dir := t.TempDir()
	promptPath := filepath.Join(dir, "prompt.md")
	if err := os.WriteFile(promptPath, []byte("TOP SECRET PROMPT"), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := newStateStore(runConfig{
		CWD:        dir,
		PromptFile: promptPath,
		StateDir:   filepath.Join(dir, "run"),
		Model:      "test-model",
		Sandbox:    "read-only",
	})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(store.path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "TOP SECRET PROMPT") {
		t.Fatal("state file persisted prompt text")
	}
	info, err := os.Stat(store.path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("state mode = %o, want 600", info.Mode().Perm())
	}
}

func TestLogOpenFailurePersistsTerminalState(t *testing.T) {
	dir := t.TempDir()
	promptPath := filepath.Join(dir, "prompt.md")
	stateDir := filepath.Join(dir, "run")
	if err := os.WriteFile(promptPath, []byte("task"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(stateDir, "events.jsonl"), 0o700); err != nil {
		t.Fatal(err)
	}
	err := runController(runConfig{
		CWD:            dir,
		PromptFile:     promptPath,
		StateDir:       stateDir,
		Model:          "test-model",
		Sandbox:        "read-only",
		ApprovalPolicy: "never",
		ChildCommand:   []string{"unused"},
	})
	if err == nil {
		t.Fatal("run unexpectedly succeeded")
	}
	state, readErr := readState(stateDir)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if state.Status != "failed" || state.CompletedAt.IsZero() {
		t.Fatalf("log-open failure left non-terminal state: %#v", state)
	}
}

func TestOneLineAndFlattenStrings(t *testing.T) {
	got := oneLine("hello\n  world", 20)
	if got != "hello world" {
		t.Fatalf("oneLine = %q", got)
	}
	longMessage := strings.Repeat("complete message ", 40)
	if got := singleLine(longMessage); got != strings.TrimSpace(longMessage) {
		t.Fatalf("singleLine truncated agent output: %q", got)
	}
	got = flattenStrings([]any{map[string]any{"text": "first"}, "second"})
	if got != "first second" {
		t.Fatalf("flattenStrings = %q", got)
	}
}

func TestRPCIDAcceptsStringAndIntegerIDs(t *testing.T) {
	for _, test := range []struct {
		name string
		raw  string
		want string
		ok   bool
	}{
		{name: "string", raw: `"rudder-1"`, want: "rudder-1", ok: true},
		{name: "integer", raw: `42`, want: "42", ok: true},
		{name: "negative integer", raw: `-7`, want: "-7", ok: true},
		{name: "empty string", raw: `""`},
		{name: "float", raw: `1.5`},
		{name: "null", raw: `null`},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, ok := rpcID(json.RawMessage(test.raw))
			if ok != test.ok || got != test.want {
				t.Fatalf("rpcID(%s) = %q, %v; want %q, %v", test.raw, got, ok, test.want, test.ok)
			}
		})
	}
}

func TestTailLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "trace.log")
	if err := os.WriteFile(path, []byte("one\ntwo\nthree\nfour\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	lines, err := tailLines(path, 2)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(lines, ",") != "three,four" {
		t.Fatalf("tail = %#v", lines)
	}
}

func TestLiveSteerOverControlSocket(t *testing.T) {
	if os.Getenv("GO_WANT_RUDDER_HELPER") == "1" {
		runHelperAppServer()
		os.Exit(0)
	}
	dir := t.TempDir()
	promptPath := filepath.Join(dir, "prompt.md")
	stateDir := filepath.Join(dir, "run")
	if err := os.WriteFile(promptPath, []byte("Initially say ORIGINAL"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO_WANT_RUDDER_HELPER", "1")
	errCh := make(chan error, 1)
	go func() {
		errCh <- runController(runConfig{
			CWD:            dir,
			PromptFile:     promptPath,
			StateDir:       stateDir,
			Model:          "test-model",
			Sandbox:        "read-only",
			ApprovalPolicy: "never",
			ChildCommand:   []string{os.Args[0], "-test.run=TestLiveSteerOverControlSocket"},
		})
	}()

	deadline := time.Now().Add(3 * time.Second)
	for {
		state, err := readState(stateDir)
		if err == nil && state.Status == "active" && state.TurnID != "" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("fake turn did not become active")
		}
		time.Sleep(10 * time.Millisecond)
	}
	activeState, err := readState(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	socketInfo, err := os.Stat(activeState.SocketPath)
	if err != nil {
		t.Fatal(err)
	}
	if socketInfo.Mode().Perm() != 0o600 {
		t.Fatalf("socket mode = %o, want 600", socketInfo.Mode().Perm())
	}
	parentInfo, err := os.Stat(filepath.Dir(activeState.SocketPath))
	if err != nil {
		t.Fatal(err)
	}
	if parentInfo.Mode().Perm() != 0o700 {
		t.Fatalf("socket parent mode = %o, want 700", parentInfo.Mode().Perm())
	}
	response, err := sendControl(stateDir, controlRequest{Command: "steer", Text: "Say STEERED"}, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if !response.OK {
		t.Fatalf("steer failed: %s", response.Error)
	}
	if err := <-errCh; err != nil {
		t.Fatal(err)
	}
	output, err := os.ReadFile(filepath.Join(stateDir, "output.md"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(output)) != "STEERED" {
		t.Fatalf("output = %q, want STEERED", output)
	}
	state, err := readState(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if state.Steers != 1 || state.Status != "completed" {
		t.Fatalf("unexpected final state: %#v", state)
	}
}

func TestInterruptPreservesInterruptedStatus(t *testing.T) {
	if os.Getenv("GO_WANT_RUDDER_HELPER") == "1" {
		runHelperAppServer()
		os.Exit(0)
	}
	dir := t.TempDir()
	promptPath := filepath.Join(dir, "prompt.md")
	stateDir := filepath.Join(dir, "run")
	if err := os.WriteFile(promptPath, []byte("stay active"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO_WANT_RUDDER_HELPER", "1")
	errCh := make(chan error, 1)
	go func() {
		errCh <- runController(runConfig{
			CWD:            dir,
			PromptFile:     promptPath,
			StateDir:       stateDir,
			Model:          "test-model",
			Sandbox:        "read-only",
			ApprovalPolicy: "never",
			ChildCommand:   []string{os.Args[0], "-test.run=TestInterruptPreservesInterruptedStatus"},
		})
	}()
	waitForRunStatus(t, stateDir, "active")
	response, err := sendControl(stateDir, controlRequest{Command: "interrupt"}, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if !response.OK {
		t.Fatalf("interrupt failed: %s", response.Error)
	}
	if err := <-errCh; err == nil || !strings.Contains(err.Error(), "interrupted") {
		t.Fatalf("unexpected interrupted run result: %v", err)
	}
	state, err := readState(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != "interrupted" {
		t.Fatalf("status = %q, want interrupted", state.Status)
	}
}

func TestInterruptAcknowledgementForcesLocalTeardown(t *testing.T) {
	if os.Getenv("GO_WANT_RUDDER_HELPER") == "1" {
		runHelperAppServer()
		os.Exit(0)
	}
	dir := t.TempDir()
	promptPath := filepath.Join(dir, "prompt.md")
	stateDir := filepath.Join(dir, "run")
	if err := os.WriteFile(promptPath, []byte("stay active"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO_WANT_RUDDER_HELPER", "1")
	t.Setenv("GO_WANT_RUDDER_INTERRUPT_ACK_ONLY", "1")
	grandchildPIDFile := filepath.Join(dir, "grandchild.pid")
	if runtime.GOOS != "windows" {
		t.Setenv("GO_WANT_RUDDER_GRANDCHILD_PID_FILE", grandchildPIDFile)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errCh := make(chan error, 1)
	go func() {
		errCh <- runControllerContext(ctx, runConfig{
			CWD:            dir,
			PromptFile:     promptPath,
			StateDir:       stateDir,
			Model:          "test-model",
			Sandbox:        "read-only",
			ApprovalPolicy: "never",
			ChildCommand:   []string{os.Args[0], "-test.run=TestInterruptAcknowledgementForcesLocalTeardown"},
		})
	}()

	activeState := waitForRunStatus(t, stateDir, "active")
	grandchildPID := 0
	if runtime.GOOS != "windows" {
		rawPID, err := os.ReadFile(grandchildPIDFile)
		if err != nil {
			t.Fatal(err)
		}
		grandchildPID, err = strconv.Atoi(strings.TrimSpace(string(rawPID)))
		if err != nil {
			t.Fatal(err)
		}
	}
	response, err := sendControl(stateDir, controlRequest{Command: "interrupt"}, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if !response.OK {
		t.Fatalf("interrupt failed: %s", response.Error)
	}
	select {
	case err := <-errCh:
		if err == nil || !strings.Contains(err.Error(), "interrupted") {
			t.Fatalf("unexpected interrupted run result: %v", err)
		}
	case <-time.After(2 * time.Second):
		cancel()
		<-errCh
		t.Fatal("acknowledged interrupt did not stop the local controller")
	}
	finalState, err := readState(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if finalState.Status != "interrupted" {
		t.Fatalf("status = %q, want interrupted", finalState.Status)
	}
	if processAlive(activeState.ChildPID) {
		t.Fatalf("child pid %d is still alive", activeState.ChildPID)
	}
	if grandchildPID != 0 {
		deadline := time.Now().Add(2 * time.Second)
		for processAlive(grandchildPID) && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
		}
		if processAlive(grandchildPID) {
			t.Fatalf("grandchild pid %d is still alive", grandchildPID)
		}
	}
	if _, err := os.Lstat(activeState.SocketPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket still exists or cannot be checked: %v", err)
	}
}

func TestResumeAndForkThreadBeforeTurn(t *testing.T) {
	if os.Getenv("GO_WANT_RUDDER_HELPER") == "1" {
		runHelperAppServer()
		os.Exit(0)
	}
	for _, test := range []struct {
		name       string
		resumeID   string
		forkID     string
		wantThread string
	}{
		{name: "resume", resumeID: "source-thread", wantThread: "thread-resumed"},
		{name: "fork", forkID: "source-thread", wantThread: "thread-forked"},
	} {
		t.Run(test.name, func(t *testing.T) {
			dir := t.TempDir()
			promptPath := filepath.Join(dir, "prompt.md")
			stateDir := filepath.Join(dir, "run")
			if err := os.WriteFile(promptPath, []byte("continue the task"), 0o600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("GO_WANT_RUDDER_HELPER", "1")
			t.Setenv("GO_WANT_RUDDER_COMPLETE_ON_START", "1")
			err := runController(runConfig{
				CWD:            dir,
				PromptFile:     promptPath,
				StateDir:       stateDir,
				Model:          "test-model",
				Sandbox:        "read-only",
				ApprovalPolicy: "never",
				ResumeThreadID: test.resumeID,
				ForkThreadID:   test.forkID,
				ChildCommand:   []string{os.Args[0], "-test.run=TestResumeAndForkThreadBeforeTurn"},
			})
			if err != nil {
				t.Fatal(err)
			}
			state, err := readState(stateDir)
			if err != nil {
				t.Fatal(err)
			}
			if state.ThreadID != test.wantThread || state.Status != "completed" {
				t.Fatalf("unexpected final state: %#v", state)
			}
		})
	}
}

func TestForkBoundarySelectorsReachAppServer(t *testing.T) {
	if os.Getenv("GO_WANT_RUDDER_HELPER") == "1" {
		runHelperAppServer()
		os.Exit(0)
	}
	for _, test := range []struct {
		name      string
		beforeID  string
		throughID string
		expectEnv string
	}{
		{name: "before-turn-excludes-boundary", beforeID: "turn-old", expectEnv: "GO_WANT_RUDDER_EXPECT_FORK_BEFORE"},
		{name: "through-turn-includes-boundary", throughID: "turn-new", expectEnv: "GO_WANT_RUDDER_EXPECT_FORK_THROUGH"},
	} {
		t.Run(test.name, func(t *testing.T) {
			dir := t.TempDir()
			promptPath := filepath.Join(dir, "prompt.md")
			stateDir := filepath.Join(dir, "run")
			if err := os.WriteFile(promptPath, []byte("alternate approach"), 0o600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("GO_WANT_RUDDER_HELPER", "1")
			t.Setenv("GO_WANT_RUDDER_COMPLETE_ON_START", "1")
			want := test.beforeID + test.throughID
			t.Setenv(test.expectEnv, want)
			err := runController(runConfig{
				CWD:               dir,
				PromptFile:        promptPath,
				StateDir:          stateDir,
				Model:             "test-model",
				Sandbox:           "read-only",
				ApprovalPolicy:    "never",
				ForkThreadID:      "source-thread",
				ForkBeforeTurnID:  test.beforeID,
				ForkThroughTurnID: test.throughID,
				ChildCommand:      []string{os.Args[0], "-test.run=TestForkBoundarySelectorsReachAppServer"},
			})
			if err != nil {
				t.Fatal(err)
			}
			state, err := readState(stateDir)
			if err != nil {
				t.Fatal(err)
			}
			if state.ThreadID != "thread-forked" || state.ThreadID == "source-thread" {
				t.Fatalf("fork did not produce a new thread: %#v", state)
			}
		})
	}
}

func TestForkInvalidTurnFailsRun(t *testing.T) {
	if os.Getenv("GO_WANT_RUDDER_HELPER") == "1" {
		runHelperAppServer()
		os.Exit(0)
	}
	dir := t.TempDir()
	promptPath := filepath.Join(dir, "prompt.md")
	stateDir := filepath.Join(dir, "run")
	if err := os.WriteFile(promptPath, []byte("alternate approach"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO_WANT_RUDDER_HELPER", "1")
	err := runController(runConfig{
		CWD:              dir,
		PromptFile:       promptPath,
		StateDir:         stateDir,
		Model:            "test-model",
		Sandbox:          "read-only",
		ApprovalPolicy:   "never",
		ForkThreadID:     "source-thread",
		ForkBeforeTurnID: "turn-missing",
		ChildCommand:     []string{os.Args[0], "-test.run=TestForkInvalidTurnFailsRun"},
	})
	if err == nil || !strings.Contains(err.Error(), "unknown turn") {
		t.Fatalf("invalid fork turn did not fail the run: %v", err)
	}
	state, readErr := readState(stateDir)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if state.Status != "failed" || state.ThreadID != "" {
		t.Fatalf("invalid fork left bad state: %#v", state)
	}
}

func TestResumeSendsCleanParams(t *testing.T) {
	if os.Getenv("GO_WANT_RUDDER_HELPER") == "1" {
		runHelperAppServer()
		os.Exit(0)
	}
	dir := t.TempDir()
	promptPath := filepath.Join(dir, "prompt.md")
	stateDir := filepath.Join(dir, "run")
	if err := os.WriteFile(promptPath, []byte("continue"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO_WANT_RUDDER_HELPER", "1")
	t.Setenv("GO_WANT_RUDDER_COMPLETE_ON_START", "1")
	t.Setenv("GO_WANT_RUDDER_EXPECT_RESUME_PARAMS", "1")
	err := runController(runConfig{
		CWD:            dir,
		PromptFile:     promptPath,
		StateDir:       stateDir,
		Model:          "test-model",
		Sandbox:        "read-only",
		ApprovalPolicy: "never",
		Ephemeral:      true,
		ResumeThreadID: "source-thread",
		ChildCommand:   []string{os.Args[0], "-test.run=TestResumeSendsCleanParams"},
	})
	if err != nil {
		t.Fatal(err)
	}
	state, readErr := readState(stateDir)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if state.ThreadID != "thread-resumed" {
		t.Fatalf("resume did not continue the source thread: %#v", state)
	}
}

func TestValidateRunConfigRejectsForkSelectorMisuse(t *testing.T) {
	base := runConfig{
		CWD:          os.TempDir(),
		Model:        "test-model",
		Sandbox:      "read-only",
		ChildCommand: []string{"codex"},
	}
	both := base
	both.ForkThreadID = "source-thread"
	both.ForkBeforeTurnID = "turn-a"
	both.ForkThroughTurnID = "turn-b"
	if err := validateRunConfig(&both); err == nil || !strings.Contains(err.Error(), "mutually exclusive") {
		t.Fatalf("expected selector mutual-exclusion error, got %v", err)
	}
	orphan := base
	orphan.ForkBeforeTurnID = "turn-a"
	if err := validateRunConfig(&orphan); err == nil || !strings.Contains(err.Error(), "require --fork-thread") {
		t.Fatalf("expected orphan selector error, got %v", err)
	}
	resumeSelector := base
	resumeSelector.ResumeThreadID = "source-thread"
	resumeSelector.ForkThroughTurnID = "turn-b"
	if err := validateRunConfig(&resumeSelector); err == nil {
		t.Fatal("fork selector with --resume-thread was accepted")
	}
}

func TestWaitTimeoutParsesGoDurations(t *testing.T) {
	stateDir := t.TempDir()
	state := runState{Version: 1, PID: os.Getpid(), Status: "completed", StateDir: stateDir}
	raw, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := writePrivateFile(filepath.Join(stateDir, stateFileName), raw); err != nil {
		t.Fatal(err)
	}
	if err := waitCommand([]string{"--state-dir", stateDir, "--timeout", "3600s"}); err != nil {
		t.Fatalf("duration timeout rejected: %v", err)
	}
	err = waitCommand([]string{"--state-dir", stateDir, "--timeout", "3600"})
	if err == nil || !strings.Contains(err.Error(), "parse") {
		t.Fatalf("bare integer timeout should fail duration parsing, got %v", err)
	}
}

func TestThreadListRPC(t *testing.T) {
	if os.Getenv("GO_WANT_RUDDER_HELPER") == "1" {
		runHelperAppServer()
		os.Exit(0)
	}
	t.Setenv("GO_WANT_RUDDER_HELPER", "1")
	raw, err := invokeAppServer(t.TempDir(), []string{os.Args[0], "-test.run=TestThreadListRPC"}, "thread/list", map[string]any{"limit": 2})
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
		NextCursor string `json:"nextCursor"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Data) != 1 || result.Data[0].ID != "thread-listed" || result.NextCursor != "next-page" {
		t.Fatalf("unexpected list result: %#v", result)
	}
}

func TestThreadSubcommands(t *testing.T) {
	if os.Getenv("GO_WANT_RUDDER_HELPER") == "1" {
		runHelperAppServer()
		os.Exit(0)
	}
	t.Setenv("GO_WANT_RUDDER_HELPER", "1")
	child := []string{"--", os.Args[0], "-test.run=TestThreadSubcommands"}
	tests := []struct {
		name string
		args []string
	}{
		{name: "list", args: append([]string{"list", "--limit", "1"}, child...)},
		{name: "search", args: append([]string{"search", "needle"}, child...)},
		{name: "read", args: append([]string{"read", "--include-turns", "source-thread"}, child...)},
		{name: "turns", args: append([]string{"turns", "--limit", "1", "source-thread"}, child...)},
		{name: "fork", args: append([]string{"fork", "--before-turn", "turn-old", "source-thread"}, child...)},
		{name: "name", args: append([]string{"name", "source-thread", "New", "Name"}, child...)},
		{name: "archive", args: append([]string{"archive", "source-thread"}, child...)},
		{name: "unarchive", args: append([]string{"unarchive", "source-thread"}, child...)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			output, err := captureStdout(func() error { return threadCommand(test.args) })
			if err != nil {
				t.Fatal(err)
			}
			if !json.Valid(output) {
				t.Fatalf("thread command returned invalid JSON: %q", output)
			}
		})
	}
}

func captureStdout(fn func() error) ([]byte, error) {
	reader, writer, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	original := os.Stdout
	os.Stdout = writer
	runErr := fn()
	_ = writer.Close()
	os.Stdout = original
	output, readErr := io.ReadAll(reader)
	_ = reader.Close()
	if runErr != nil {
		return output, runErr
	}
	return output, readErr
}

func TestValidateRunConfigRejectsConflictingThreadModes(t *testing.T) {
	cfg := runConfig{
		CWD:            t.TempDir(),
		Model:          "test-model",
		Sandbox:        "read-only",
		ResumeThreadID: "resume",
		ForkThreadID:   "fork",
		ChildCommand:   []string{"codex"},
	}
	if err := validateRunConfig(&cfg); err == nil || !strings.Contains(err.Error(), "mutually exclusive") {
		t.Fatalf("expected mutually exclusive error, got %v", err)
	}
}

func TestEphemeralRunPassesThreadOption(t *testing.T) {
	if os.Getenv("GO_WANT_RUDDER_HELPER") == "1" {
		runHelperAppServer()
		os.Exit(0)
	}
	dir := t.TempDir()
	promptPath := filepath.Join(dir, "prompt.md")
	if err := os.WriteFile(promptPath, []byte("ephemeral task"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO_WANT_RUDDER_HELPER", "1")
	t.Setenv("GO_WANT_RUDDER_EXPECT_EPHEMERAL", "1")
	t.Setenv("GO_WANT_RUDDER_COMPLETE_ON_START", "1")
	err := runController(runConfig{
		CWD:            dir,
		PromptFile:     promptPath,
		StateDir:       filepath.Join(dir, "run"),
		Model:          "test-model",
		Sandbox:        "read-only",
		ApprovalPolicy: "never",
		Ephemeral:      true,
		ChildCommand:   []string{os.Args[0], "-test.run=TestEphemeralRunPassesThreadOption"},
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestWaitMissingStateFailsImmediately(t *testing.T) {
	started := time.Now()
	err := waitCommand([]string{"--state-dir", filepath.Join(t.TempDir(), "missing")})
	if err == nil {
		t.Fatal("wait unexpectedly succeeded")
	}
	if time.Since(started) > time.Second {
		t.Fatalf("wait did not fail promptly: %v", time.Since(started))
	}
	if !strings.Contains(err.Error(), stateFileName) {
		t.Fatalf("wait error %q does not identify the missing state file", err)
	}
}

func TestControlRequestRejectsStaleActiveState(t *testing.T) {
	stateDir := t.TempDir()
	state := runState{
		Version:    1,
		PID:        99999999,
		Status:     "active",
		ThreadID:   "thread-stale",
		TurnID:     "turn-stale",
		StateDir:   stateDir,
		SocketPath: filepath.Join(stateDir, "missing.sock"),
	}
	raw, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := writePrivateFile(filepath.Join(stateDir, stateFileName), raw); err != nil {
		t.Fatal(err)
	}
	_, err = sendControl(stateDir, controlRequest{Command: "steer", Text: "new direction"}, time.Second)
	if err == nil || !strings.Contains(err.Error(), "is not running") {
		t.Fatalf("expected stale-process error, got %v", err)
	}
}

func TestDisplayedStateMarksDeadControllerStale(t *testing.T) {
	state := displayedState(runState{PID: 99999999, Status: "active", Error: ""})
	if state.Status != "stale" || !strings.Contains(state.Error, "not running") {
		t.Fatalf("dead controller was not marked stale: %#v", state)
	}
	completed := displayedState(runState{PID: 99999999, Status: "completed"})
	if completed.Status != "completed" {
		t.Fatalf("terminal state changed: %#v", completed)
	}
}

func TestCanceledRunCleansUpChildSocketAndState(t *testing.T) {
	if os.Getenv("GO_WANT_RUDDER_HELPER") == "1" {
		runHelperAppServer()
		os.Exit(0)
	}
	dir := t.TempDir()
	promptPath := filepath.Join(dir, "prompt.md")
	stateDir := filepath.Join(dir, "run")
	if err := os.WriteFile(promptPath, []byte("stay active"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO_WANT_RUDDER_HELPER", "1")
	grandchildPIDFile := filepath.Join(dir, "grandchild.pid")
	if runtime.GOOS != "windows" {
		t.Setenv("GO_WANT_RUDDER_GRANDCHILD_PID_FILE", grandchildPIDFile)
	}
	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		errCh <- runControllerContext(ctx, runConfig{
			CWD:            dir,
			PromptFile:     promptPath,
			StateDir:       stateDir,
			Model:          "test-model",
			Sandbox:        "read-only",
			ApprovalPolicy: "never",
			ChildCommand:   []string{os.Args[0], "-test.run=TestCanceledRunCleansUpChildSocketAndState"},
		})
	}()

	state := waitForRunStatus(t, stateDir, "active")
	grandchildPID := 0
	if runtime.GOOS != "windows" {
		rawPID, err := os.ReadFile(grandchildPIDFile)
		if err != nil {
			t.Fatal(err)
		}
		grandchildPID, err = strconv.Atoi(strings.TrimSpace(string(rawPID)))
		if err != nil {
			t.Fatal(err)
		}
	}
	cancel()
	select {
	case err := <-errCh:
		if err == nil || !strings.Contains(err.Error(), "interrupted") {
			t.Fatalf("unexpected cancellation result: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("canceled run did not exit")
	}
	finalState, err := readState(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if finalState.Status != "interrupted" {
		t.Fatalf("status = %q, want interrupted", finalState.Status)
	}
	if processAlive(state.ChildPID) {
		t.Fatalf("child pid %d is still alive", state.ChildPID)
	}
	if grandchildPID != 0 {
		deadline := time.Now().Add(2 * time.Second)
		for processAlive(grandchildPID) && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
		}
		if processAlive(grandchildPID) {
			t.Fatalf("grandchild pid %d is still alive", grandchildPID)
		}
	}
	if _, err := os.Lstat(state.SocketPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket still exists or cannot be checked: %v", err)
	}
	if state.SocketDir != "" {
		if _, err := os.Stat(state.SocketDir); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("fallback socket directory still exists: %v", err)
		}
	}
}

func TestTurnWatchdogStopsHungRun(t *testing.T) {
	if os.Getenv("GO_WANT_RUDDER_HELPER") == "1" {
		runHelperAppServer()
		os.Exit(0)
	}
	dir := t.TempDir()
	promptPath := filepath.Join(dir, "prompt.md")
	stateDir := filepath.Join(dir, "run")
	if err := os.WriteFile(promptPath, []byte("stay active"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO_WANT_RUDDER_HELPER", "1")
	err := runController(runConfig{
		CWD:            dir,
		PromptFile:     promptPath,
		StateDir:       stateDir,
		Model:          "test-model",
		Sandbox:        "read-only",
		ApprovalPolicy: "never",
		TurnTimeout:    50 * time.Millisecond,
		ChildCommand:   []string{os.Args[0], "-test.run=TestTurnWatchdogStopsHungRun"},
	})
	if err == nil || !strings.Contains(err.Error(), "watchdog") {
		t.Fatalf("unexpected watchdog result: %v", err)
	}
	state, readErr := readState(stateDir)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if state.Status != "failed" || processAlive(state.ChildPID) {
		t.Fatalf("watchdog left bad state: %#v", state)
	}
}

type blockingWriteCloser struct {
	closed chan struct{}
	once   sync.Once
}

func (w *blockingWriteCloser) Write([]byte) (int, error) {
	<-w.closed
	return 0, os.ErrClosed
}

func (w *blockingWriteCloser) Close() error {
	w.once.Do(func() { close(w.closed) })
	return nil
}

func TestRPCCallBoundsBlockedStdinWrite(t *testing.T) {
	writer := &blockingWriteCloser{closed: make(chan struct{})}
	r := &controller{
		childIn: writer,
		pending: make(map[string]chan rpcEnvelope),
		done:    make(chan struct{}),
	}
	errCh := make(chan error, 1)
	go func() {
		errCh <- r.call("thread/list", map[string]any{}, nil, 50*time.Millisecond)
	}()
	select {
	case err := <-errCh:
		if err == nil || !strings.Contains(err.Error(), "write timed out") {
			t.Fatalf("unexpected blocked-write result: %v", err)
		}
	case <-time.After(500 * time.Millisecond):
		_ = writer.Close()
		<-errCh
		t.Fatal("blocked stdin write ignored the RPC timeout")
	}
}

type temporaryAcceptError struct{}

func (temporaryAcceptError) Error() string   { return "temporary accept failure" }
func (temporaryAcceptError) Timeout() bool   { return false }
func (temporaryAcceptError) Temporary() bool { return true }

type sequenceListener struct {
	conn  net.Conn
	calls int
}

func (l *sequenceListener) Accept() (net.Conn, error) {
	l.calls++
	switch l.calls {
	case 1:
		return nil, temporaryAcceptError{}
	case 2:
		return l.conn, nil
	default:
		return nil, net.ErrClosed
	}
}

func (l *sequenceListener) Close() error   { return nil }
func (l *sequenceListener) Addr() net.Addr { return &net.UnixAddr{Name: "test", Net: "unix"} }

func TestControlAcceptRetriesTemporaryFailure(t *testing.T) {
	server, client := net.Pipe()
	defer client.Close()
	r := &controller{
		listener: &sequenceListener{conn: server},
		store:    &stateStore{state: runState{Status: "active"}},
		done:     make(chan struct{}),
	}
	go r.acceptControl()
	_ = client.SetDeadline(time.Now().Add(time.Second))
	if err := json.NewEncoder(client).Encode(controlRequest{Command: "status"}); err != nil {
		t.Fatal(err)
	}
	var response controlResponse
	if err := json.NewDecoder(client).Decode(&response); err != nil {
		t.Fatalf("control socket did not recover after temporary accept failure: %v", err)
	}
	if !response.OK {
		t.Fatalf("unexpected control response: %#v", response)
	}
}

func TestRunPreservesAgentMessagesAndRedactsPersistedError(t *testing.T) {
	if os.Getenv("GO_WANT_RUDDER_HELPER") == "1" {
		runHelperAppServer()
		os.Exit(0)
	}
	dir := t.TempDir()
	promptPath := filepath.Join(dir, "prompt.md")
	stateDir := filepath.Join(dir, "run")
	if err := os.WriteFile(promptPath, []byte("sensitive user prompt"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO_WANT_RUDDER_HELPER", "1")
	t.Setenv("GO_WANT_RUDDER_MULTI_OUTPUT_ERROR", "1")
	err := runController(runConfig{
		CWD:            dir,
		PromptFile:     promptPath,
		StateDir:       stateDir,
		Model:          "test-model",
		Sandbox:        "read-only",
		ApprovalPolicy: "never",
		ChildCommand:   []string{os.Args[0], "-test.run=TestRunPreservesAgentMessagesAndRedactsPersistedError"},
	})
	if err == nil {
		t.Fatal("failed helper turn unexpectedly succeeded")
	}
	output, readErr := os.ReadFile(filepath.Join(stateDir, "output.md"))
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(output) != "FIRST\n\nSECOND\n" {
		t.Fatalf("output = %q, want both agent messages", output)
	}
	stateRaw, readErr := os.ReadFile(filepath.Join(stateDir, stateFileName))
	if readErr != nil {
		t.Fatal(readErr)
	}
	if bytes.Contains(stateRaw, []byte("SECRET_ECHO")) {
		t.Fatalf("state persisted app-server content: %s", stateRaw)
	}
	state, readErr := readState(stateDir)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if state.Error == "" || !strings.Contains(state.Error, "see trace.log") {
		t.Fatalf("state error is not a useful redacted diagnostic: %q", state.Error)
	}
}

func TestChildCommandTraceDoesNotPersistArguments(t *testing.T) {
	if os.Getenv("GO_WANT_RUDDER_HELPER") == "1" {
		runHelperAppServer()
		os.Exit(0)
	}
	dir := t.TempDir()
	promptPath := filepath.Join(dir, "prompt.md")
	stateDir := filepath.Join(dir, "run")
	if err := os.WriteFile(promptPath, []byte("complete"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO_WANT_RUDDER_HELPER", "1")
	t.Setenv("GO_WANT_RUDDER_COMPLETE_ON_START", "1")
	const secretArgument = "TOP-SECRET-BEARER-TOKEN"
	err := runController(runConfig{
		CWD:            dir,
		PromptFile:     promptPath,
		StateDir:       stateDir,
		Model:          "test-model",
		Sandbox:        "read-only",
		ApprovalPolicy: "never",
		ChildCommand:   []string{os.Args[0], "-test.run=TestChildCommandTraceDoesNotPersistArguments", secretArgument},
	})
	if err != nil {
		t.Fatal(err)
	}
	trace, err := os.ReadFile(filepath.Join(stateDir, "trace.log"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(trace, []byte(secretArgument)) {
		t.Fatalf("trace persisted child argument: %s", trace)
	}
	if !bytes.Contains(trace, []byte("[start] child pid=")) {
		t.Fatalf("trace omitted child startup marker: %s", trace)
	}
}

func TestRunDoesNotReportSuccessWhenStatePersistenceFails(t *testing.T) {
	if os.Getenv("GO_WANT_RUDDER_HELPER") == "1" {
		runHelperAppServer()
		os.Exit(0)
	}
	dir := t.TempDir()
	promptPath := filepath.Join(dir, "prompt.md")
	stateDir := filepath.Join(dir, "run")
	if err := os.WriteFile(promptPath, []byte("stay active"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO_WANT_RUDDER_HELPER", "1")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errCh := make(chan error, 1)
	go func() {
		errCh <- runControllerContext(ctx, runConfig{
			CWD:            dir,
			PromptFile:     promptPath,
			StateDir:       stateDir,
			Model:          "test-model",
			Sandbox:        "read-only",
			ApprovalPolicy: "never",
			ChildCommand:   []string{os.Args[0], "-test.run=TestRunDoesNotReportSuccessWhenStatePersistenceFails"},
		})
	}()

	waitForRunStatus(t, stateDir, "active")
	createBlockingDirectory(t, filepath.Join(stateDir, stateFileName+".tmp"))
	_, _ = sendControl(stateDir, controlRequest{Command: "steer", Text: "finish now"}, time.Second)
	select {
	case err := <-errCh:
		if err == nil || !strings.Contains(err.Error(), "persist") {
			t.Fatalf("run result = %v, want persistence failure", err)
		}
	case <-time.After(2 * time.Second):
		cancel()
		<-errCh
		t.Fatal("run did not stop after state persistence failed")
	}
	persisted, err := readState(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.Status != "active" {
		t.Fatalf("partially persisted status = %q, want prior durable active state", persisted.Status)
	}
}

func TestRunFailsWhenAgentOutputCannotBePersisted(t *testing.T) {
	if os.Getenv("GO_WANT_RUDDER_HELPER") == "1" {
		runHelperAppServer()
		os.Exit(0)
	}
	dir := t.TempDir()
	promptPath := filepath.Join(dir, "prompt.md")
	stateDir := filepath.Join(dir, "run")
	if err := os.WriteFile(promptPath, []byte("stay active"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GO_WANT_RUDDER_HELPER", "1")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errCh := make(chan error, 1)
	go func() {
		errCh <- runControllerContext(ctx, runConfig{
			CWD:            dir,
			PromptFile:     promptPath,
			StateDir:       stateDir,
			Model:          "test-model",
			Sandbox:        "read-only",
			ApprovalPolicy: "never",
			ChildCommand:   []string{os.Args[0], "-test.run=TestRunFailsWhenAgentOutputCannotBePersisted"},
		})
	}()

	waitForRunStatus(t, stateDir, "active")
	if err := os.Mkdir(filepath.Join(stateDir, "output.md.tmp"), 0o700); err != nil {
		t.Fatal(err)
	}
	_, _ = sendControl(stateDir, controlRequest{Command: "steer", Text: "finish now"}, time.Second)
	select {
	case err := <-errCh:
		if err == nil || !strings.Contains(err.Error(), "persist agent output") {
			t.Fatalf("run result = %v, want output persistence failure", err)
		}
	case <-time.After(2 * time.Second):
		cancel()
		<-errCh
		t.Fatal("run did not stop after output persistence failed")
	}
	state, err := readState(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != "failed" {
		t.Fatalf("status = %q, want failed", state.Status)
	}
	if _, err := os.Stat(filepath.Join(stateDir, "output.md")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("output.md unexpectedly exists or cannot be checked: %v", err)
	}
}

func createBlockingDirectory(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		err := os.Mkdir(path, 0o700)
		if err == nil {
			return
		}
		if !errors.Is(err, os.ErrExist) {
			t.Fatal(err)
		}
		info, statErr := os.Stat(path)
		if statErr == nil && info.IsDir() {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("atomic state writer did not release %s", path)
		}
		time.Sleep(time.Millisecond)
	}
}

func waitForRunStatus(t *testing.T, stateDir, want string) runState {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		state, err := readState(stateDir)
		if err == nil && state.Status == want {
			return state
		}
		if time.Now().After(deadline) {
			t.Fatalf("run did not reach %s", want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func runHelperAppServer() {
	if pidFile := os.Getenv("GO_WANT_RUDDER_GRANDCHILD_PID_FILE"); pidFile != "" {
		child := exec.Command("sleep", "60")
		if err := child.Start(); err == nil {
			_ = os.WriteFile(pidFile, []byte(strconv.Itoa(child.Process.Pid)), 0o600)
		}
	}
	scanner := bufio.NewScanner(os.Stdin)
	enc := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		var request struct {
			ID     string         `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
			continue
		}
		switch request.Method {
		case "initialize":
			_ = enc.Encode(map[string]any{"id": request.ID, "result": map[string]any{"userAgent": "fake", "codexHome": "/tmp", "platformFamily": "unix", "platformOs": "test"}})
		case "thread/start":
			if os.Getenv("GO_WANT_RUDDER_EXPECT_EPHEMERAL") == "1" && request.Params["ephemeral"] != true {
				_ = enc.Encode(map[string]any{"id": request.ID, "error": map[string]any{"code": -32602, "message": "ephemeral option missing"}})
				continue
			}
			_ = enc.Encode(map[string]any{"id": request.ID, "result": map[string]any{"thread": map[string]any{"id": "thread-test"}}})
		case "thread/resume":
			if request.Params["threadId"] != "source-thread" {
				_ = enc.Encode(map[string]any{"id": request.ID, "error": map[string]any{"code": -32602, "message": "wrong source thread"}})
				continue
			}
			if os.Getenv("GO_WANT_RUDDER_EXPECT_RESUME_PARAMS") == "1" {
				if request.Params["excludeTurns"] != true {
					_ = enc.Encode(map[string]any{"id": request.ID, "error": map[string]any{"code": -32602, "message": "resume missing excludeTurns"}})
					continue
				}
				if _, has := request.Params["ephemeral"]; has {
					_ = enc.Encode(map[string]any{"id": request.ID, "error": map[string]any{"code": -32602, "message": "resume must not send ephemeral"}})
					continue
				}
				if _, has := request.Params["serviceName"]; has {
					_ = enc.Encode(map[string]any{"id": request.ID, "error": map[string]any{"code": -32602, "message": "resume must not send serviceName"}})
					continue
				}
			}
			_ = enc.Encode(map[string]any{"id": request.ID, "result": map[string]any{"thread": map[string]any{"id": "thread-resumed"}}})
		case "thread/fork":
			if request.Params["threadId"] != "source-thread" {
				_ = enc.Encode(map[string]any{"id": request.ID, "error": map[string]any{"code": -32602, "message": "wrong source thread"}})
				continue
			}
			if request.Params["beforeTurnId"] == "turn-missing" || request.Params["lastTurnId"] == "turn-missing" {
				_ = enc.Encode(map[string]any{"id": request.ID, "error": map[string]any{"code": -32602, "message": "unknown turn turn-missing"}})
				continue
			}
			if want := os.Getenv("GO_WANT_RUDDER_EXPECT_FORK_BEFORE"); want != "" {
				if request.Params["beforeTurnId"] != want {
					_ = enc.Encode(map[string]any{"id": request.ID, "error": map[string]any{"code": -32602, "message": "beforeTurnId mismatch"}})
					continue
				}
				if _, has := request.Params["lastTurnId"]; has {
					_ = enc.Encode(map[string]any{"id": request.ID, "error": map[string]any{"code": -32602, "message": "beforeTurnId fork must not send lastTurnId"}})
					continue
				}
			}
			if want := os.Getenv("GO_WANT_RUDDER_EXPECT_FORK_THROUGH"); want != "" {
				if request.Params["lastTurnId"] != want {
					_ = enc.Encode(map[string]any{"id": request.ID, "error": map[string]any{"code": -32602, "message": "lastTurnId mismatch"}})
					continue
				}
				if _, has := request.Params["beforeTurnId"]; has {
					_ = enc.Encode(map[string]any{"id": request.ID, "error": map[string]any{"code": -32602, "message": "lastTurnId fork must not send beforeTurnId"}})
					continue
				}
			}
			_ = enc.Encode(map[string]any{"id": request.ID, "result": map[string]any{"thread": map[string]any{"id": "thread-forked"}}})
		case "thread/list":
			_ = enc.Encode(map[string]any{"id": request.ID, "result": map[string]any{
				"data":       []map[string]any{{"id": "thread-listed"}},
				"nextCursor": "next-page",
			}})
		case "thread/search":
			_ = enc.Encode(map[string]any{"id": request.ID, "result": map[string]any{"data": []map[string]any{{"thread": map[string]any{"id": "thread-found"}, "snippet": "needle"}}}})
		case "thread/read":
			_ = enc.Encode(map[string]any{"id": request.ID, "result": map[string]any{"thread": map[string]any{"id": request.Params["threadId"]}}})
		case "thread/turns/list":
			_ = enc.Encode(map[string]any{"id": request.ID, "result": map[string]any{"data": []map[string]any{{"id": "turn-listed"}}}})
		case "thread/name/set", "thread/archive":
			_ = enc.Encode(map[string]any{"id": request.ID, "result": map[string]any{}})
		case "thread/unarchive":
			_ = enc.Encode(map[string]any{"id": request.ID, "result": map[string]any{"thread": map[string]any{"id": request.Params["threadId"]}}})
		case "turn/start":
			_ = enc.Encode(map[string]any{"id": request.ID, "result": map[string]any{"turn": map[string]any{"id": "turn-test", "status": "inProgress"}}})
			_ = enc.Encode(map[string]any{"method": "turn/started", "params": map[string]any{"turn": map[string]any{"id": "turn-test", "status": "inProgress"}}})
			if os.Getenv("GO_WANT_RUDDER_MULTI_OUTPUT_ERROR") == "1" {
				_ = enc.Encode(map[string]any{"method": "item/completed", "params": map[string]any{"item": map[string]any{"id": "message-first", "type": "agentMessage", "text": "FIRST"}}})
				_ = enc.Encode(map[string]any{"method": "item/completed", "params": map[string]any{"item": map[string]any{"id": "message-second", "type": "agentMessage", "text": "SECOND"}}})
				_ = enc.Encode(map[string]any{"method": "turn/completed", "params": map[string]any{"turn": map[string]any{"id": "turn-test", "status": "failed", "error": map[string]any{"code": 99, "message": "SECRET_ECHO from prompt"}}}})
				continue
			}
			if os.Getenv("GO_WANT_RUDDER_COMPLETE_ON_START") == "1" {
				_ = enc.Encode(map[string]any{"method": "item/completed", "params": map[string]any{"item": map[string]any{"id": "message-test", "type": "agentMessage", "text": "DONE"}}})
				_ = enc.Encode(map[string]any{"method": "turn/completed", "params": map[string]any{"turn": map[string]any{"id": "turn-test", "status": "completed"}}})
			}
		case "turn/steer":
			if request.Params["expectedTurnId"] != "turn-test" {
				_ = enc.Encode(map[string]any{"id": request.ID, "error": map[string]any{"code": -32600, "message": "wrong turn"}})
				continue
			}
			_ = enc.Encode(map[string]any{"id": request.ID, "result": map[string]any{"turnId": "turn-test"}})
			_ = enc.Encode(map[string]any{"method": "item/completed", "params": map[string]any{"item": map[string]any{"id": "message-test", "type": "agentMessage", "text": "STEERED"}}})
			_ = enc.Encode(map[string]any{"method": "turn/completed", "params": map[string]any{"turn": map[string]any{"id": "turn-test", "status": "completed"}}})
		case "turn/interrupt":
			_ = enc.Encode(map[string]any{"id": request.ID, "result": map[string]any{}})
			if os.Getenv("GO_WANT_RUDDER_INTERRUPT_ACK_ONLY") == "1" {
				continue
			}
			_ = enc.Encode(map[string]any{"method": "turn/completed", "params": map[string]any{"turn": map[string]any{"id": "turn-test", "status": "interrupted"}}})
		default:
			if request.ID != "" {
				_ = enc.Encode(map[string]any{"id": request.ID, "error": map[string]any{"code": -32601, "message": fmt.Sprintf("unsupported %s", request.Method)}})
			}
		}
	}
}
