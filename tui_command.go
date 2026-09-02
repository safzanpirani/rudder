package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

const (
	tuiEntryEnvironment         = "RUDDR_TUI_ENTRY"
	previousTUIEntryEnvironment = "RUDDER_TUI_ENTRY"
	legacyTUIEntryEnvironment   = "CODEX_RUDDER_TUI_ENTRY"
)

func tuiCommand(args []string) error {
	if len(args) == 1 && (args[0] == "--help" || args[0] == "-h" || args[0] == "help") {
		printTUIUsage()
		return nil
	}
	stdinInfo, stdinErr := os.Stdin.Stat()
	stdoutInfo, stdoutErr := os.Stdout.Stat()
	if stdinErr != nil || stdoutErr != nil || stdinInfo.Mode()&os.ModeCharDevice == 0 || stdoutInfo.Mode()&os.ModeCharDevice == 0 {
		return errors.New("the TUI requires an interactive terminal")
	}
	bunPath, err := exec.LookPath("bun")
	if err != nil {
		return errors.New("the optional TUI requires Bun 1.4 or newer; install Bun and run again")
	}
	registerRunningRuddrRuns()
	entryPath, err := findTUIEntry()
	if err != nil {
		return err
	}
	ruddrPath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate Ruddr executable: %w", err)
	}
	cmd := newTUIProcess(bunPath, entryPath, ruddrPath, args)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("TUI exited: %w", err)
	}
	return nil
}

func newTUIProcess(bunPath, entryPath, ruddrPath string, args []string) *exec.Cmd {
	childArgs := []string{"run", entryPath, "--ruddr", ruddrPath}
	childArgs = append(childArgs, args...)
	return exec.Command(bunPath, childArgs...)
}

func printTUIUsage() {
	name := filepath.Base(os.Args[0])
	fmt.Fprintf(os.Stderr, `Ruddr live sessions TUI

Usage:
  %s tui [--root DIR]... [--state-dir DIR]... [--all] [--interval 500ms] [--theme NAME] [--beta] [--mobile]

Shows live runs first, then every finished run from the global registry plus
.scratch below the current directory. --root and --state-dir may be repeated;
--all is accepted for compatibility and has no effect.
The refresh interval accepts milliseconds or seconds and must be at least 100ms.
Press t inside the TUI to preview and save a theme. --theme overrides the saved
theme for one launch; RUDDR_TUI_THEME provides the same environment override.
--beta enables the chat-first layout; RUDDR_TUI_BETA=1 provides the same
override. The default layout keeps the sessions dashboard visible. Terminals
64 columns wide or narrower get the single-column mobile layout with a tappable
action bar; --mobile or RUDDR_TUI_MOBILE=1 forces it, and mobileWidthThreshold
in tui.json changes the width.
`, name)
}

func findTUIEntry() (string, error) {
	var candidates []string
	for _, environment := range []string{tuiEntryEnvironment, previousTUIEntryEnvironment, legacyTUIEntryEnvironment} {
		if configured := os.Getenv(environment); configured != "" {
			candidates = append(candidates, configured)
		}
	}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates, filepath.Join(cwd, "tui", "index.ts"))
	}
	if executable, err := os.Executable(); err == nil {
		candidates = appendRuntimeSiblingCandidates(candidates, executable, "tui", "index.ts")
	}
	if dataHome, err := ruddrDataHome(); err == nil {
		for _, name := range installDirectoryNames {
			candidates = append(candidates, filepath.Join(dataHome, name, "tui", "index.ts"))
		}
	}
	for _, candidate := range candidates {
		absolute, err := filepath.Abs(candidate)
		if err != nil {
			continue
		}
		info, err := os.Stat(absolute)
		if err == nil && !info.IsDir() {
			return absolute, nil
		}
	}
	return "", fmt.Errorf("cannot locate tui/index.ts; run the installer or set %s", tuiEntryEnvironment)
}

func ruddrDataHome() (string, error) {
	if configured := os.Getenv("XDG_DATA_HOME"); configured != "" {
		return configured, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".local", "share"), nil
}
