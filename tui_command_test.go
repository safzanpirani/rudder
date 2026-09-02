package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFindTUIEntryHonorsConfiguredPath(t *testing.T) {
	entryPath := filepath.Join(t.TempDir(), "custom-tui.ts")
	if err := os.WriteFile(entryPath, []byte("// test\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(tuiEntryEnvironment, entryPath)

	got, err := findTUIEntry()
	if err != nil {
		t.Fatal(err)
	}
	want, err := filepath.Abs(entryPath)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("findTUIEntry() = %q, want %q", got, want)
	}
}

func TestFindTUIEntryUsesInstalledDataDirectory(t *testing.T) {
	t.Chdir(t.TempDir())
	t.Setenv(tuiEntryEnvironment, "")
	dataHome := t.TempDir()
	t.Setenv("XDG_DATA_HOME", dataHome)
	entryPath := filepath.Join(dataHome, "codex-rudder", "tui", "index.ts")
	if err := os.MkdirAll(filepath.Dir(entryPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(entryPath, []byte("// installed test\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	got, err := findTUIEntry()
	if err != nil {
		t.Fatal(err)
	}
	if got != entryPath {
		t.Fatalf("findTUIEntry() = %q, want installed entry %q", got, entryPath)
	}
}

func TestTUIProcessInheritsCallerWorkingDirectory(t *testing.T) {
	cmd := newTUIProcess("bun", "/installed/tui/index.ts", "/installed/ruddr", []string{"--all"})
	if cmd.Dir != "" {
		t.Fatalf("TUI process directory = %q, want inherited caller directory", cmd.Dir)
	}
}
