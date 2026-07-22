# Codex Rudder

Live steering for long-running Codex tasks.

`codex exec --json` is observable but its stdin is already closed after the
initial prompt. Codex Rudder instead owns a `codex app-server` connection and
exposes a small local control socket. A second command can call `turn/steer`
while the same turn is still running.

```text
task launcher ──stdio JSON-RPC──> codex app-server
      │
      ├── state.json / events.jsonl / trace.log / output.md
      │
      └── local Unix socket <── rudder steer "focus on the failing test first"
```

The name is literal: Rudder does not replace the engine, model, auth provider,
or app-server. It changes the heading of an in-flight turn.

## Status

Early working prototype. The Codex app-server protocol is still experimental,
so Rudder should be verified against the installed Codex CLI after upgrades.

## Build

```bash
go build -o rudder .
```

Requires a Codex CLI with `codex app-server` and `turn/steer` support. The
current command surface is verified against `codex-cli 0.145.0`.

## Run a task

Create a self-contained prompt and a run directory:

```bash
mkdir -p .scratch/rudder-demo
$EDITOR .scratch/rudder-demo/prompt.md

./rudder run \
  --cwd "$PWD" \
  --prompt-file .scratch/rudder-demo/prompt.md \
  --state-dir .scratch/rudder-demo/run \
  --model gpt-5.6-sol \
  --sandbox workspace-write
```

Run it in the background from an agent harness so the harness can continue
reading user messages and issue steering commands.

`--turn-timeout` defaults to one hour and stops a silently hung turn and its
child process group. Set it to `0` only when an unbounded run is intentional.
`SIGINT` and `SIGTERM` mark the run interrupted, terminate the app-server
process group, and remove the control socket before Rudder exits.

Resume an existing thread for another steerable turn:

```bash
./rudder run \
  --resume-thread THREAD_ID \
  --cwd "$PWD" \
  --prompt-file .scratch/rudder-demo/prompt.md \
  --state-dir .scratch/rudder-demo/resumed-run
```

Fork first when the new work should preserve the source thread:

```bash
./rudder run \
  --fork-thread THREAD_ID \
  --fork-before-turn TURN_ID \
  --cwd "$PWD" \
  --prompt-file .scratch/rudder-demo/prompt.md \
  --state-dir .scratch/rudder-demo/forked-run
```

Use `--fork-through-turn TURN_ID` instead to include the selected turn.

## Discover and manage threads

Thread commands print the app-server result as JSON so agent skills and shell
scripts can consume pagination cursors and complete metadata without scraping
human-formatted output:

```bash
./rudder thread list --limit 20 --cwd-filter "$PWD"
./rudder thread search --limit 10 "parser regression"
./rudder thread read --include-turns THREAD_ID
./rudder thread turns --limit 20 THREAD_ID

./rudder thread fork --before-turn TURN_ID THREAD_ID
./rudder thread name THREAD_ID "Parser regression investigation"
./rudder thread archive THREAD_ID
./rudder thread unarchive THREAD_ID
```

Every thread subcommand also accepts a stdio-compatible child command after
`--`, using the same private auth-bridge composition as `rudder run`.

## Steer the active turn

```bash
./rudder steer \
  --state-dir .scratch/rudder-demo/run \
  "New information: the regression starts in parser.go. Focus there first."
```

The command fails if the turn is no longer active or the active turn ID does
not match. It never silently starts a replacement turn.

For exact multiline input:

```bash
./rudder steer --state-dir .scratch/rudder-demo/run \
  --message-file .scratch/rudder-demo/steer.md
```

## Observe and control

```bash
./rudder status --state-dir .scratch/rudder-demo/run
./rudder status --state-dir .scratch/rudder-demo/run --json
./rudder peek --state-dir .scratch/rudder-demo/run -n 40
./rudder wait --state-dir .scratch/rudder-demo/run --timeout 20m
./rudder interrupt --state-dir .scratch/rudder-demo/run
```

Run artifacts:

- `state.json` — IDs, status, paths, and timestamps; no prompt or output text.
- `events.jsonl` — raw app-server events.
- `trace.log` — compact human-readable progress.
- `output.md` — all completed `agentMessage` items in order.
- `app-server.stderr.log` — child diagnostics.

The run directory and all files are owner-only (`0700` / `0600`). The control
socket lives inside that directory when the Unix path limit permits; otherwise
Rudder creates a random owner-only temporary parent and records it in state.
The raw events, trace, and output can contain prompt, command, and completion
content. Persisted errors in `state.json` are generic; details remain in the
private trace and stderr logs.

If a process is killed without cleanup, `status` renders a non-terminal state
as `stale`, while `wait`, `steer`, and `interrupt` fail promptly instead of
polling forever or returning an opaque socket error.

## Layer over codex-auth-broker

Rudder accepts any stdio-compatible app-server command after `--`. This lets
the existing auth bridge keep ownership of OAuth refresh while Rudder adds
lifecycle and steering:

```bash
./rudder run \
  --cwd "$PWD" \
  --prompt-file .scratch/rudder-demo/prompt.md \
  --state-dir .scratch/rudder-demo/run \
  --model gpt-5.6-sol \
  --sandbox workspace-write \
  -- \
  /Users/safzan/Development/projects/codex-auth-broker-private/codex-auth-broker \
    app-server-bridge \
    -broker-auth-url http://100.121.157.57:8765/v1/codex/auth \
    -secret-file /Users/safzan/.codex/codex-auth-broker.secret
```

The process chain is:

```text
rudder
  └─ codex-auth-broker app-server-bridge
       └─ codex app-server --listen stdio://
```

Rudder never reads or persists the broker secret or Codex OAuth tokens. The
bridge consumes those and presents the same app-server JSON-RPC stream.

## Why not `codex exec resume`?

Resume adds a later turn after the current one completes. `turn/steer` appends
input to the currently in-flight regular turn, so Codex can change direction
after the current tool call and before it commits to a final answer.

Review and manual compaction turns can reject steering. `review-codex-auto`
should continue using a normal prompt-driven turn (not `review/start`) when it
needs the result to remain steerable.

## Protocol compatibility

The installed CLI can emit exact schemas for its version:

```bash
schema_dir=$(mktemp -d /tmp/codex-app-server-schema.XXXXXX)
codex app-server generate-json-schema --experimental --out "$schema_dir"
```

Rudder currently depends on:

- `initialize` then `initialized`
- `thread/start`
- `thread/list`, `thread/search`, and `thread/read`
- `thread/turns/list`
- `thread/resume` and `thread/fork`
- `thread/name/set`, `thread/archive`, and `thread/unarchive`
- `turn/start`
- `turn/steer`
- `turn/interrupt`
- `turn/started`, `item/*`, and `turn/completed` notifications

## Development

```bash
gofmt -w *.go
go test ./...
go build -o rudder .
```
