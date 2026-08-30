package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestConfigureProviderDefaultsKeepsCodexCompatible(t *testing.T) {
	cfg := runConfig{}
	if err := configureProviderDefaults(&cfg, nil); err != nil {
		t.Fatal(err)
	}
	if cfg.Provider != providerCodex {
		t.Fatalf("provider = %q, want codex", cfg.Provider)
	}
	if cfg.Model != "gpt-5.6-sol" {
		t.Fatalf("model = %q, want Codex default", cfg.Model)
	}
	if got := strings.Join(cfg.ChildCommand, " "); got != "codex app-server --listen stdio://" {
		t.Fatalf("child = %q", got)
	}
}

func TestConfigureProviderDefaultsFindsClaudeAdapter(t *testing.T) {
	entry := filepath.Join(t.TempDir(), "app-server.ts")
	if err := os.WriteFile(entry, []byte("export {};\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(claudeAdapterEntryEnvironment, entry)
	cfg := runConfig{Provider: providerClaude}
	if err := configureProviderDefaults(&cfg, nil); err != nil {
		t.Fatal(err)
	}
	if cfg.Model != "" {
		t.Fatalf("Claude model should use provider default, got %q", cfg.Model)
	}
	if len(cfg.ChildCommand) != 3 || cfg.ChildCommand[1] != "run" || cfg.ChildCommand[2] != entry {
		t.Fatalf("unexpected Claude child: %#v", cfg.ChildCommand)
	}
}

func TestConfigureProviderDefaultsRejectsInvalidProviderAndClaudeChild(t *testing.T) {
	if err := configureProviderDefaults(&runConfig{Provider: "other"}, nil); err == nil {
		t.Fatal("expected invalid provider error")
	}
	if err := configureProviderDefaults(&runConfig{Provider: providerClaude}, []string{"claude", "-p"}); err == nil || !strings.Contains(err.Error(), "--claude-path") {
		t.Fatalf("expected Claude child guidance, got %v", err)
	}
}

func TestReadStateNormalizesLegacyProvider(t *testing.T) {
	stateDir := t.TempDir()
	raw, err := json.Marshal(runState{Version: 1, PID: os.Getpid(), Status: "completed", StateDir: stateDir})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stateDir, stateFileName), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	state, err := readState(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if state.Provider != providerCodex {
		t.Fatalf("legacy provider = %q, want codex", state.Provider)
	}
}

func TestNewStatePersistsProviderSchemaVersion(t *testing.T) {
	store, err := newStateStore(runConfig{
		Provider: providerClaude,
		StateDir: t.TempDir(),
		CWD:      t.TempDir(),
		Sandbox:  "workspace-write",
	})
	if err != nil {
		t.Fatal(err)
	}
	state := store.snapshot()
	if state.Version != 2 || state.Provider != providerClaude {
		t.Fatalf("state version/provider = %d/%q", state.Version, state.Provider)
	}
	if filepath.Base(state.StderrPath) != "provider.stderr.log" {
		t.Fatalf("stderr path = %q", state.StderrPath)
	}
}

func TestConfigureProviderDefaultsClaudePathEnvironment(t *testing.T) {
	entry := filepath.Join(t.TempDir(), "app-server.ts")
	if err := os.WriteFile(entry, []byte("export {};\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(claudeAdapterEntryEnvironment, entry)
	t.Setenv(claudePathEnvironment, "/opt/claude-wrapper")

	cfg := runConfig{Provider: providerClaude}
	if err := configureProviderDefaults(&cfg, nil); err != nil {
		t.Fatal(err)
	}
	if cfg.ClaudePath != "/opt/claude-wrapper" {
		t.Fatalf("environment should supply the Claude executable, got %q", cfg.ClaudePath)
	}

	explicit := runConfig{Provider: providerClaude, ClaudePath: "/opt/explicit"}
	if err := configureProviderDefaults(&explicit, nil); err != nil {
		t.Fatal(err)
	}
	if explicit.ClaudePath != "/opt/explicit" {
		t.Fatalf("--claude-path should win over the environment, got %q", explicit.ClaudePath)
	}
}

func TestConfigureProviderDefaultsFindsOpenCodeAndPiAdapters(t *testing.T) {
	for _, test := range []struct {
		provider         string
		entryEnvironment string
		providerPath     string
		setPath          func(*runConfig, string)
	}{
		{providerOpenCode, opencodeAdapterEntryEnvironment, "/opt/opencode2", func(cfg *runConfig, path string) { cfg.OpenCodePath = path }},
		{providerPi, piAdapterEntryEnvironment, "/opt/pi", func(cfg *runConfig, path string) { cfg.PiPath = path }},
	} {
		t.Run(test.provider, func(t *testing.T) {
			entry := filepath.Join(t.TempDir(), "app-server.ts")
			if err := os.WriteFile(entry, []byte("export {};\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			t.Setenv(test.entryEnvironment, entry)
			cfg := runConfig{Provider: test.provider}
			test.setPath(&cfg, test.providerPath)
			if err := configureProviderDefaults(&cfg, nil); err != nil {
				t.Fatal(err)
			}
			if cfg.Model != "openrouter/deepseek/deepseek-v4-flash-vision-exp" {
				t.Fatalf("default model = %q", cfg.Model)
			}
			if cfg.ProviderPath != test.providerPath {
				t.Fatalf("provider path = %q", cfg.ProviderPath)
			}
			if len(cfg.ChildCommand) != 3 || cfg.ChildCommand[2] != entry {
				t.Fatalf("unexpected child command: %#v", cfg.ChildCommand)
			}
		})
	}
}

func TestFindAdapterEntryDoesNotExecuteWorkspaceAdapter(t *testing.T) {
	workspace := t.TempDir()
	entry := filepath.Join(workspace, "opencode", "app-server.ts")
	if err := os.MkdirAll(filepath.Dir(entry), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(entry, []byte("throw new Error('workspace adapter');\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Chdir(workspace)
	t.Setenv(opencodeAdapterEntryEnvironment, "")
	t.Setenv("XDG_DATA_HOME", t.TempDir())

	resolved, err := findAdapterEntry(opencodeAdapterEntryEnvironment, "opencode", "app-server.ts")
	if err == nil || resolved != "" {
		t.Fatalf("workspace adapter resolved as %q with error %v", resolved, err)
	}
}
