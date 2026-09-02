import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactAllowsTextSelection,
  AsyncTaskGate,
  attachToolDetails,
  discoverSessions,
  emptyPromptHint,
  compactSessionDetails,
  continuationRunArguments,
  contextualHelp,
  dashboardNavigation,
  filterSessions,
  initialViewState,
  idlePromptControlArguments,
  latestAgentUpdate,
  parseTraceActivities,
  parseToolEventDetails,
  readTail,
  reduceView,
  sessionDescription,
  sessionDetails,
  statusGlyph,
  steerControlArguments,
  visibleArtifactTail,
  visibleSessions,
  formatTokenUsage,
  promptModeForSession,
  promptTargetForSession,
  resolvePromptTarget,
  modelPickerOptions,
  parseModelCatalog,
  newSessionRunArguments,
  parseDejaHits,
  parseChatTranscript,
  parseArguments,
  sessionsPanelTitle,
  FALLBACK_MODELS,
  type Session,
} from "./core";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    version: 1,
    pid: 123,
    status: "active",
    stateDir: "/tmp/run-a",
    stateFile: "/tmp/run-a/state.json",
    threadId: "thread-1234567890",
    turnId: "turn-1234567890",
    model: "gpt-test",
    startedAt: "2026-08-25T00:00:00Z",
    updatedAt: "2026-08-25T00:01:00Z",
    ...overrides,
  };
}

describe("view reducer", () => {
  test("preserves a selected session across refreshes", () => {
    const selected = { ...initialViewState, selectedStateDir: "/tmp/run-b" };
    const next = reduceView(selected, {
      type: "sessions",
      sessions: [session(), session({ stateDir: "/tmp/run-b" })],
    });
    expect(next.selectedStateDir).toBe("/tmp/run-b");
  });

  test("falls back to the first session when selection disappears", () => {
    const selected = { ...initialViewState, selectedStateDir: "/tmp/missing" };
    const next = reduceView(selected, {
      type: "sessions",
      sessions: [session()],
    });
    expect(next.selectedStateDir).toBe("/tmp/run-a");
  });

  test("tracks artifact, focus, steering, and guarded interrupt state", () => {
    let state = reduceView(initialViewState, { type: "toggle-artifact" });
    state = reduceView(state, { type: "toggle-focus" });
    state = reduceView(state, { type: "open-steer" });
    state = reduceView(state, { type: "arm-interrupt", now: 100 });
    expect(state).toMatchObject({
      artifact: "trace",
      focus: "steer",
      interruptArmedUntil: 2100,
    });
  });
});

describe("TUI layout helpers", () => {
  test("enables beta layout from either the flag or environment", () => {
    expect(parseArguments(["--rudder", "/tmp/rudder"], {}).beta).toBe(false);
    expect(
      parseArguments(["--rudder", "/tmp/rudder", "--beta"], {}).beta,
    ).toBe(true);
    expect(
      parseArguments(["--rudder", "/tmp/rudder"], {
        RUDDER_TUI_BETA: "1",
      }).beta,
    ).toBe(true);
  });

  test("routes Tab and Escape according to the selected layout", () => {
    expect(dashboardNavigation("beta", "artifact", "tab")).toBe(
      "show-sessions",
    );
    expect(dashboardNavigation("classic", "artifact", "tab")).toBe(
      "focus-sessions",
    );
    expect(dashboardNavigation("classic", "sessions", "tab")).toBe(
      "focus-artifact",
    );
    expect(dashboardNavigation("classic", "sessions", "escape")).toBe(
      "focus-artifact",
    );
  });

  test("describes persistent and overlay session navigation accurately", () => {
    expect(
      sessionsPanelTitle({
        layout: "classic",
        liveCount: 2,
        recentCount: 5,
      }),
    ).toBe(" sessions · 2 live · 5 recent ");
    expect(
      sessionsPanelTitle({
        layout: "beta",
        liveCount: 2,
        recentCount: 5,
      }),
    ).toContain("Enter open · Esc close");
    expect(
      contextualHelp({
        layout: "classic",
        focus: "sessions",
        hasQuery: false,
      }),
    ).toContain("Tab chat");
    expect(
      contextualHelp({
        layout: "beta",
        focus: "artifact",
        hasQuery: false,
        dejaAvailable: true,
      }),
    ).toContain("m model · f find");
    expect(
      contextualHelp({
        layout: "beta",
        focus: "artifact",
        hasQuery: false,
        compact: true,
      }),
    ).toContain("o tabs");
    expect(emptyPromptHint("classic")).toBe("n new session · Tab focus");
  });
});

