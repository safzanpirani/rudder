package main

import "testing"

func TestModelCatalogDefaults(t *testing.T) {
	if got := defaultModel(providerCodex); got != "gpt-5.6-sol" {
		t.Fatalf("codex default = %q", got)
	}
	if got := defaultModel(providerClaude); got != "claude-opus-5" {
		t.Fatalf("claude default = %q", got)
	}
	defaults := map[string]int{}
	sawOpencode := false
	for _, model := range modelCatalog {
		if model.Default {
			defaults[model.Provider]++
		}
		if model.Available && model.ID == "" {
			t.Fatalf("available model without id: %#v", model)
		}
		if model.Provider == "opencode" {
			sawOpencode = true
			if model.Available {
				t.Fatal("opencode must be unavailable until an adapter exists")
			}
			if model.Note == "" {
				t.Fatal("opencode sentinel needs a note for the picker")
			}
		}
	}
	if defaults[providerCodex] != 1 || defaults[providerClaude] != 1 {
		t.Fatalf("defaults per provider = %#v, want exactly one each", defaults)
	}
	if !sawOpencode {
		t.Fatal("catalog is missing the opencode placeholder row")
	}
}
