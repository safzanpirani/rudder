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
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	maxRPCLineBytes        = 64 * 1024 * 1024
	defaultRPCWriteTimeout = 10 * time.Second
)

type runConfig struct {
	Provider          string
	CWD               string
	PromptFile        string
	StateDir          string
	Model             string
	Effort            string
	Sandbox           string
	ApprovalPolicy    string
	ClaudePath        string
	Ephemeral         bool
	ResumeThreadID    string
	ForkThreadID      string
	ForkBeforeTurnID  string
	ForkThroughTurnID string
	TurnTimeout       time.Duration
	ChildCommand      []string
	RegisterRun       bool
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcEnvelope struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *rpcError       `json:"error,omitempty"`
}

type controller struct {
	cfg         runConfig
	store       *stateStore
	child       *exec.Cmd
	childIn     io.WriteCloser
	listener    net.Listener
	events      *os.File
	trace       *os.File
	stderr      *os.File
	writeMu     sync.Mutex
	traceMu     sync.Mutex
	outputMu    sync.Mutex
	outputParts []string
	resultMu    sync.Mutex
	resultError string
	pendingMu   sync.Mutex
	pending     map[string]chan rpcEnvelope
	nextID      atomic.Uint64
	done        chan struct{}
	doneOnce    sync.Once
	waitCh      chan error
	readDone    chan struct{}
	stopChild   atomic.Bool
}

func runController(cfg runConfig) error {
	return runControllerContext(context.Background(), cfg)
}

func runControllerContext(ctx context.Context, cfg runConfig) error {
	if err := validateRunConfig(&cfg); err != nil {
		return err
	}
	prompt, err := os.ReadFile(cfg.PromptFile)
	if err != nil {
		return err
	}
	if len(bytes.TrimSpace(prompt)) == 0 {
		return errors.New("prompt file is empty")
	}
	store, err := newStateStore(cfg)
	if err != nil {
		return err
	}
	r := &controller{
		cfg:      cfg,
		store:    store,
		pending:  make(map[string]chan rpcEnvelope),
		done:     make(chan struct{}),
		waitCh:   make(chan error, 1),
		readDone: make(chan struct{}),
	}
	defer r.closeControlServer()
	if err := r.openLogs(); err != nil {
		r.fail(err)
		return err
	}
	defer r.closeLogs()
	if err := r.startChild(); err != nil {
		r.fail(err)
		return err
	}
	defer r.shutdownChild()
	cancelWatchDone := make(chan struct{})
	defer close(cancelWatchDone)
	go func() {
		select {
		case <-ctx.Done():
			r.stopChild.Store(true)
			r.tracef("[interrupt] controller context canceled")
			r.finish("interrupted", "")
			terminateProcessTree(r.child, false)
		case <-cancelWatchDone:
		}
	}()
	if err := r.startControlServer(); err != nil {
		r.fail(err)
		return err
	}

	if err := r.initialize(string(prompt)); err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("run interrupted: %w", ctx.Err())
		}
		r.fail(err)
		return err
	}
	if cfg.TurnTimeout > 0 {
		timer := time.NewTimer(cfg.TurnTimeout)
		select {
		case <-r.done:
			if !timer.Stop() {
				<-timer.C
			}
		case <-timer.C:
			r.stopChild.Store(true)
			r.tracef("[error] active turn exceeded watchdog %s", cfg.TurnTimeout)
			r.finish("failed", "turn watchdog expired")
			terminateProcessTree(r.child, false)
		}
	} else {
		<-r.done
	}
	state := r.store.snapshot()
	if state.Status == "completed" {
		return nil
	}
	if resultErr := r.privateResultError(); resultErr != "" {
		return errors.New(resultErr)
	}
	if state.Error != "" {
		return errors.New(state.Error)
	}
	return fmt.Errorf("turn ended with status %s", state.Status)
}