describe("async task gate", () => {
  test("waits for an active refresh and rejects new work before teardown", async () => {
    const gate = new AsyncTaskGate();
    const active = deferred();
    let secondTaskRan = false;
    const firstRun = gate.run(() => active.promise);

    let stopped = false;
    const stopping = gate.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    await gate.run(async () => {
      secondTaskRan = true;
    });
    expect(secondTaskRan).toBe(false);

    active.resolve();
    await Promise.all([firstRun, stopping]);
    expect(stopped).toBe(true);
  });
});

describe("session discovery", () => {
  test("recurses, skips invalid state, marks dead runs stale, and sorts active first", async () => {
    const root = await mkdtemp(join(tmpdir(), "rudder-tui-discovery-"));
    const activeDir = join(root, "nested", "active");
    const staleDir = join(root, "stale");
    await mkdir(activeDir, { recursive: true });
    await mkdir(staleDir, { recursive: true });
    await writeFile(
      join(activeDir, "state.json"),
      JSON.stringify(session({ stateDir: activeDir, pid: 1 })),
    );
    await writeFile(
      join(staleDir, "state.json"),
      JSON.stringify(
        session({ stateDir: staleDir, pid: 2, status: "starting" }),
      ),
    );
    await writeFile(join(root, "state.json"), "not json");

    const sessions = await discoverSessions({
      roots: [root],
      stateDirs: [],
      registryDirs: [],
      processAlive: (pid) => pid === 1,
    });
    expect(sessions.map(({ status }) => status)).toEqual(["active", "stale"]);
    expect(sessions.every(({ provider }) => provider === "codex")).toBe(true);
    expect(sessions[1]?.error).toContain("not running");
  });

  test("discovers runs referenced by the global registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "rudder-tui-registry-"));
    const registryDir = join(root, "registry");
    const stateDir = join(root, "outside-project", "run");
    await mkdir(registryDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "state.json"),
      JSON.stringify(session({ stateDir, pid: 1 })),
    );
    await writeFile(join(registryDir, "active.run"), `${stateDir}\n`);

    const sessions = await discoverSessions({
      roots: [],
      stateDirs: [],
      registryDirs: [registryDir],
      processAlive: () => true,
    });
    expect(sessions.map(({ stateDir: discovered }) => discovered)).toEqual([
      stateDir,
    ]);
  });
});

