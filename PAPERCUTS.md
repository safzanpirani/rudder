# PAPERCUTS

Small, non-blocking frictions encountered by agents while working. Review this file periodically and sand them down.

## 2026-07-21T19:32:36.264Z — codex — gpt-5.6-sol

- **Directory:** `/Users/safzan/Development/projects/codex-rudder`
- **Tags:** `misleading-error`

While extracting Codex app-server schema fields in zsh, assigning a loop variable named path silently overwrote zsh's special PATH array and made jq appear missing. Avoid lowercase path as a zsh variable or run the loop under sh/bash.

## 2026-07-21T19:39:44.287Z — codex — gpt-5.6-sol

- **Directory:** `/Users/safzan/Development/projects/codex-rudder`
- **Tags:** `misleading-error`

Codex CLI 0.145.0 generate-json-schema --experimental advertises thread/items/list, but a live initialized experimental app-server call returns JSON-RPC -32601: thread/items/list is not supported yet. Generated protocol availability does not guarantee the runtime handler exists; add a capability/runtime probe or document this method as unavailable.

## 2026-07-22T06:19:22.342Z — codex — gpt-5.6-sol

- **Directory:** `/Users/safzan/Development/projects/codex-rudder`
- **Tags:** `misleading-error`

While reporting a Codex Rudder SIGTERM smoke in zsh, assigning to the ordinary-looking variable name status failed because zsh reserves it as read-only. Avoid status and path as zsh script variables; use task-specific names such as run_status and schema_file.

## 2026-07-22T06:19:54.248Z — codex — gpt-5.6-sol

- **Directory:** `/Users/safzan/Development/projects/codex-rudder`
- **Tags:** `stale-cache`

A later Codex Rudder live smoke reused a /tmp prompt path from an earlier session, but the temporary file had already been cleaned, causing the run to fail before state creation. Recreate or validate temp artifacts immediately before each smoke instead of treating /tmp paths as durable.

## 2026-07-26T08:14:33.136Z — codex — gpt-5.6-sol

- **Directory:** `/Users/safzan/Development/projects/codex-rudder`
- **Tags:** `tooling`, `github-connector`

While opening a draft PR for the private codex-rudder repository, the GitHub connector returned a 404 after an authenticated git push succeeded. The connector likely lacks access to this private repo; falling back to the authenticated gh CLI worked around it.

