# AGENTS.md

Instructions for coding agents working in Codex Ruddr.

## Start here

Read `README.md` before changing behavior. It defines the user-facing CLI,
artifact contract, app-server composition, and supported Codex version. Inspect
`PAPERCUTS.md` for known workflow friction before debugging tooling failures.

This is a small Go control plane around `codex app-server`. Keep it thin. Ruddr
owns process lifecycle, JSON-RPC transport, persisted run state, live steering,
and thread-history operations; it does not own authentication, model behavior,
or repository business logic.

## Repository map

- `main.go` — CLI dispatch and argument parsing for `run`, `steer`, `status`,
  `peek`, `interrupt`, and `wait`.
- `runner.go` — long-lived app-server controller, handshake, thread
  start/resume/fork, turn execution, JSON-RPC correlation, event handling,
  watchdog, logs, and shutdown.
- `control.go` — private Unix-socket control plane for live steer/interrupt and
  controller-liveness checks.
- `state.go` — owner-only run directories, redacted `state.json`, stale-state
  rendering, socket-path selection, and private file helpers.
- `thread_commands.go` — short-lived app-server sessions for thread discovery,
  search, read, turn listing, fork, naming, archive, and unarchive.
- `process_unix.go`, `process_windows.go`, `process_other.go` — platform process
  setup and process-tree termination.
- `runner_test.go` — unit and integration-style tests using the in-process fake
  app-server. Extend this fake when adding protocol behavior.

## Non-negotiable invariants

- Prefer the Go standard library. Add a dependency only when its value clearly
  outweighs the maintenance and supply-chain cost.
- Never read or persist Codex OAuth tokens, broker secrets, bearer tokens,
  refresh tokens, or auth files. Authentication belongs to the child command.
- `state.json` must remain content-redacted: IDs, paths, lifecycle metadata,
  counts, timestamps, PID, and generic errors only. Prompt/completion/tool text
  belongs only in private transcript artifacts.
- Create run directories and socket parents as `0700`; content-bearing files
  and state files as `0600`. Keep the Unix socket in a private parent and below
  the conservative cross-platform path-length limit.
- Every `turn/steer` request must include both `threadId` and
  `expectedTurnId`. Never turn a rejected steer into a replacement turn.
- Signal cancellation, watchdog expiry, and explicit interrupt must terminate
  the full app-server process tree, close logs safely, remove the socket, and
  persist a terminal state.
- Bound child stdin writes and RPC calls. Do not hold `writeMu` across an
  unbounded operation.
- Preserve every completed `agentMessage` in `output.md` in arrival order.
- Treat a dead controller with non-terminal persisted state as `stale`; wait and
  control commands must fail promptly rather than poll forever.

## Thread semantics

- Fresh runs use `thread/start`.
- `--resume-thread` uses `thread/resume`, continues the source thread identity,
  sends `excludeTurns: true`, and must not send start-only fields such as
  `ephemeral` or `serviceName`.
- `--fork-thread` uses `thread/fork` and must return a new thread ID.
- `--fork-before-turn` maps only to `beforeTurnId` and excludes that turn and
  everything after it.
- `--fork-through-turn` maps only to `lastTurnId` and includes history through
  that turn.
- Resume and fork are mutually exclusive. The two fork boundary selectors are
  mutually exclusive and invalid without `--fork-thread`.
- Conversation forks do not create Git worktrees or roll filesystem state back.
- Thread subcommands print raw app-server results as formatted JSON. Do not
  replace this with presentation-oriented output; callers depend on complete
  metadata and pagination cursors.

## Protocol changes

The app-server protocol is experimental. Before changing request fields,
method names, notification handling, or response shapes, generate schemas from
the installed CLI and compare them with the implementation:

```bash
schema_dir=$(mktemp -d /tmp/codex-app-server-schema.XXXXXX)
codex app-server generate-json-schema --experimental --out "$schema_dir"
codex --version
```

Update the compatibility statement in `README.md` when support is verified
against a newer CLI. Use string JSON-RPC IDs for Ruddr-originated calls, but
continue accepting valid string or numeric response IDs from the server.
Reject server-initiated interactive requests explicitly; do not let them hang.

If the run uses a command after `--` (for example the private auth broker), the
child must remain a transparent stdio-compatible app-server. Ruddr must never
special-case or inspect its credentials.

## Development workflow

Work from the repository root. Preserve unrelated user changes. Search exact
symbols with `rg`; use `gofmt` for Go formatting. Do not commit the generated
`ruddr` binary, run directories, sockets, schema dumps, or dogfood artifacts.

After modifying Go code, run:

```bash
gofmt -w *.go
go test ./...
go vet ./...
go build -o ruddr .
git diff --check
```

The binary is ignored; remove or leave it untracked only if `.gitignore`
continues to cover it. For documentation-only changes, at minimum run
`git diff --check` and verify every command against `./ruddr --help` or the
relevant subcommand parser.

## Testing expectations

- Add a regression test for every lifecycle, persistence, protocol-field, or
  thread-boundary bug.
- Prefer asserting the JSON-RPC request observed by the fake app-server, not
  only the final CLI text.
- For run lifecycle tests, assert both the returned error and persisted terminal
  state. Where relevant, also assert socket cleanup and child termination.
- Preserve coverage for fresh, resume, fork, steer, interrupt, watchdog, stale
  state, blocked writes, temporary accept errors, redaction, and ordered output.
- Duration flags use Go duration syntax (`3600s`, `20m`, `1h`); bare integers
  must remain invalid.
- Keep tests deterministic and offline. A live Codex dogfood run is useful
  before releases but does not replace fake-server regression coverage.

## Git and release hygiene

The canonical remote is `origin` at the public GitHub repository
`safzanpirani/ruddr`; the default branch is `main`. Do not change
visibility, add collaborators, publish releases, or push tags unless the user
asks. Never commit private broker URLs, secret-file contents, session
transcripts, or local run artifacts.

Before handing off, report the files changed, exact verification commands and
results, remaining limitations, and whether changes are committed or pushed.