describe("artifact and display helpers", () => {
  test("reserves native mouse text selection for the output pane", () => {
    expect(artifactAllowsTextSelection("trace")).toBe(false);
    expect(artifactAllowsTextSelection("output")).toBe(true);
  });

  test("reads only complete lines from a bounded tail", async () => {
    const root = await mkdtemp(join(tmpdir(), "rudder-tui-tail-"));
    const artifact = join(root, "trace.log");
    await writeFile(artifact, "first\nsecond\nthird\n");
    expect(await readTail(artifact, 13)).toBe("second\nthird");
  });

  test("keeps the newest artifact lines visible", () => {
    expect(visibleArtifactTail("one\ntwo\nthree\nfour", 2)).toBe("three\nfour");
  });

  test("turns raw trace lines into a compact semantic activity feed", () => {
    const activities = parseTraceActivities(
      [
        "2026-08-25T18:00:00Z [think] **Inspecting tests** **Planning fix**",
        `2026-08-25T18:00:01Z [in_progress] $ /bin/zsh -lc 'go test ./...'`,
        `2026-08-25T18:00:03Z [completed] $ /bin/zsh -lc 'go test ./...'`,
        "2026-08-25T18:00:03Z [usage] updated",
        "2026-08-25T18:00:03Z [say] Still working.",
        "2026-08-25T18:00:04Z [in_progress] file changes",
        "2026-08-25T18:00:05Z [say] Tests are green.",
        `2026-08-25T18:00:06Z [in_progress] $ /bin/zsh -lc 'rg -n "needle" very-long-path…`,
      ].join("\n"),
    );
    expect(activities).toEqual([
      {
        timestamp: "2026-08-25T18:00:00Z",
        kind: "thought",
        text: "Inspecting tests · Planning fix",
      },
      {
        timestamp: "2026-08-25T18:00:03Z",
        kind: "tool",
        label: "shell",
        text: "go test ./...",
        toolStatus: "completed",
        durationMs: 2000,
      },
      {
        timestamp: "2026-08-25T18:00:04Z",
        kind: "tool",
        label: "files",
        text: "changed",
        toolStatus: "running",
      },
      {
        timestamp: "2026-08-25T18:00:05Z",
        kind: "message",
        text: "Tests are green.",
      },
      {
        timestamp: "2026-08-25T18:00:06Z",
        kind: "tool",
        label: "shell",
        text: 'rg -n "needle" very-long-path…',
        toolStatus: "running",
      },
    ]);
  });

  test("keeps live sessions plus recent history by default", () => {
    const runs = [
      session({ stateDir: "/active", status: "active" }),
      ...Array.from({ length: 24 }, (_, index) =>
        session({ stateDir: `/history-${index}`, status: "completed" }),
      ),
    ];
    expect(visibleSessions(runs, false, [])).toHaveLength(21);
    expect(visibleSessions(runs, false, ["/history-23"])).toHaveLength(22);
    expect(visibleSessions(runs, true, [])).toHaveLength(25);
  });

  test("selects the latest full commentary update instead of the final answer", () => {
    const events = [
      "partial tail record",
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            type: "agentMessage",
            phase: "commentary",
            text: "First update",
          },
        },
      }),
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            type: "agentMessage",
            phase: "commentary",
            text: "Full latest update",
          },
        },
      }),
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            type: "agentMessage",
            phase: "final",
            text: "Long final handoff",
          },
        },
      }),
    ].join("\n");
    expect(latestAgentUpdate(events)).toBe("Full latest update");
  });

  test("joins tool lifecycle events into expandable details", () => {
    const events = [
      JSON.stringify({
        method: "item/started",
        params: {
          item: {
            id: "tool-1",
            type: "commandExecution",
            command: "go test ./...",
            cwd: "/work/parser",
            status: "inProgress",
          },
        },
      }),
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            id: "tool-1",
            type: "commandExecution",
            command: "go test ./...",
            cwd: "/work/parser",
            status: "completed",
            aggregatedOutput: "ok parser",
            exitCode: 0,
            durationMs: 1250,
          },
        },
      }),
    ].join("\n");
    expect(parseToolEventDetails(events)).toEqual([
      {
        id: "tool-1",
        type: "commandExecution",
        command: "go test ./...",
        cwd: "/work/parser",
        status: "completed",
        output: "ok parser",
        exitCode: 0,
        durationMs: 1250,
        query: undefined,
      },
    ]);
  });

  test("joins Claude generic tool updates by stable item id", () => {
    const events = [
      JSON.stringify({
        method: "item/started",
        params: {
          item: {
            id: "tool-claude",
            type: "toolCall",
            toolName: "Grep",
            input: {},
            command: "Grep",
            status: "inProgress",
          },
        },
      }),
      JSON.stringify({
        method: "item/updated",
        params: {
          item: {
            id: "tool-claude",
            type: "toolCall",
            toolName: "Grep",
            input: { pattern: "provider", path: "tui" },
            command: "Grep provider",
            status: "inProgress",
          },
        },
      }),
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            id: "tool-claude",
            type: "toolCall",
            toolName: "Grep",
            input: { pattern: "provider", path: "tui" },
            command: "Grep provider",
            aggregatedOutput: "tui/core.ts: provider",
            status: "completed",
          },
        },
      }),
    ].join("\n");
    expect(parseToolEventDetails(events)).toEqual([
      expect.objectContaining({
        id: "tool-claude",
        type: "toolCall",
        toolName: "Grep",
        input: { pattern: "provider", path: "tui" },
        status: "completed",
        output: "tui/core.ts: provider",
      }),
    ]);
  });

  test("joins sub-agent activity to the child final response", () => {
    const events = [
      JSON.stringify({
        method: "item/started",
        emittedAtMs: 1787942847416,
        params: {
          threadId: "parent-thread",
          item: {
            id: "subagent-completed-child-turn",
            type: "subAgentActivity",
            kind: "completed",
            agentThreadId: "child-thread",
            agentPath: "/root/tests_review",
          },
        },
      }),
      JSON.stringify({
        method: "item/completed",
        emittedAtMs: 1787942847000,
        params: {
          threadId: "child-thread",
          item: {
            id: "child-message",
            type: "agentMessage",
            phase: "final_answer",
            text: "Child review found no issues.",
          },
        },
      }),
      JSON.stringify({
        method: "item/completed",
        emittedAtMs: 1787942847417,
        params: {
          threadId: "parent-thread",
          item: {
            id: "subagent-completed-child-turn",
            type: "subAgentActivity",
            kind: "completed",
            agentThreadId: "child-thread",
            agentPath: "/root/tests_review",
          },
        },
      }),
      JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "child-thread",
          turn: { status: "completed", durationMs: 121565 },
        },
      }),
    ].join("\n");

    expect(parseToolEventDetails(events)).toEqual([
      expect.objectContaining({
        id: "subagent-completed-child-turn",
        type: "subAgentActivity",
        command: "/root/tests_review",
        status: "completed",
        output: "Child review found no issues.",
        durationMs: 121565,
        toolName: "subAgentActivity",
        agentThreadId: "child-thread",
        agentPath: "/root/tests_review",
        activityKind: "completed",
        timestampMs: 1787942847417,
      }),
    ]);
  });

  test("matches bounded-tail sub-agent details to the newest trace rows", () => {
    const activities = parseTraceActivities(
      [
        "2026-08-28T18:45:21Z [completed] subAgentActivity",
        "2026-08-28T18:45:25Z [completed] subAgentActivity",
        "2026-08-28T18:47:22Z [completed] subAgentActivity",
        "2026-08-28T18:47:27Z [completed] subAgentActivity",
      ].join("\n"),
    );
    const details = [
      {
        id: "interacted",
        type: "subAgentActivity",
        status: "completed" as const,
        toolName: "subAgentActivity",
        timestampMs: Date.parse("2026-08-28T18:47:22.964Z"),
      },
      {
        id: "completed",
        type: "subAgentActivity",
        status: "completed" as const,
        toolName: "subAgentActivity",
        timestampMs: Date.parse("2026-08-28T18:47:27.417Z"),
      },
    ];

    expect(
      attachToolDetails(activities, details).map((detail) => detail?.id),
    ).toEqual([undefined, undefined, "interacted", "completed"]);
  });

  test("filters sessions across project, ids, status, and model", () => {
    const runs = [
      session({
        cwd: "/work/parser",
        status: "completed",
        model: "gpt-parser",
      }),
      session({
        stateDir: "/active",
        cwd: "/work/payments",
        threadId: "thread-pay",
      }),
    ];
    expect(filterSessions(runs, "payments")).toHaveLength(1);
    expect(filterSessions(runs, "completed")).toHaveLength(1);
    expect(filterSessions(runs, "PARSER")).toHaveLength(1);
    expect(filterSessions(runs, "thread-pay")).toHaveLength(1);
  });

  test("continues a thread with its working directory and model settings", () => {
    const args = continuationRunArguments(
      session({
        cwd: "/work/parser",
        threadId: "thread-parser",
        model: "gpt-parser",
        effort: "high",
        sandbox: "danger-full-access",
      }),
      "/private/prompt.md",
      "/private/new.run",
    );
    expect(args).toEqual([
      "run",
      "--provider",
      "codex",
      "--cwd",
      "/work/parser",
      "--resume-thread",
      "thread-parser",
      "--prompt-file",
      "/private/prompt.md",
      "--state-dir",
      "/private/new.run",
      "--sandbox",
      "danger-full-access",
      "--approval-policy",
      "never",
      "--idle",
      "--model",
      "gpt-parser",
      "--effort",
      "high",
    ]);
  });

  test("continues Claude with its provider session and no invented model", () => {
    const args = continuationRunArguments(
      session({
        provider: "claude",
        cwd: "/work/claude",
        threadId: "claude-session",
        model: undefined,
      }),
      "/private/prompt.md",
      "/private/claude.run",
    );
    expect(args.slice(0, 8)).toEqual([
      "run",
      "--provider",
      "claude",
      "--cwd",
      "/work/claude",
      "--resume-thread",
      "claude-session",
      "--prompt-file",
    ]);
    expect(args).not.toContain("--model");
  });

  test("keeps statuses distinguishable without color", () => {
    expect(
      new Set(
        [
          "active",
          "starting",
          "completed",
          "failed",
          "interrupted",
          "stale",
        ].map(statusGlyph),
      ).size,
    ).toBe(6);
  });

  test("renders concise list and detail text", () => {
    const value = session({ cwd: "/work/parser", steers: 2 });
    expect(sessionDescription(value)).toContain(
      "active · turn-1234567… · gpt-test",
    );
    expect(sessionDetails(value)).toContain("cwd      /work/parser");
    expect(sessionDetails(value)).toContain("steers 2");
    expect(compactSessionDetails(value).split("\n")).toHaveLength(4);
    expect(compactSessionDetails(value)).not.toContain("thread");
  });

  test("treats Go's zero completion time as an unfinished run", () => {
    const value = session({
      startedAt: "2020-01-01T00:00:00Z",
      completedAt: "0001-01-01T00:00:00Z",
    });
    expect(sessionDetails(value)).not.toContain("runtime  0s");
  });
});

