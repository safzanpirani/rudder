package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDelegateSkillIsEmbedded(t *testing.T) {
	if !strings.HasPrefix(delegateSkill, "---\nname: ruddr-delegate\n") {
		t.Fatalf("unexpected skill header: %q", delegateSkill[:40])
	}
}

func TestInstallDelegateSkill(t *testing.T) {
	dir := t.TempDir()
	path, err := installDelegateSkill(dir)
	if err != nil {
		t.Fatal(err)
	}
	if path != filepath.Join(dir, "ruddr-delegate", "SKILL.md") {
		t.Fatalf("installed at %s", path)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != delegateSkill {
		t.Fatalf("skill content mismatch: %v", err)
	}
	if err := os.WriteFile(path, []byte("stale"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := installDelegateSkill(dir); err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(path)
	if string(data) != delegateSkill {
		t.Fatal("stale copy was not replaced")
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 {
		t.Fatalf("temp file left behind: %d entries", len(entries))
	}
}

func TestSkillInstallCommandUsesDirFlags(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	if err := runCLI([]string{"skill", "install", "--dir", a, "--dir", b}); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{a, b} {
		if _, err := os.Stat(filepath.Join(dir, "ruddr-delegate", "SKILL.md")); err != nil {
			t.Fatal(err)
		}
	}
}