func validateRunConfig(cfg *runConfig) error {
	provider, err := normalizeProvider(cfg.Provider)
	if err != nil {
		return err
	}
	cfg.Provider = provider
	if len(cfg.ChildCommand) == 0 {
		return errors.New("provider command is empty")
	}
	cwd, err := filepath.Abs(cfg.CWD)
	if err != nil {
		return err
	}
	cfg.CWD = cwd
	if cfg.Provider == providerCodex && cfg.Model == "" {
		return errors.New("model is required")
	}
	if cfg.Provider == providerClaude {
		if cfg.ApprovalPolicy != "never" {
			return errors.New("Claude runs require --approval-policy never because Rudder has no interactive approval surface")
		}
		if cfg.ForkThreadID != "" || cfg.ForkBeforeTurnID != "" || cfg.ForkThroughTurnID != "" {
			return errors.New("Claude runs do not yet support --fork-thread or fork turn selectors; use --resume-thread")
		}
	}
	if cfg.ResumeThreadID != "" && cfg.ForkThreadID != "" {
		return errors.New("--resume-thread and --fork-thread are mutually exclusive")
	}
	if cfg.ForkBeforeTurnID != "" && cfg.ForkThroughTurnID != "" {
		return errors.New("--fork-before-turn and --fork-through-turn are mutually exclusive")
	}
	if (cfg.ForkBeforeTurnID != "" || cfg.ForkThroughTurnID != "") && cfg.ForkThreadID == "" {
		return errors.New("fork turn selectors require --fork-thread")
	}
	switch cfg.Sandbox {
	case "read-only", "workspace-write", "danger-full-access":
	default:
		return fmt.Errorf("unsupported sandbox %q", cfg.Sandbox)
	}
	return nil
}

func (r *controller) openLogs() error {
	state := r.store.snapshot()
	var err error
	if r.events, err = openPrivateLog(state.EventsPath); err != nil {
		return err
	}
	if r.trace, err = openPrivateLog(state.TracePath); err != nil {
		r.events.Close()
		return err
	}
	if r.stderr, err = openPrivateLog(state.StderrPath); err != nil {
		r.trace.Close()
		r.events.Close()
		return err
	}
	return nil
}

func openPrivateLog(path string) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return nil, err
	}
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

func (r *controller) closeLogs() {
	if r.stderr != nil {
		r.stderr.Close()
	}
	if r.trace != nil {
		r.trace.Close()
	}
	if r.events != nil {
		r.events.Close()
	}
}

func (r *controller) startChild() error {
	r.child = exec.Command(r.cfg.ChildCommand[0], r.cfg.ChildCommand[1:]...)
	configureChildProcess(r.child)
	r.child.Dir = r.cfg.CWD
	childOut, err := r.child.StdoutPipe()
	if err != nil {
		return err
	}
	r.childIn, err = r.child.StdinPipe()
	if err != nil {
		_ = childOut.Close()
		return err
	}
	r.child.Stderr = r.stderr
	if err := r.child.Start(); err != nil {
		_ = childOut.Close()
		_ = r.childIn.Close()
		return err
	}
	go r.readChild(childOut)
	go func() { r.waitCh <- r.child.Wait() }()
	if err := r.store.update(func(state *runState) { state.ChildPID = r.child.Process.Pid }); err != nil {
		r.stopChild.Store(true)
		r.shutdownChild()
		return fmt.Errorf("persist child pid: %w", err)
	}
	r.tracef(
		"[start] child pid=%d executable=%s args=%d",
		r.child.Process.Pid,
		filepath.Base(r.cfg.ChildCommand[0]),
		len(r.cfg.ChildCommand)-1,
	)
	return nil
}