describe("promptable TUI helpers", () => {
  test("formats token usage like opencode's footer", () => {
    expect(
      formatTokenUsage({ totalTokens: 186_100, contextWindow: 1_000_000, costUsd: 0.1 }),
    ).toBe("186.1K (19%) · $0.10");
    expect(formatTokenUsage({ totalTokens: 2_400 })).toBe("2.4K");
  expect(formatTokenUsage({ totalTokens: 2_400, contextWindow: 1_000 })).toBe("2.4K (100%)");
    expect(formatTokenUsage({ totalTokens: 0 })).toBe("");
    expect(formatTokenUsage(undefined)).toBe("");
    expect(formatTokenUsage({ totalTokens: 1_500_000, costUsd: 12.345 })).toBe("1.5M · $12.35");
  });

  test("routes prompts by session status without converting", () => {
    expect(promptModeForSession(session({ status: "active" }))).toBe("steer");
    expect(promptModeForSession(session({ status: "idle" }))).toBe("prompt");
    expect(
      promptModeForSession(session({ status: "completed", threadId: "t", cwd: "/w" })),
    ).toBe("continue");
    expect(promptModeForSession(session({ status: "completed", threadId: undefined }))).toBeUndefined();
    expect(promptModeForSession(session({ status: "starting" }))).toBeUndefined();
  expect(promptModeForSession(session({ status: "stale", threadId: "t", cwd: "/w" }))).toBeUndefined();
    expect(promptModeForSession(undefined)).toBeUndefined();
  });

  test("builds distinct idle-prompt and turn-bound steer commands", () => {
    expect(idlePromptControlArguments("/run-a", "/message.md")).toEqual([
      "prompt",
      "--state-dir",
      "/run-a",
      "--message-file",
      "/message.md",
    ]);
    expect(
      steerControlArguments("/run-a", "turn-a", "/message.md"),
    ).toEqual([
      "steer",
      "--state-dir",
      "/run-a",
      "--expected-turn-id",
      "turn-a",
      "--message-file",
      "/message.md",
    ]);
  });

  test("binds an open prompt to its original compatible session", () => {
    const original = session({ stateDir: "/run-a", status: "active" });
    const other = session({ stateDir: "/run-b", status: "active" });
    const target = promptTargetForSession(original);
    expect(target).toEqual({
      stateDir: "/run-a",
      route: "steer",
      turnId: "turn-1234567890",
    });

    const refreshedOriginal = { ...original, steers: 1 };
    expect(resolvePromptTarget([other, refreshedOriginal], target!)).toBe(
      refreshedOriginal,
    );
    expect(resolvePromptTarget([other], target!)).toBeUndefined();
    expect(
      resolvePromptTarget(
        [other, { ...refreshedOriginal, status: "idle" }],
        target!,
      ),
    ).toBeUndefined();
    expect(
      resolvePromptTarget(
        [other, { ...refreshedOriginal, turnId: "turn-next" }],
        target!,
      ),
    ).toBeUndefined();
  });

  test("keeps a continuation target valid across terminal statuses", () => {
    const completed = session({
      stateDir: "/run-a",
      status: "completed",
      threadId: "thread-a",
      cwd: "/work/a",
    });
    const target = promptTargetForSession(completed)!;
    const failed = { ...completed, status: "failed" };

    expect(target.route).toBe("continue");
    expect(resolvePromptTarget([failed], target)).toBe(failed);

    const newer = Array.from({ length: 20 }, (_, index) =>
      session({
        stateDir: `/run-newer-${index}`,
        status: "completed",
        completedAt: `2026-08-26T00:${String(index).padStart(2, "0")}:00Z`,
      }),
    );
    const all = [...newer, completed];
    expect(visibleSessions(all, false, [])).not.toContain(completed);
    expect(resolvePromptTarget(all, target)).toBe(completed);
  });

  test("distinguishes the idle glyph and ranks idle sessions live", () => {
    expect(statusGlyph("idle")).toBe("◌");
    const shown = visibleSessions([session({ status: "idle" })], false, [], 0);
    expect(shown).toHaveLength(1);
  });

  test("builds picker options for OpenCode and Pi", () => {
    const options = modelPickerOptions(FALLBACK_MODELS);
    expect(options[0].value).toBe("codex/gpt-5.6-sol");
    expect(options[0].name).toContain("*");
    const fable51 = options.find((option) => option.value === "claude/claude-fable-5-1");
    const opencode = options.find((option) => option.model.provider === "opencode");
    const pi = options.find((option) => option.model.provider === "pi");
    expect(fable51?.name).toBe("Claude Fable 5.1");
    expect(fable51?.disabled).toBe(false);
    expect(opencode?.disabled).toBe(false);
    expect(pi?.disabled).toBe(false);
    expect(pi?.model.efforts).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  test("falls back to the embedded catalog on bad JSON", () => {
    expect(parseModelCatalog("not json")).toBe(FALLBACK_MODELS);
    expect(parseModelCatalog("[]")).toBe(FALLBACK_MODELS);
    const parsed = parseModelCatalog(
      JSON.stringify([{ provider: "codex", id: "gpt-x", available: true }]),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("gpt-x");
  });

  test("new session arguments always run idle", () => {
    const args = newSessionRunArguments({
      provider: "claude",
      model: "claude-fable-5",
      cwd: "/work/app",
      promptFile: "/tmp/p.md",
      stateDirectory: "/tmp/run",
    });
    expect(args).toContain("--idle");
    expect(args.slice(0, 3)).toEqual(["run", "--provider", "claude"]);
    expect(args).toContain("claude-fable-5");
    const resumed = newSessionRunArguments({
      provider: "codex",
      cwd: "/w",
      promptFile: "/p",
      stateDirectory: "/s",
      resumeThreadId: "session-9",
    });
    expect(resumed).toContain("--resume-thread");
    expect(resumed).toContain("session-9");
  });

  test("continuations now run idle and accept model overrides", () => {
    const args = continuationRunArguments(
      session({ threadId: "t-1", cwd: "/w", model: "gpt-test" }),
      "/tmp/p.md",
      "/tmp/run",
      { model: "gpt-5.6-terra" },
    );
    expect(args).toContain("--idle");
    expect(args).toContain("gpt-5.6-terra");
    expect(args).not.toContain("gpt-test");
  });

  test("parses deja hits into resumable sessions", () => {
    const json = JSON.stringify({
      hits: [
        { resume: "codex resume abc-123", project: "app", date: "2026-08-29", openingPrompt: "fix the bug" },
        { resume: "claude --resume def-456", project: "web", date: "2026-08-28", openingPrompt: "add tests" },
        { project: "no-resume" },
        { resume: "pi something else" },
      ],
    });
    const hits = parseDejaHits(json);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ provider: "codex", sessionId: "abc-123", project: "app" });
    expect(hits[1]).toMatchObject({ provider: "claude", sessionId: "def-456" });
    expect(parseDejaHits("broken")).toEqual([]);
  });

  test("builds a chat transcript from events.jsonl", () => {
    const lines = [
      { method: "item/completed", params: { threadId: "root", item: { type: "userMessage", origin: "rudder", text: "do the thing" } } },
      { method: "item/started", params: { threadId: "root", item: { id: "cmd-1", type: "commandExecution", command: "bun test" } } },
      { method: "item/completed", params: { threadId: "root", item: { id: "cmd-1", type: "commandExecution", command: "bun test", exitCode: 0 } } },
      { method: "item/completed", params: { threadId: "sub", item: { id: "sub-1", type: "commandExecution", command: "hidden" } } },
      { method: "item/completed", params: { threadId: "root", item: { type: "agentMessage", text: "done" } } },
      { method: "item/completed", params: { threadId: "root", item: { type: "userMessage", origin: "rudder", text: "now this" } } },
      { method: "item/completed", params: { threadId: "root", item: { id: "prompt-rejected", type: "userMessage", origin: "rudder", text: "do not show" } } },
      { method: "rudder/prompt/rejected", params: { promptId: "prompt-rejected" } },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n");
    const entries = parseChatTranscript(lines);
    expect(entries.map((entry) => entry.kind)).toEqual(["user", "tool", "agent", "user"]);
    expect(entries[1]).toMatchObject({ text: "bun test", status: "completed" });
    expect(entries.some((entry) => entry.text === "hidden")).toBe(false);
  });

  test("filters old transcripts by the selected root thread", () => {
  const lines = [
    { method: "item/completed", params: { threadId: "sub", item: { type: "agentMessage", text: "hidden" } } },
    { method: "item/completed", params: { threadId: "root", item: { type: "agentMessage", text: "visible" } } },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n");
  expect(parseChatTranscript(lines, "root").map((entry) => entry.text)).toEqual(["visible"]);
  });
});
