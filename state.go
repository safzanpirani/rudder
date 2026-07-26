package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

const stateFileName = "state.json"

// Darwin allows 104 bytes including the trailing NUL; this conservative limit
// also works on Linux and leaves room for platform bookkeeping.
const maxControlSocketPathBytes = 100

type runState struct {
	Version     int       `json:"version"`
	PID         int       `json:"pid"`
	ChildPID    int       `json:"childPid,omitempty"`
	Status      string    `json:"status"`
	ThreadID    string    `json:"threadId,omitempty"`
	TurnID      string    `json:"turnId,omitempty"`
	Model       string    `json:"model"`
	Effort      string    `json:"effort,omitempty"`
	CWD         string    `json:"cwd"`
	Sandbox     string    `json:"sandbox"`
	StateDir    string    `json:"stateDir"`
	SocketPath  string    `json:"socketPath"`
	SocketDir   string    `json:"socketDir,omitempty"`
	EventsPath  string    `json:"eventsPath"`
	TracePath   string    `json:"tracePath"`
	OutputPath  string    `json:"outputPath"`
	StderrPath  string    `json:"stderrPath"`
	Steers      int       `json:"steers"`
	StartedAt   time.Time `json:"startedAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
	CompletedAt time.Time `json:"completedAt,omitempty"`
	Error       string    `json:"error,omitempty"`
}

type stateStore struct {
	mu    sync.Mutex
	path  string
	state runState
}

func newStateStore(cfg runConfig) (*stateStore, error) {
	stateDir, err := filepath.Abs(cfg.StateDir)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return nil, err
	}
	if err := os.Chmod(stateDir, 0o700); err != nil {
		return nil, err
	}
	existing, err := readState(stateDir)
	if err == nil && !terminalStatus(existing.Status) && processAlive(existing.PID) {
		return nil, fmt.Errorf("state directory already belongs to active Rudder pid %d", existing.PID)
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("read existing state: %w", err)
	}
	now := time.Now().UTC()
	socketPath, socketDir, err := controlSocketLocation(stateDir)
	if err != nil {
		return nil, err
	}
	store := &stateStore{
		path: filepath.Join(stateDir, stateFileName),
		state: runState{
			Version:    1,
			PID:        os.Getpid(),
			Status:     "starting",
			Model:      cfg.Model,
			Effort:     cfg.Effort,
			CWD:        cfg.CWD,
			Sandbox:    cfg.Sandbox,
			StateDir:   stateDir,
			SocketPath: socketPath,
			SocketDir:  socketDir,
			EventsPath: filepath.Join(stateDir, "events.jsonl"),
			TracePath:  filepath.Join(stateDir, "trace.log"),
			OutputPath: filepath.Join(stateDir, "output.md"),
			StderrPath: filepath.Join(stateDir, "app-server.stderr.log"),
			StartedAt:  now,
			UpdatedAt:  now,
		},
	}
	if err := store.persistLocked(); err != nil {
		if socketDir != "" {
			_ = os.RemoveAll(socketDir)
		}
		return nil, err
	}
	return store, nil
}

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return process.Signal(syscall.Signal(0)) == nil
}

func (s *stateStore) update(fn func(*runState)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.state
	fn(&next)
	next.UpdatedAt = time.Now().UTC()
	if err := persistState(s.path, next); err != nil {
		return err
	}
	s.state = next
	return nil
}

func (s *stateStore) snapshot() runState {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state
}

func (s *stateStore) persistLocked() error {
	return persistState(s.path, s.state)
}

func persistState(path string, state runState) error {
	raw, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func readState(stateDir string) (runState, error) {
	if stateDir == "" {
		return runState{}, errors.New("--state-dir is required")
	}
	raw, err := os.ReadFile(filepath.Join(stateDir, stateFileName))
	if err != nil {
		return runState{}, err
	}
	var state runState
	if err := json.Unmarshal(raw, &state); err != nil {
		return runState{}, err
	}
	return state, nil
}

func controlSocketLocation(stateDir string) (string, string, error) {
	insideState := filepath.Join(stateDir, ".rudder.sock")
	if len([]byte(insideState)) <= maxControlSocketPathBytes {
		return insideState, "", nil
	}

	roots := []string{os.TempDir()}
	if os.TempDir() != "/tmp" {
		roots = append(roots, "/tmp")
	}
	for _, root := range roots {
		privateDir, err := os.MkdirTemp(root, "codex-rudder-")
		if err != nil {
			continue
		}
		if err := os.Chmod(privateDir, 0o700); err != nil {
			_ = os.RemoveAll(privateDir)
			continue
		}
		path := filepath.Join(privateDir, "control.sock")
		if len([]byte(path)) <= maxControlSocketPathBytes {
			return path, privateDir, nil
		}
		_ = os.RemoveAll(privateDir)
	}
	return "", "", fmt.Errorf("cannot create a private Unix socket path within %d bytes", maxControlSocketPathBytes)
}

func terminalStatus(status string) bool {
	switch status {
	case "completed", "failed", "interrupted":
		return true
	default:
		return false
	}
}

func displayedState(state runState) runState {
	if !terminalStatus(state.Status) && !processAlive(state.PID) {
		state.Status = "stale"
		state.Error = fmt.Sprintf("Rudder pid %d is not running; persisted state is stale", state.PID)
	}
	return state
}

func writePrivateFile(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func printJSON(value any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(value)
}

func tailLines(path string, count int) ([]string, error) {
	if count <= 0 {
		return nil, nil
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	ring := make([]string, count)
	total := 0
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		ring[total%count] = scanner.Text()
		total++
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read trace: %w", err)
	}
	if total < count {
		return ring[:total], nil
	}
	lines := make([]string, count)
	start := total % count
	for i := range count {
		lines[i] = ring[(start+i)%count]
	}
	return lines, nil
}
