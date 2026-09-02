package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRegisterRunStateDirWritesPrivateReference(t *testing.T) {
	registryDir := filepath.Join(t.TempDir(), "registry")
	t.Setenv(registryDirectoryEnvironment, registryDir)
	stateDir := filepath.Join(t.TempDir(), "run")

	if err := registerRunStateDir(stateDir); err != nil {
		t.Fatal(err)
	}
	registryInfo, err := os.Stat(registryDir)
	if err != nil {
		t.Fatal(err)
	}
	if registryInfo.Mode().Perm() != 0o700 {
		t.Fatalf("registry mode = %o, want 700", registryInfo.Mode().Perm())
	}
	entries, err := os.ReadDir(registryDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || !strings.HasSuffix(entries[0].Name(), ".run") {
		t.Fatalf("registry entries = %#v, want one .run reference", entries)
	}
	entryPath := filepath.Join(registryDir, entries[0].Name())
	entryInfo, err := os.Stat(entryPath)
	if err != nil {
		t.Fatal(err)
	}
	if entryInfo.Mode().Perm() != 0o600 {
		t.Fatalf("registry entry mode = %o, want 600", entryInfo.Mode().Perm())
	}
	raw, err := os.ReadFile(entryPath)
	if err != nil {
		t.Fatal(err)
	}
	absolute, err := filepath.Abs(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != absolute+"\n" {
		t.Fatalf("registry entry = %q, want %q", raw, absolute+"\n")
	}
}

func TestRunningRuddrStateDir(t *testing.T) {
	tests := []struct {
		command string
		want    string
		ok      bool
	}{
		{command: "ruddr run --state-dir /tmp/run --model test", want: "/tmp/run", ok: true},
		{command: `/Users/test/bin/ruddr run --state-dir "/tmp/run with spaces"`, want: "/tmp/run with spaces", ok: true},
		{command: "ruddr run --state-dir='/tmp/single quoted'", want: "/tmp/single quoted", ok: true},
		{command: "other-ruddr run --state-dir /tmp/run", ok: false},
		{command: "ruddr status --state-dir /tmp/run", ok: false},
	}
	for _, test := range tests {
		t.Run(test.command, func(t *testing.T) {
			got, ok := runningRuddrStateDir(test.command)
			if got != test.want || ok != test.ok {
				t.Fatalf("runningRuddrStateDir() = %q, %v; want %q, %v", got, ok, test.want, test.ok)
			}
		})
	}
}
