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
	sawPi := false
	for _, model := range modelCatalog {
		if model.Default {
			defaults[model.Provider]++
		}
		if model.Available && model.ID == "" {
			t.Fatalf("available model without id: %#v", model)
		}
		if model.Provider == "opencode" {
			sawOpencode = true
			if !model.Available || model.ID == "" {
				t.Fatal("opencode adapter needs an available model")
			}
		}
		if model.Provider == "pi" {
			sawPi = true
			if !model.Available || model.ID == "" {
				t.Fatal("Pi adapter needs an available model")
			}
			if len(model.Efforts) != 7 || model.Efforts[0] != "off" || model.Efforts[1] != "minimal" {
				t.Fatalf("Pi efforts = %#v", model.Efforts)
			}
		}
	}
	if defaults[providerCodex] != 1 || defaults[providerClaude] != 1 || defaults[providerOpenCode] != 1 || defaults[providerPi] != 1 {
		t.Fatalf("defaults per provider = %#v, want exactly one each", defaults)
	}
	if !sawOpencode || !sawPi {
		t.Fatal("catalog is missing an external provider")
	}
}
