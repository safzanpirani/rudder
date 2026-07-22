# Codex Rudder agent notes

## Purpose

Codex Rudder is a small local control plane for `codex app-server`. It owns one
app-server stdio connection, persists redacted lifecycle state, streams a local
trace, and accepts same-turn steering through `turn/steer`.

It may wrap either the stock `codex app-server` command or another stdio proxy,
including `codex-auth-broker app-server-bridge`. Authentication remains the
child transport's responsibility.

## Invariants

- Use the Go standard library unless there is a strong reason not to.
- Never persist access tokens, refresh tokens, bearer secrets, or auth files.
- State files must not contain prompt or completion text.
- Transcript/event files may contain user and model content; create them with
  owner-only permissions and call that out in docs.
- Bind the control plane to a local Unix socket with owner-only permissions.
- Keep the socket parent owner-only and the encoded path at or below the
  conservative cross-platform Unix-socket limit.
- `turn/steer` must include both the active `threadId` and `expectedTurnId`.
- Do not silently turn a failed steer into a new turn.
- SIGINT, SIGTERM, and watchdog shutdown must terminate the app-server process
  group and leave a terminal persisted state.
- Keep the wrapper compatible with the installed app-server schema; verify with
  `codex app-server generate-json-schema` when protocol behavior changes.

## Verification

Before finishing changes:

```bash
gofmt -w *.go
go test ./...
go build -o rudder .
```

Do not commit the built binary or run artifacts.
