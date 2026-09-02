---
name: ruddr-delegate
description: Delegate a hard, stuck, or context-heavy implementation task to a live-steerable Codex or Claude Code session managed by Ruddr, so a sub-agent investigates, edits, and verifies the current workspace end to end while the parent agent keeps working and can steer mid-turn. Use when the user asks to hand work to codex/claude/a sub-agent, when a bug or feature has resisted a couple of attempts, or when long autonomous work should run outside the parent agent's context.
metadata:
  short-description: Delegate work to a steerable Ruddr sub-agent
---

# ruddr-delegate

Package the problem into a self-contained brief, then run it through a Ruddr
sub-agent session so the provider investigates and *implements* the fix. This
is delegation, not review: the run should end with working, verified code. The
parent agent stays free to keep talking to the user and can redirect the run
mid-turn with `ruddr steer`.

Requires the `ruddr` CLI (see the repo's README "Agent setup guide" if it is
not installed).

## Pick a provider and model

- `--provider codex` (the default) runs a Codex app-server session. Use it when
  the user says "codex", or when work should run on the Codex quota instead of
  the parent agent's.
- `--provider claude` runs Claude Code through Ruddr's adapter. Use it when
  the user says "claude", or for a clean-context second Claude.

List valid models and reasoning efforts with `ruddr models --json` and pass an
explicit `--model` (add `--effort high` for genuinely subtle problems). Honor
an explicit user choice; otherwise the provider's default is fine.

Claude only: if the bare `claude` binary cannot reach its credentials from a
detached process, pass the wrapper that works interactively via
`--claude-path` or `RUDDR_CLAUDE_PATH`. Never put tokens in argv or prompts.

## Build the brief

The sub-agent has none of the parent conversation, so the prompt file must
stand alone:

1. The concrete goal and completion condition, in one or two lines.
2. What has already been tried and why it failed — real error output, stack
   traces, and failing test names verbatim, never paraphrased.
3. The load-bearing files: exact paths and, where known, functions/lines.
4. The exact reproduction and verification commands.
5. Project constraints from `AGENTS.md`, `CLAUDE.md`, `README.md`, or `docs/`
   that the sub-agent cannot infer from the diff.
6. Scope fences: what to touch, what is explicitly off-limits, and any
   unrelated dirty changes to preserve.

Tell it to investigate before editing, implement directly, run the verify
commands and iterate until they pass, and mark genuinely uncertain behavioral
choices with a `// TODO(subagent):` marker instead of guessing. Then append
this block verbatim:

```text
Work autonomously to completion — do not stop to ask me for confirmation mid-task. Investigate, implement the fix directly in the files, then run the verify command(s) above and iterate until they pass (or until you've hit a genuine blocker).

At the very end, print a **"Handoff report"**:
- What the root cause turned out to be (one or two lines).
- Changes applied, grouped by file, one line each on what and why.
- Verification: the exact command you ran and its result (passed / still failing + the remaining error).
- Anything you deliberately did NOT do, with why (uncertain / behavioral / out of scope), and any follow-up the human must run (regenerate types, set env var, rerun migration, etc.).
```

## Launch

> **Dirty-tree guard:** run `git status -sb` first; if the tree has
> uncommitted changes, snapshot a baseline (`git diff > <fixed path>` or
> `git stash create`) so the sub-agent's edits stay attributable. Use a
> separate `git worktree` for risky or competing approaches.

> **Fixed literal paths only.** Each shell tool call is a fresh shell, so a
> variable set in one call is empty in the next. Pick stable paths (for
> example under `.scratch/<task-slug>/`) and reuse them verbatim. Never reuse
> a previous run's state dir.

```bash
ruddr run \
  --provider codex \
  --cwd "$PWD" \
  --prompt-file .scratch/<task-slug>/brief.md \
  --state-dir .scratch/<task-slug>/run \
  --sandbox workspace-write
```

- Launch with the harness's background facility — a foreground tool call gets
  killed at the tool timeout, taking the controller with it. If the harness
  has no background mode, detach explicitly:
  `nohup ruddr run ... > run.log 2>&1 < /dev/null &`.
- `--sandbox workspace-write` is the safe default. Escalate to
  `danger-full-access` only when the task genuinely needs network or
  out-of-workspace access and the user's policy allows it; use `read-only`
  for an advisory consult where edits are unwanted (and say so in the brief).
- `--turn-timeout` defaults to one hour per turn.
- Expecting follow-up turns? Add `--idle` and send later turns with
  `ruddr prompt --state-dir DIR "next task"`; end the session with
  `ruddr stop --state-dir DIR`. Prompt (new turn) and steer (redirect the
  current turn) are different commands — never substitute one for the other.

## Monitor and steer

```bash
ruddr peek --state-dir .scratch/<task-slug>/run -n 25     # live trace
ruddr status --state-dir .scratch/<task-slug>/run --json  # machine-readable
ruddr tui                                                 # every session, live
```

When the user adds context, corrects a premise, or changes priority while the
turn is active, forward it immediately into the same turn:

```bash
ruddr steer --state-dir .scratch/<task-slug>/run "<exact update, literals preserved>"
```

Use `--message-file` for multiline or shell-sensitive text. A rejected steer
means the turn already ended — read the output; never silently start a
replacement run. To abort a wrong-premise turn use `ruddr interrupt`, not
kill. If `status` reports `stale`, the controller died: report it and start
fresh only with the user's go-ahead.

Wedge check: if `status` says `active` but `trace.log` has been silent far
longer than the work plausibly takes, interrupt and resume the same thread
with a brief that says what it already learned.

## Wait and verify

```bash
ruddr wait --state-dir .scratch/<task-slug>/run --timeout 1h
ruddr status --state-dir .scratch/<task-slug>/run --json
```

Always bound the wait. Trust `output.md` only when status is `completed`; on
`failed`/`interrupted`/`stale` report the error field instead — partial output
is not a successful handoff. Then verify independently: run the verify
command(s) yourself and cross-check claimed edits against the pre-run
baseline. Report the run/output paths, the Handoff report, the verification
evidence, and whether changes are local, committed, or pushed.

## Continue past work

Within one parent session: steer the active run; resume a terminal one for a
direct follow-up; otherwise start fresh.

```bash
ruddr run --resume-thread THREAD_ID ...   # threadId from ruddr status --json
ruddr run --fork-thread THREAD_ID ...     # branch, preserving the original
```

Codex threads are also discoverable: `ruddr thread list --cwd-filter "$PWD"`,
`ruddr thread search "keywords"`, `ruddr thread read --include-turns ID` —
verify the candidate's `cwd` and content before resuming, and never resume or
fork a thread whose turn is still active. Claude sessions resume by
`--resume-thread` with the session ID from `ruddr status --json` only; the
`thread` discovery/fork commands are Codex-specific. A resumed brief should
state what changed since the previous turn, not restate the whole task.

## Fallback

If `ruddr` is missing, fall back to the provider's own headless mode
(`codex exec --json ... < brief.md`, or `claude -p ... < brief.md`), noting to
the user that the run will not be steerable. If the provider CLI is missing
too, output the brief and say what was unavailable.
