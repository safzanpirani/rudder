package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	registryDirectoryEnvironment = "RUDDR_REGISTRY_DIR"
	// Earlier releases were named rudder and codex-rudder; their settings and
	// on-disk locations keep working after the rename.
	previousRegistryDirectoryEnvironment = "RUDDER_REGISTRY_DIR"
	legacyRegistryDirectoryEnvironment   = "CODEX_RUDDER_REGISTRY_DIR"
)

// getenvAny returns the first non-empty variable from the given names.
func getenvAny(names ...string) string {
	for _, name := range names {
		if value := os.Getenv(name); value != "" {
			return value
		}
	}
	return ""
}

var (
	ruddrRunPattern = regexp.MustCompile(`(?:^|/)ruddr\s+run(?:\s|$)`)
	stateDirPattern = regexp.MustCompile(`(?:^|\s)--state-dir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))`)
)

func registerRunStateDir(stateDir string) error {
	absolute, err := filepath.Abs(stateDir)
	if err != nil {
		return err
	}
	registryDir, err := runRegistryDirectory()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(registryDir, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(registryDir, 0o700); err != nil {
		return err
	}
	digest := sha256.Sum256([]byte(absolute))
	entryPath := filepath.Join(registryDir, hex.EncodeToString(digest[:])+".run")
	return writePrivateFile(entryPath, []byte(absolute+"\n"))
}

func runRegistryDirectory() (string, error) {
	if configured := getenvAny(registryDirectoryEnvironment, previousRegistryDirectoryEnvironment, legacyRegistryDirectoryEnvironment); configured != "" {
		return filepath.Abs(configured)
	}
	if stateHome := os.Getenv("XDG_STATE_HOME"); stateHome != "" {
		return filepath.Join(stateHome, "ruddr", "runs"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".local", "state", "ruddr", "runs"), nil
}

func registerRunningRuddrRuns() {
	output, err := exec.Command("ps", "-axo", "command=").Output()
	if err != nil {
		return
	}
	for _, command := range strings.Split(string(output), "\n") {
		stateDir, ok := runningRuddrStateDir(command)
		if !ok {
			continue
		}
		state, err := readState(stateDir)
		if err != nil || terminalStatus(state.Status) || !processAlive(state.PID) {
			continue
		}
		_ = registerRunStateDir(stateDir)
	}
}

func runningRuddrStateDir(command string) (string, bool) {
	if !ruddrRunPattern.MatchString(command) {
		return "", false
	}
	match := stateDirPattern.FindStringSubmatch(command)
	if len(match) == 0 {
		return "", false
	}
	for _, candidate := range match[1:] {
		if candidate != "" {
			return candidate, true
		}
	}
	return "", false
}
