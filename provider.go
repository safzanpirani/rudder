package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

const (
	providerCodex  = "codex"
	providerClaude = "claude"

	claudeAdapterEntryEnvironment       = "RUDDER_CLAUDE_ADAPTER_ENTRY"
	legacyClaudeAdapterEntryEnvironment = "CODEX_RUDDER_CLAUDE_ADAPTER_ENTRY"

	claudePathEnvironment = "RUDDER_CLAUDE_PATH"
)

func normalizeProvider(provider string) (string, error) {
	if provider == "" {
		return providerCodex, nil
	}
	switch provider {
	case providerCodex, providerClaude:
		return provider, nil
	default:
		return "", fmt.Errorf("unsupported provider %q; expected codex or claude", provider)
	}
}

func configureProviderDefaults(cfg *runConfig, childArgs []string) error {
	provider, err := normalizeProvider(cfg.Provider)
	if err != nil {
		return err
	}
	cfg.Provider = provider

	switch provider {
	case providerCodex:
		if cfg.Model == "" {
			cfg.Model = defaultModel(providerCodex)
		}
		if len(childArgs) > 0 {
			cfg.ChildCommand = childArgs
		} else {
			cfg.ChildCommand = []string{"codex", "app-server", "--listen", "stdio://"}
		}
	case providerClaude:
		if len(childArgs) > 0 {
			return errors.New("a command after -- is supported only for Codex; use --claude-path for Claude Code")
		}
		if cfg.ClaudePath == "" {
			cfg.ClaudePath = os.Getenv(claudePathEnvironment)
		}
		bunPath, err := exec.LookPath("bun")
		if err != nil {
			return errors.New("Claude support requires Bun 1.4 or newer")
		}
		entry, err := findClaudeAdapterEntry()
		if err != nil {
			return err
		}
		cfg.ChildCommand = []string{bunPath, "run", entry}
	}
	return nil
}

func findClaudeAdapterEntry() (string, error) {
	var candidates []string
	for _, environment := range []string{claudeAdapterEntryEnvironment, legacyClaudeAdapterEntryEnvironment} {
		if configured := os.Getenv(environment); configured != "" {
			candidates = append(candidates, configured)
		}
	}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates, filepath.Join(cwd, "claude", "app-server.ts"))
	}
	if executable, err := os.Executable(); err == nil {
		candidates = appendRuntimeSiblingCandidates(candidates, executable, "claude", "app-server.ts")
	}
	if dataHome, err := rudderDataHome(); err == nil {
		candidates = append(candidates,
			filepath.Join(dataHome, "rudder", "claude", "app-server.ts"),
			filepath.Join(dataHome, "codex-rudder", "claude", "app-server.ts"),
		)
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
	return "", fmt.Errorf("cannot locate claude/app-server.ts; run the installer or set %s", claudeAdapterEntryEnvironment)
}

func appendRuntimeSiblingCandidates(candidates []string, executable string, parts ...string) []string {
	candidates = append(candidates, filepath.Join(append([]string{filepath.Dir(executable)}, parts...)...))
	if resolved, err := filepath.EvalSymlinks(executable); err == nil && resolved != executable {
		candidates = append(candidates, filepath.Join(append([]string{filepath.Dir(resolved)}, parts...)...))
	}
	return candidates
}