func (r *controller) initialize(prompt string) error {
	if err := r.initializeSession(); err != nil {
		return err
	}

	threadID, mode, err := r.acquireThread()
	if err != nil {
		return err
	}
	if err := r.store.update(func(state *runState) { state.ThreadID = threadID }); err != nil {
		return fmt.Errorf("persist thread id: %w", err)
	}
	r.tracef("[thread] %s %s", mode, threadID)

	turnParams := map[string]any{
		"threadId": threadID,
		"input": []map[string]any{{
			"type": "text",
			"text": prompt,
		}},
	}
	if r.cfg.Effort != "" {
		turnParams["effort"] = r.cfg.Effort
	}
	var turnResult struct {
		Turn struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"turn"`
	}
	if err := r.call("turn/start", turnParams, &turnResult, 60*time.Second); err != nil {
		return fmt.Errorf("start turn: %w", err)
	}
	if turnResult.Turn.ID == "" {
		return errors.New("turn/start returned no turn id")
	}
	if err := r.store.update(func(state *runState) {
		state.TurnID = turnResult.Turn.ID
		if !terminalStatus(state.Status) {
			state.Status = "active"
		}
	}); err != nil {
		return fmt.Errorf("persist active turn: %w", err)
	}
	r.tracef("[turn] active thread=%s turn=%s", threadID, turnResult.Turn.ID)
	return nil
}

func (r *controller) initializeSession() error {
	var initialized map[string]any
	if err := r.call("initialize", map[string]any{
		"clientInfo": map[string]any{
			"name":    "rudder",
			"title":   "Rudder",
			"version": version,
		},
		"capabilities": map[string]any{
			"experimentalApi": true,
		},
	}, &initialized, 30*time.Second); err != nil {
		return fmt.Errorf("initialize provider: %w", err)
	}
	if err := r.notify("initialized", map[string]any{}); err != nil {
		return err
	}
	return nil
}

func (r *controller) acquireThread() (string, string, error) {
	var threadResult struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	baseParams := map[string]any{
		"cwd":            r.cfg.CWD,
		"approvalPolicy": r.cfg.ApprovalPolicy,
		"sandbox":        r.cfg.Sandbox,
		"provider":       r.cfg.Provider,
	}
	if r.cfg.Model != "" {
		baseParams["model"] = r.cfg.Model
	}
	if r.cfg.Provider == providerClaude {
		baseParams["persistSession"] = !r.cfg.Ephemeral
		if r.cfg.ClaudePath != "" {
			baseParams["claudePath"] = r.cfg.ClaudePath
		}
	}
	method := "thread/start"
	mode := "started"
	baseParams["ephemeral"] = r.cfg.Ephemeral
	baseParams["serviceName"] = "rudder"
	if r.cfg.ResumeThreadID != "" {
		method = "thread/resume"
		mode = "resumed"
		delete(baseParams, "ephemeral")
		delete(baseParams, "serviceName")
		baseParams["threadId"] = r.cfg.ResumeThreadID
		baseParams["excludeTurns"] = true
	} else if r.cfg.ForkThreadID != "" {
		method = "thread/fork"
		mode = "forked"
		delete(baseParams, "serviceName")
		baseParams["threadId"] = r.cfg.ForkThreadID
		baseParams["excludeTurns"] = true
		if r.cfg.ForkBeforeTurnID != "" {
			baseParams["beforeTurnId"] = r.cfg.ForkBeforeTurnID
		}
		if r.cfg.ForkThroughTurnID != "" {
			baseParams["lastTurnId"] = r.cfg.ForkThroughTurnID
		}
	}
	if err := r.call(method, baseParams, &threadResult, 60*time.Second); err != nil {
		return "", mode, fmt.Errorf("%s: %w", method, err)
	}
	if threadResult.Thread.ID == "" {
		return "", mode, fmt.Errorf("%s returned no thread id", method)
	}
	return threadResult.Thread.ID, mode, nil
}

func (r *controller) call(method string, params any, target any, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	id := fmt.Sprintf("rudder-%d", r.nextID.Add(1))
	responseCh := make(chan rpcEnvelope, 1)
	r.pendingMu.Lock()
	r.pending[id] = responseCh
	r.pendingMu.Unlock()
	defer func() {
		r.pendingMu.Lock()
		delete(r.pending, id)
		r.pendingMu.Unlock()
	}()
	if err := r.writeRPCWithin(map[string]any{"id": id, "method": method, "params": params}, time.Until(deadline)); err != nil {
		return err
	}
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return fmt.Errorf("%s timed out after %s", method, timeout)
	}
	timer := time.NewTimer(remaining)
	defer timer.Stop()
	select {
	case response := <-responseCh:
		if response.Error != nil {
			return fmt.Errorf("%s (%d)", response.Error.Message, response.Error.Code)
		}
		if target != nil && len(response.Result) > 0 {
			if err := json.Unmarshal(response.Result, target); err != nil {
				return err
			}
		}
		return nil
	case <-timer.C:
		return fmt.Errorf("%s timed out after %s", method, timeout)
	case <-r.done:
		state := r.store.snapshot()
		return fmt.Errorf("turn ended while waiting for %s: %s", method, state.Status)
	}
}

func (r *controller) notify(method string, params any) error {
	return r.writeRPC(map[string]any{"method": method, "params": params})
}

func (r *controller) writeRPC(message any) error {
	return r.writeRPCWithin(message, defaultRPCWriteTimeout)
}

func (r *controller) writeRPCWithin(message any, timeout time.Duration) error {
	raw, err := json.Marshal(message)
	if err != nil {
		return err
	}
	r.writeMu.Lock()
	defer r.writeMu.Unlock()
	return writeAllWithTimeout(r.childIn, append(raw, '\n'), timeout)
}

func writeAllWithTimeout(writer io.WriteCloser, data []byte, timeout time.Duration) error {
	if timeout <= 0 {
		return errors.New("app-server stdin write timed out")
	}
	deadline := time.Now().Add(timeout)
	if deadlineWriter, ok := writer.(interface{ SetWriteDeadline(time.Time) error }); ok {
		if err := deadlineWriter.SetWriteDeadline(deadline); err == nil {
			defer deadlineWriter.SetWriteDeadline(time.Time{})
			if _, err := writer.Write(data); err != nil {
				if errors.Is(err, os.ErrDeadlineExceeded) {
					_ = writer.Close()
					return fmt.Errorf("app-server stdin write timed out after %s", timeout)
				}
				return err
			}
			return nil
		}
	}
	type writeResult struct {
		n   int
		err error
	}
	resultCh := make(chan writeResult, 1)
	go func() {
		n, err := writer.Write(data)
		resultCh <- writeResult{n: n, err: err}
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case result := <-resultCh:
		if result.err != nil {
			return result.err
		}
		if result.n != len(data) {
			return io.ErrShortWrite
		}
		return nil
	case <-timer.C:
		_ = writer.Close()
		return fmt.Errorf("app-server stdin write timed out after %s", timeout)
	}
}

func (r *controller) readChild(reader io.Reader) {
	defer close(r.readDone)
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), maxRPCLineBytes)
	for scanner.Scan() {
		raw := append([]byte(nil), scanner.Bytes()...)
		_, _ = r.events.Write(append(raw, '\n'))
		var message rpcEnvelope
		if err := json.Unmarshal(raw, &message); err != nil {
			r.tracef("[warn] invalid provider JSON: %v", err)
			continue
		}
		if message.Method != "" {
			r.handleServerMessage(message)
			continue
		}
		if id, ok := rpcID(message.ID); ok {
			r.pendingMu.Lock()
			ch := r.pending[id]
			r.pendingMu.Unlock()
			if ch != nil {
				ch <- message
			}
		}
	}
	if err := scanner.Err(); err != nil {
		r.fail(fmt.Errorf("read provider output: %w", err))
		return
	}
	if !terminalStatus(r.store.snapshot().Status) {
		r.fail(errors.New("provider output closed before turn completed"))
	}
}

func rpcID(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 {
		return "", false
	}
	var value any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return "", false
	}
	switch typed := value.(type) {
	case string:
		return typed, typed != ""
	case json.Number:
		if _, err := strconv.ParseInt(typed.String(), 10, 64); err != nil {
			return "", false
		}
		return typed.String(), true
	default:
		return "", false
	}
}

func (r *controller) handleServerMessage(message rpcEnvelope) {
	if len(message.ID) > 0 {
		r.rejectServerRequest(message)
		return
	}
	switch message.Method {
	case "turn/started":
		var params struct {
			Turn struct {
				ID string `json:"id"`
			} `json:"turn"`
		}
		_ = json.Unmarshal(message.Params, &params)
		if err := r.store.update(func(state *runState) {
			state.TurnID = params.Turn.ID
			if !terminalStatus(state.Status) {
				state.Status = "active"
			}
		}); err != nil {
			r.stopChild.Store(true)
			r.fail(fmt.Errorf("persist started turn: %w", err))
			terminateProcessTree(r.child, false)
			return
		}
		r.tracef("[turn] started %s", params.Turn.ID)
	case "turn/completed":
		r.handleTurnCompleted(message.Params)
	case "item/started", "item/updated", "item/completed":
		r.handleItem(message.Method, message.Params)
	case "error":
		var params struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(message.Params, &params)
		r.tracef("[warn] %s", params.Error.Message)
	case "thread/tokenUsage/updated":
		r.tracef("[usage] updated")
	}
}

func (r *controller) rejectServerRequest(message rpcEnvelope) {
	var id any
	if err := json.Unmarshal(message.ID, &id); err != nil {
		return
	}
	r.tracef("[warn] unsupported server request %s", message.Method)
	_ = r.writeRPC(map[string]any{
		"id": id,
		"error": map[string]any{
			"code":    -32601,
			"message": "Rudder cannot answer this interactive request; run with approvalPolicy=never",
		},
	})
}

func (r *controller) handleTurnCompleted(raw json.RawMessage) {
	var params struct {
		Turn struct {
			ID     string    `json:"id"`
			Status string    `json:"status"`
			Error  *rpcError `json:"error"`
		} `json:"turn"`
	}
	_ = json.Unmarshal(raw, &params)
	status := params.Turn.Status
	if status == "inProgress" || status == "" {
		status = "failed"
	}
	errText := ""
	if params.Turn.Error != nil {
		errText = params.Turn.Error.Message
	}
	r.finish(status, errText)
}

func (r *controller) handleItem(method string, raw json.RawMessage) {
	var params struct {
		Item map[string]any `json:"item"`
	}
	if err := json.Unmarshal(raw, &params); err != nil {
		return
	}
	itemType, _ := params.Item["type"].(string)
	status, _ := params.Item["status"].(string)
	if method == "item/updated" {
		return
	}
	prefix := "[item]"
	if method == "item/started" {
		prefix = "[in_progress]"
	} else if status == "failed" {
		prefix = "[failed]"
	} else {
		prefix = "[completed]"
	}
	switch itemType {
	case "commandExecution":
		command, _ := params.Item["command"].(string)
		r.tracef("%s $ %s", prefix, oneLine(command, 240))
	case "fileChange":
		command, _ := params.Item["command"].(string)
		if command == "" {
			command = "file changes"
		}
		r.tracef("%s %s", prefix, oneLine(command, 240))
	case "webSearch", "toolCall":
		command, _ := params.Item["command"].(string)
		if command == "" {
			command, _ = params.Item["toolName"].(string)
		}
		r.tracef("%s %s", prefix, oneLine(command, 240))
	case "reasoning":
		if method == "item/completed" {
			r.tracef("[think] %s", oneLine(flattenStrings(params.Item["summary"]), 240))
		}
	case "agentMessage":
		if method == "item/completed" {
			text, _ := params.Item["text"].(string)
			if text != "" {
				if err := r.recordAgentMessage(text); err != nil {
					r.stopChild.Store(true)
					r.fail(fmt.Errorf("persist agent output: %w", err))
					terminateProcessTree(r.child, false)
					return
				}
				r.tracef("[say] %s", singleLine(text))
			}
		}
	default:
		if method == "item/completed" && itemType != "userMessage" {
			r.tracef("%s %s", prefix, itemType)
		}
	}
}

func (r *controller) finish(status, errText string) {
	r.doneOnce.Do(func() {
		if errText != "" {
			r.appendResultError(errText)
			r.tracef("[error] %s", oneLine(errText, 500))
		}
		if err := r.store.update(func(state *runState) {
			state.Status = status
			state.Error = redactedStateError(status, errText)
			state.CompletedAt = time.Now().UTC()
		}); err != nil {
			persistErr := fmt.Sprintf("persist terminal state: %v", err)
			r.appendResultError(persistErr)
			r.tracef("[error] %s", oneLine(persistErr, 500))
		}
		r.tracef("[turn] %s", status)
		close(r.done)
	})
}

func (r *controller) recordAgentMessage(text string) error {
	r.outputMu.Lock()
	defer r.outputMu.Unlock()
	r.outputParts = append(r.outputParts, text)
	content := strings.Join(r.outputParts, "\n\n") + "\n"
	return writePrivateFile(r.store.snapshot().OutputPath, []byte(content))
}

func (r *controller) privateResultError() string {
	r.resultMu.Lock()
	defer r.resultMu.Unlock()
	return r.resultError
}

func (r *controller) appendResultError(errText string) {
	r.resultMu.Lock()
	defer r.resultMu.Unlock()
	if r.resultError == "" {
		r.resultError = errText
		return
	}
	r.resultError += "; " + errText
}

func redactedStateError(status, errText string) string {
	if errText == "" {
		return ""
	}
	switch status {
	case "interrupted":
		return "turn interrupted; see trace.log and provider.stderr.log"
	default:
		return "turn failed; see trace.log and provider.stderr.log"
	}
}

func (r *controller) fail(err error) {
	if err == nil {
		return
	}
	r.finish("failed", err.Error())
}

func (r *controller) shutdownChild() {
	if r.stopChild.Load() {
		terminateProcessTree(r.child, false)
	}
	if r.childIn != nil {
		_ = r.childIn.Close()
	}
	select {
	case <-r.waitCh:
	case <-time.After(3 * time.Second):
		if r.child != nil && r.child.Process != nil {
			terminateProcessTree(r.child, true)
		}
		<-r.waitCh
	}
	if r.readDone != nil {
		select {
		case <-r.readDone:
		case <-time.After(time.Second):
		}
	}
}

func (r *controller) closeControlServer() {
	state := r.store.snapshot()
	if r.listener != nil {
		_ = r.listener.Close()
		_ = os.Remove(state.SocketPath)
	}
	if state.SocketDir != "" {
		_ = os.Remove(state.SocketDir)
	}
}

func (r *controller) tracef(format string, args ...any) {
	r.traceMu.Lock()
	defer r.traceMu.Unlock()
	if r.trace == nil {
		return
	}
	stamp := time.Now().UTC().Format(time.RFC3339)
	_, _ = fmt.Fprintf(r.trace, "%s %s\n", stamp, fmt.Sprintf(format, args...))
}

func oneLine(value string, limit int) string {
	value = singleLine(value)
	if len(value) <= limit {
		return value
	}
	return value[:limit] + "…"
}

func singleLine(value string) string {
	return strings.Join(strings.Fields(value), " ")
}

func flattenStrings(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			if part := flattenStrings(item); part != "" {
				parts = append(parts, part)
			}
		}
		return strings.Join(parts, " ")
	case map[string]any:
		for _, key := range []string{"text", "content"} {
			if part := flattenStrings(typed[key]); part != "" {
				return part
			}
		}
	}
	return ""
}
