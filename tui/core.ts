import { open, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface RunState {
  version: number;
  provider?: "codex" | "claude" | "opencode" | "pi";
  pid: number;
  childPid?: number;
  status: string;
  threadId?: string;
  turnId?: string;
  model?: string;
  effort?: string;
  cwd?: string;
  sandbox?: string;
  stateDir: string;
  socketPath?: string;
  eventsPath?: string;
  tracePath?: string;
  outputPath?: string;
  steers?: number;
  idle?: boolean;
  turns?: number;
  tokenUsage?: TokenUsage;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface TokenUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  contextWindow?: number;
  costUsd?: number;
}

export interface Session extends RunState {
  stateFile: string;
}

export type TraceActivityKind =
  "thought" | "tool" | "message" | "warning" | "error" | "status";
export type ToolActivityStatus = "running" | "completed" | "failed";

export interface TraceActivity {
  timestamp: string;
  kind: TraceActivityKind;
  text: string;
  label?: string;
  toolStatus?: ToolActivityStatus;
  durationMs?: number;
}

export interface ToolEventDetail {
  id: string;
  type: string;
  command?: string;
  cwd?: string;
  status: ToolActivityStatus;
  output?: string;
  exitCode?: number;
  durationMs?: number;
  query?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  agentThreadId?: string;
  agentPath?: string;
  activityKind?: string;
  timestampMs?: number;
}

export interface DiscoverOptions {
  roots: string[];
  stateDirs: string[];
  registryDirs?: string[];
  processAlive?: (pid: number) => boolean;
}

export type Artifact = "chat" | "trace" | "output";

export function artifactAllowsTextSelection(artifact: Artifact): boolean {
  return artifact === "output";
}

export function nextArtifact(artifact: Artifact): Artifact {
  return artifact === "chat" ? "trace" : artifact === "trace" ? "output" : "chat";
}
export type Focus = "sessions" | "artifact" | "steer";
export type TUILayout = "classic" | "beta";

export interface TUIArguments {
  rudder: string;
  roots: string[];
  stateDirs: string[];
  interval: number;
  includeAll: boolean;
  theme?: string;
  beta: boolean;
}

export interface ViewState {
  selectedStateDir?: string;
  artifact: Artifact;
  focus: Focus;
  interruptArmedUntil: number;
}

export type ViewEvent =
  | { type: "sessions"; sessions: Session[] }
  | { type: "select"; stateDir?: string }
  | { type: "toggle-artifact" }
  | { type: "toggle-focus" }
  | { type: "open-steer" }
  | { type: "close-steer" }
  | { type: "arm-interrupt"; now: number }
  | { type: "clear-interrupt" };

export const initialViewState: ViewState = {
  artifact: "chat",
  focus: "sessions",
  interruptArmedUntil: 0,
};

export function parseArguments(
  argv: string[],
  environment: Record<string, string | undefined> = process.env,
): TUIArguments {
  const roots: string[] = [];
  const stateDirs: string[] = [];
  let rudder = "";
  let interval = 500;
  let includeAll = false;
  let theme: string | undefined;
  let beta = environment.RUDDER_TUI_BETA === "1";
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (
      (argument === "--rudder" ||
        argument === "--root" ||
        argument === "--state-dir" ||
        argument === "--interval" ||
        argument === "--theme") &&
      !value
    )
      throw new Error(`${argument} requires a value`);
    if (argument === "--rudder") {
      rudder = value;
      index++;
    } else if (argument === "--root") {
      roots.push(value);
      index++;
    } else if (argument === "--state-dir") {
      stateDirs.push(value);
      index++;
    } else if (argument === "--interval") {
      interval = parseInterval(value);
      index++;
    } else if (argument === "--theme") {
      theme = value;
      index++;
    } else if (argument === "--all") includeAll = true;
    else if (argument === "--beta") beta = true;
    else throw new Error(`unknown TUI argument ${argument}`);
  }
  if (!rudder)
    throw new Error("--rudder is required (launch the TUI through rudder tui)");
  if (roots.length === 0 && stateDirs.length === 0)
    roots.push(join(process.cwd(), ".scratch"));
  return { rudder, roots, stateDirs, interval, includeAll, theme, beta };
}

function parseInterval(value: string): number {
  const match = /^(\d+)(ms|s)$/.exec(value);
  if (!match)
    throw new Error(
      "--interval must use milliseconds or seconds, for example 500ms or 2s",
    );
  const amount = Number(match[1]);
  const milliseconds = match[2] === "s" ? amount * 1_000 : amount;
  if (milliseconds < 100) throw new Error("--interval must be at least 100ms");
  return milliseconds;
}

export type DashboardNavigation =
  | "show-sessions"
  | "focus-sessions"
  | "focus-artifact";

export function dashboardNavigation(
  layout: TUILayout,
  focus: Focus,
  key: string,
): DashboardNavigation | undefined {
  if (key === "tab") {
    if (layout === "beta") return "show-sessions";
    return focus === "sessions" ? "focus-artifact" : "focus-sessions";
  }
  if (layout === "classic" && key === "escape" && focus === "sessions")
    return "focus-artifact";
  return undefined;
}

export function sessionsPanelTitle(options: {
  layout: TUILayout;
  liveCount: number;
  recentCount: number;
  query?: string;
}): string {
  const filterSuffix =
    options.layout === "beta" && options.query ? ` · /${options.query}` : "";
  const actions =
    options.layout === "beta" ? " · Enter open · Esc close" : "";
  return ` sessions · ${options.liveCount} live · ${options.recentCount} recent${filterSuffix}${actions} `;
}

export function emptyPromptHint(layout: TUILayout): string {
  return layout === "classic"
    ? "n new session · Tab focus"
    : "n new session · Tab sessions";
}

export function contextualHelp(options: {
  layout: TUILayout;
  focus: Focus;
  session?: Pick<Session, "status">;
  hasQuery: boolean;
  dejaAvailable?: boolean;
  compact?: boolean;
}): string {
  if (options.focus === "sessions") {
    return options.layout === "classic"
      ? "j/k select · / filter · Tab chat · Esc chat"
      : "j/k select · / filter · Enter open · Esc close";
  }
  const matches = options.hasQuery ? " · n/N matches" : "";
  const stoppable =
    options.session?.status === "active" || options.session?.status === "idle";
  const tab = options.layout === "classic" ? "Tab focus" : "Tab sessions";
  const stop = stoppable ? " · x x" : "";
  if (options.compact)
    return `s prompt · n new · o tabs${matches}${stop} · ${tab} · q quit`;
  const find = options.dejaAvailable ? " · f find" : "";
  const action = stoppable ? " · x x stop" : "";
  return `s prompt · n new · m model${find}${matches}${action} · ${tab} · q quit`;
}

export class AsyncTaskGate {
  private active?: Promise<void>;
  private stopping = false;

  run(task: () => Promise<void>): Promise<void> {
    if (this.stopping || this.active) return Promise.resolve();
    const active = Promise.resolve()
      .then(task)
      .finally(() => {
        if (this.active === active) this.active = undefined;
      });
    this.active = active;
    return active;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.active;
  }
}

export function reduceView(state: ViewState, event: ViewEvent): ViewState {
  switch (event.type) {
    case "sessions": {
      const selectedExists = event.sessions.some(
        (session) => session.stateDir === state.selectedStateDir,
      );
      return {
        ...state,
        selectedStateDir: selectedExists
          ? state.selectedStateDir
          : event.sessions[0]?.stateDir,
      };
    }
    case "select":
      return {
        ...state,
        selectedStateDir: event.stateDir,
        interruptArmedUntil: 0,
      };
    case "toggle-artifact":
      return { ...state, artifact: nextArtifact(state.artifact) };
    case "toggle-focus":
      return {
        ...state,
        focus: state.focus === "artifact" ? "sessions" : "artifact",
      };
    case "open-steer":
      return { ...state, focus: "steer", interruptArmedUntil: 0 };
    case "close-steer":
      return { ...state, focus: "sessions" };
    case "arm-interrupt":
      return { ...state, interruptArmedUntil: event.now + 2_000 };
    case "clear-interrupt":
      return { ...state, interruptArmedUntil: 0 };
  }
}

export async function discoverSessions(
  options: DiscoverOptions,
): Promise<Session[]> {
  const stateFiles = new Set<string>();
  for (const stateDir of options.stateDirs) {
    stateFiles.add(resolve(stateDir, "state.json"));
  }
  for (const root of options.roots) {
    await collectStateFiles(resolve(root), stateFiles);
  }
  for (const registryDir of options.registryDirs ?? defaultRegistryDirectories()) {
    for (const stateDir of await readRegisteredStateDirs(registryDir)) {
      stateFiles.add(resolve(stateDir, "state.json"));
    }
  }

  const sessions = (
    await Promise.all(
      [...stateFiles].map(async (stateFile) => {
        try {
          const parsed = JSON.parse(
            await readFile(stateFile, "utf8"),
          ) as RunState;
          if (
            !parsed.stateDir ||
            typeof parsed.pid !== "number" ||
            typeof parsed.status !== "string"
          )
            return undefined;
          parsed.provider ??= "codex";
          const alive = options.processAlive ?? defaultProcessAlive;
          if (!isTerminalStatus(parsed.status) && !alive(parsed.pid)) {
            parsed.status = "stale";
            parsed.error = `Rudder pid ${parsed.pid} is not running; persisted state is stale`;
          }
          return { ...parsed, stateFile } satisfies Session;
        } catch {
          return undefined;
        }
      }),
    )
  ).filter((session): session is Session => session !== undefined);

  return sessions.sort(compareSessions);
}

async function readRegisteredStateDirs(registryDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(registryDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const paths = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".run"))
      .map(async (entry) => {
        try {
          return (await readFile(join(registryDir, entry.name), "utf8")).trim();
        } catch {
          return "";
        }
      }),
  );
  return paths.filter(Boolean);
}

function defaultRegistryDirectories(): string[] {
  if (process.env.RUDDER_REGISTRY_DIR)
    return [resolve(process.env.RUDDER_REGISTRY_DIR)];
  if (process.env.CODEX_RUDDER_REGISTRY_DIR)
    return [resolve(process.env.CODEX_RUDDER_REGISTRY_DIR)];
  const stateHome =
    process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return [
    join(stateHome, "rudder", "runs"),
    join(stateHome, "codex-rudder", "runs"),
  ];
}

async function collectStateFiles(
  directory: string,
  results: Set<string>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.isSymbolicLink()) return;
      const entryPath = join(directory, entry.name);
      if (entry.isFile() && entry.name === "state.json") {
        results.add(entryPath);
      } else if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) {
        await collectStateFiles(entryPath, results);
      }
    }),
  );
}

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

function defaultProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function isTerminalStatus(status: string): boolean {
  return (
    status === "completed" || status === "failed" || status === "interrupted"
  );
}

function compareSessions(left: Session, right: Session): number {
  const rank = (status: string) =>
    status === "active"
      ? 0
      : status === "idle"
        ? 1
        : status === "starting"
          ? 2
          : status === "stale"
            ? 4
            : 3;
  const byRank = rank(left.status) - rank(right.status);
  if (byRank !== 0) return byRank;
  return Date.parse(right.updatedAt ?? "") - Date.parse(left.updatedAt ?? "");
}

export async function readTail(
  path: string | undefined,
  maxBytes = 128 * 1024,
): Promise<string> {
  if (!path) return "";
  let handle;
  try {
    handle = await open(path, "r");
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const readStart = Math.max(0, start - 1);
    const buffer = Buffer.alloc(size - readStart);
    await handle.read(buffer, 0, buffer.length, readStart);
    const startsOnLineBoundary = start === 0 || buffer[0] === 0x0a;
    let text = buffer.subarray(start === 0 ? 0 : 1).toString("utf8");
    if (!startsOnLineBoundary) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : text;
    }
    return text.trimEnd();
  } catch {
    return "";
  } finally {
    await handle?.close();
  }
}

export function visibleArtifactTail(content: string, maxLines: number): string {
  if (maxLines <= 0) return "";
  return content.split("\n").slice(-maxLines).join("\n");
}

export function parseTraceActivities(content: string): TraceActivity[] {
  const activities: TraceActivity[] = [];
  for (const line of content.split("\n")) {
    const match = /^(\S+) \[([^\]]+)\](?: (.*))?$/.exec(line);
    if (!match) continue;
    const [, timestamp, tag, rawText = ""] = match;
    if (tag === "usage") continue;
    if (tag === "think") {
      const text = cleanThought(rawText);
      if (text) activities.push({ timestamp, kind: "thought", text });
      continue;
    }
    if (tag === "say") {
      if (rawText)
        activities.push({ timestamp, kind: "message", text: rawText });
      continue;
    }
    if (tag === "in_progress" || tag === "completed" || tag === "failed") {
      const toolStatus: ToolActivityStatus =
        tag === "in_progress"
          ? "running"
          : tag === "completed"
            ? "completed"
            : "failed";
      const tool = parseTool(rawText);
      if (toolStatus !== "running") {
        const runningIndex = activities.findLastIndex(
          (activity) =>
            activity.kind === "tool" &&
            activity.toolStatus === "running" &&
            activity.label === tool.label &&
            activity.text === tool.text,
        );
        if (runningIndex >= 0) {
          const started = Date.parse(activities[runningIndex].timestamp);
          const finished = Date.parse(timestamp);
          activities[runningIndex] = {
            timestamp,
            kind: "tool",
            label: tool.label,
            text: tool.text,
            toolStatus,
            durationMs:
              Number.isFinite(started) && Number.isFinite(finished)
                ? Math.max(0, finished - started)
                : undefined,
          };
          continue;
        }
      }
      activities.push({
        timestamp,
        kind: "tool",
        label: tool.label,
        text: tool.text,
        toolStatus,
      });
      continue;
    }
    if (tag === "warn") {
      activities.push({ timestamp, kind: "warning", text: rawText });
    } else if (tag === "error") {
      activities.push({ timestamp, kind: "error", text: rawText });
    } else {
      activities.push({ timestamp, kind: "status", label: tag, text: rawText });
    }
  }
  const latestMessage = activities.findLastIndex(
    (activity) => activity.kind === "message",
  );
  return activities.filter(
    (activity, index) => activity.kind !== "message" || index === latestMessage,
  );
}

export function visibleSessions(
  sessions: Session[],
  includeAll: boolean,
  explicitStateDirs: string[],
  historyLimit = 20,
): Session[] {
  if (includeAll) return sessions;
  const explicit = new Set(explicitStateDirs);
  let historyCount = 0;
  return sessions.filter((session) => {
    const live =
      session.status === "active" ||
      session.status === "idle" ||
      session.status === "starting";
    if (live || explicit.has(session.stateDir)) return true;
    if (historyCount >= historyLimit) return false;
    historyCount++;
    return true;
  });
}

export function latestAgentUpdate(content: string): string | undefined {
  let latest: string | undefined;
  for (const line of content.split("\n")) {
    try {
      const event = JSON.parse(line) as {
        method?: string;
        params?: { item?: { type?: string; phase?: string; text?: string } };
      };
      const item = event.params?.item;
      if (
        event.method === "item/completed" &&
        item?.type === "agentMessage" &&
        item.phase === "commentary" &&
        item.text
      ) {
        latest = item.text;
      }
    } catch {
      // A bounded tail may begin in the middle of a JSONL record.
    }
  }
  return latest;
}

export function parseToolEventDetails(content: string): ToolEventDetail[] {
  const byID = new Map<string, ToolEventDetail>();
  const order: string[] = [];
  const messagesByThread = new Map<string, string>();
  const turnsByThread = new Map<
    string,
    { status?: string; durationMs?: number }
  >();
  for (const line of content.split("\n")) {
    try {
      const event = JSON.parse(line) as {
        method?: string;
        emittedAtMs?: number;
        params?: {
          threadId?: string;
          turn?: { status?: string; durationMs?: number };
          item?: {
            id?: string;
            type?: string;
            text?: string;
            command?: string;
            cwd?: string;
            status?: string;
            aggregatedOutput?: string;
            exitCode?: number;
            durationMs?: number;
            query?: string;
            toolName?: string;
            input?: Record<string, unknown>;
            agentThreadId?: string;
            agentPath?: string;
            kind?: string;
          };
        };
      };
      const item = event.params?.item;
      const threadId = event.params?.threadId;
      if (
        event.method === "item/completed" &&
        item?.type === "agentMessage" &&
        item.text &&
        threadId
      )
        messagesByThread.set(threadId, item.text);
      if (event.method === "turn/completed" && threadId)
        turnsByThread.set(threadId, event.params?.turn ?? {});
      if (!item?.id || !item.type || !event.method?.startsWith("item/"))
        continue;
      if (
        item.type !== "commandExecution" &&
        item.type !== "webSearch" &&
        item.type !== "fileChange" &&
        item.type !== "toolCall" &&
        item.type !== "subAgentActivity"
      )
        continue;
      const previous = byID.get(item.id);
      if (!previous) order.push(item.id);
      const eventStatus =
        event.method === "item/started"
          ? "running"
          : event.method === "item/updated" && item.status === "inProgress"
            ? "running"
          : item.status === "failed" ||
              (item.exitCode !== undefined && item.exitCode !== 0)
            ? "failed"
            : "completed";
      byID.set(item.id, {
        ...previous,
        id: item.id,
        type: item.type,
        command:
          item.command ??
          (item.type === "subAgentActivity" ? item.agentPath : undefined) ??
          previous?.command,
        cwd: item.cwd ?? previous?.cwd,
        status: eventStatus,
        output: item.aggregatedOutput ?? previous?.output,
        exitCode: item.exitCode ?? previous?.exitCode,
        durationMs: item.durationMs ?? previous?.durationMs,
        query: item.query ?? previous?.query,
        toolName:
          item.toolName ??
          (item.type === "subAgentActivity" ? "subAgentActivity" : undefined) ??
          previous?.toolName,
        input: item.input ?? previous?.input,
        agentThreadId: item.agentThreadId ?? previous?.agentThreadId,
        agentPath: item.agentPath ?? previous?.agentPath,
        activityKind: item.kind ?? previous?.activityKind,
        timestampMs: event.emittedAtMs ?? previous?.timestampMs,
      });
    } catch {
      // A bounded tail may begin in the middle of a JSONL record.
    }
  }
  for (const detail of byID.values()) {
    if (detail.type !== "subAgentActivity" || !detail.agentThreadId) continue;
    detail.output = messagesByThread.get(detail.agentThreadId) ?? detail.output;
    const turn = turnsByThread.get(detail.agentThreadId);
    detail.durationMs = turn?.durationMs ?? detail.durationMs;
    if (turn?.status)
      detail.status = turn.status === "completed" ? "completed" : "failed";
  }
  return order.flatMap((id) => {
    const detail = byID.get(id);
    return detail ? [detail] : [];
  });
}

export function attachToolDetails(
  activities: TraceActivity[],
  details: ToolEventDetail[],
): Array<ToolEventDetail | undefined> {
  const used = new Set<string>();
  return activities.map((activity) => {
    if (activity.kind !== "tool") return undefined;
    const summary = activity.text.replace(/…$/, "").toLocaleLowerCase();
    const candidates = details.filter((detail) => {
      if (used.has(detail.id)) return false;
      const text =
        `${detail.command || ""} ${detail.query || ""} ${detail.toolName || ""}`.toLocaleLowerCase();
      if (summary && (text.includes(summary) || summary.includes(text.trim())))
        return true;
      if (activity.label === "files") return detail.type === "fileChange";
      if (activity.label?.toLocaleLowerCase().includes("websearch"))
        return detail.type === "webSearch";
      if (activity.label?.toLocaleLowerCase() === "subagentactivity")
        return detail.type === "subAgentActivity";
      return activity.label === "shell" && detail.type === "commandExecution";
    });
    let match = candidates[0];
    if (activity.label?.toLocaleLowerCase() === "subagentactivity") {
      const activityTime = Date.parse(activity.timestamp);
      match = candidates
        .filter(
          (detail) =>
            Number.isFinite(activityTime) &&
            detail.timestampMs !== undefined &&
            Math.abs(detail.timestampMs - activityTime) < 2_000,
        )
        .sort(
          (left, right) =>
            Math.abs(left.timestampMs! - activityTime) -
            Math.abs(right.timestampMs! - activityTime),
        )[0];
    }
    if (match) used.add(match.id);
    return match;
  });
}

export type ChatEntryKind = "user" | "agent" | "tool" | "thought";

export interface ChatEntry {
  kind: ChatEntryKind;
  text: string;
  status?: ToolActivityStatus;
  itemId?: string;
}

// Builds a conversation transcript from events.jsonl: the user's prompts
// (synthetic userMessage items written by the controller), agent messages,
// and compact one-line tool entries.
export function parseChatTranscript(
  content: string,
  rootThreadId?: string,
): ChatEntry[] {
  const entries: ChatEntry[] = [];
  const toolIndexById = new Map<string, number>();
  const rejectedPromptIds = new Set<string>();
  const rootThreads = new Set<string>(rootThreadId ? [rootThreadId] : []);
  for (const line of content.split("\n")) {
    try {
      const event = JSON.parse(line) as {
        method?: string;
        params?: {
          threadId?: string;
          promptId?: string;
          item?: {
            id?: string;
            type?: string;
            text?: string;
            command?: string;
            status?: string;
            summary?: unknown;
            toolName?: string;
            query?: string;
            exitCode?: number;
            origin?: string;
          };
        };
      };
      if (
        event.method === "rudder/prompt/rejected" &&
        event.params?.promptId
      ) {
        rejectedPromptIds.add(event.params.promptId);
        continue;
      }
      const item = event.params?.item;
      const threadId = event.params?.threadId;
      if (item?.type === "userMessage" && item.origin === "rudder" && threadId)
        rootThreads.add(threadId);
      if (!item?.type || !event.method?.startsWith("item/")) continue;
      // Sub-agent items carry a different threadId; keep the root conversation.
      if (threadId && rootThreads.size > 0 && !rootThreads.has(threadId))
        continue;
      if (item.type === "userMessage") {
        const text = item.text?.trim();
        if (event.method === "item/completed" && text)
          entries.push({ kind: "user", text, itemId: item.id });
        continue;
      }
      if (item.type === "agentMessage") {
        const text = item.text?.trim();
        if (event.method === "item/completed" && text)
          entries.push({ kind: "agent", text });
        continue;
      }
      if (item.type === "reasoning") {
        if (event.method === "item/completed") {
          const text = cleanThought(flattenSummary(item.summary));
          if (text) entries.push({ kind: "thought", text });
        }
        continue;
      }
      if (
        item.type === "commandExecution" ||
        item.type === "fileChange" ||
        item.type === "webSearch" ||
        item.type === "toolCall" ||
        item.type === "subAgentActivity"
      ) {
        if (!item.id) continue;
        const rawLabel =
          item.command ||
          item.query ||
          item.toolName ||
          (item.type === "fileChange" ? "file changes" : item.type);
        const flat = rawLabel.split(/\s+/).join(" ").trim();
        const label = flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
        const status: ToolActivityStatus =
          event.method === "item/started"
            ? "running"
            : item.status === "failed" ||
                (item.exitCode !== undefined && item.exitCode !== 0)
              ? "failed"
              : event.method === "item/completed"
                ? "completed"
                : "running";
        const existing = toolIndexById.get(item.id);
        const entry: ChatEntry = {
          kind: "tool",
          text: label,
          status,
          itemId: item.id,
        };
        if (existing !== undefined) entries[existing] = entry;
        else {
          toolIndexById.set(item.id, entries.length);
          entries.push(entry);
        }
      }
    } catch {
      // A bounded tail may begin in the middle of a JSONL record.
    }
  }
  return entries.filter(
    (entry) =>
      entry.kind !== "user" ||
      !entry.itemId ||
      !rejectedPromptIds.has(entry.itemId),
  );
}

function flattenSummary(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value))
    return value
      .map((part) => flattenSummary(part))
      .filter(Boolean)
      .join(" ");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return flattenSummary(record.text ?? record.content ?? "");
  }
  return "";
}

export function filterSessions(sessions: Session[], query: string): Session[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return sessions;
  return sessions.filter((session) =>
    [
      session.status,
      session.provider,
      session.cwd,
      basename(session.cwd || dirname(session.stateDir)),
      session.threadId,
      session.turnId,
      session.model,
      session.effort,
    ]
      .filter(Boolean)
      .some((value) => value!.toLocaleLowerCase().includes(needle)),
  );
}

function cleanThought(text: string): string {
  return text
    .replace(/\*\*\s+\*\*/g, " · ")
    .replace(/\*\*/g, "")
    .trim();
}

function parseTool(text: string): { label: string; text: string } {
  if (text === "file changes") return { label: "files", text: "changed" };
  const command = text.startsWith("$ ") ? text.slice(2) : text;
  const shell = /^(?:\/bin\/)?(?:zsh|bash|sh) -lc (.+)$/.exec(command);
  if (shell) {
    const quote = shell[1][0];
    let script = quote === '"' || quote === "'" ? shell[1].slice(1) : shell[1];
    if (script.endsWith(quote)) script = script.slice(0, -1);
    return { label: "shell", text: script };
  }
  const executable = command.split(/\s+/, 1)[0];
  return { label: basename(executable) || "tool", text: command };
}

export function sessionLabel(session: Session): string {
  const glyph = statusGlyph(session.status);
  const project =
    basename(session.cwd || dirname(session.stateDir)) || session.stateDir;
  const age = formatAge(session.updatedAt);
  return `${glyph} ${project}  ${age}`;
}

export function sessionDescription(session: Session): string {
  return `${session.provider ?? "codex"} · ${session.status} · ${shortID(session.turnId || session.threadId)} · ${session.model || "default model"}`;
}

export function compactSessionDetails(session: Session | undefined): string {
  if (!session) return sessionDetails(session);
  const elapsed = formatElapsed(session.startedAt, session.completedAt);
  return [
    `status   ${statusGlyph(session.status)} ${session.status}    ${elapsed}`,
    `provider ${session.provider ?? "codex"}`,
    `model    ${session.model || "—"}${session.effort ? ` / ${session.effort}` : ""}`,
    `cwd      ${session.cwd || "—"}`,
    session.tokenUsage ? `tokens   ${formatTokenUsage(session.tokenUsage)}` : "",
    session.error ? `error    ${session.error}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function continuationRunArguments(
  session: Session,
  promptFile: string,
  stateDirectory: string,
  overrides: { model?: string; effort?: string; provider?: string } = {},
): string[] {
  if (!session.threadId || !session.cwd)
    throw new Error("continuation requires a thread and working directory");
  const args = [
    "run",
    "--provider",
    overrides.provider ?? session.provider ?? "codex",
    "--cwd",
    session.cwd,
    "--resume-thread",
    session.threadId,
    "--prompt-file",
    promptFile,
    "--state-dir",
    stateDirectory,
    "--sandbox",
    session.sandbox || "workspace-write",
    "--approval-policy",
    "never",
    "--idle",
  ];
  const model = overrides.model ?? session.model;
  const effort = overrides.effort ?? session.effort;
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  return args;
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000)
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${value}`;
}

// "186.1K (18%) · $0.10" — percent only with a known context window, cost
// only when the provider reports one.
export function formatTokenUsage(usage: TokenUsage | undefined): string {
  if (!usage) return "";
  const total = usage.totalTokens ?? 0;
  const parts: string[] = [];
  if (total > 0) {
    let tokens = formatTokenCount(total);
    if (usage.contextWindow && usage.contextWindow > 0) {
      const percent = Math.min(
        100,
        Math.round((total / usage.contextWindow) * 100),
      );
      tokens += ` (${percent}%)`;
    }
    parts.push(tokens);
  }
  if (usage.costUsd && usage.costUsd > 0)
    parts.push(`$${usage.costUsd.toFixed(2)}`);
  return parts.join(" · ");
}

export type PromptRoute = "steer" | "prompt" | "continue";

export interface PromptTarget {
  stateDir: string;
  route: PromptRoute;
  turnId?: string;
}

export function idlePromptControlArguments(
  stateDir: string,
  messageFile: string,
): string[] {
  return ["prompt", "--state-dir", stateDir, "--message-file", messageFile];
}

export function steerControlArguments(
  stateDir: string,
  turnId: string,
  messageFile: string,
): string[] {
  return [
    "steer",
    "--state-dir",
    stateDir,
    "--expected-turn-id",
    turnId,
    "--message-file",
    messageFile,
  ];
}

// Routes a typed prompt: active turns get steered, idle sessions get a new
// turn over the control socket, finished threads get a continuation run.
// Never converts one route into another.
export function promptModeForSession(
  session: Session | undefined,
): PromptRoute | undefined {
  if (!session) return undefined;
  if (session.status === "active") return "steer";
  if (session.status === "idle") return "prompt";
  if (
    (session.status === "completed" ||
      session.status === "failed" ||
      session.status === "interrupted") &&
    session.threadId &&
    session.cwd
  )
    return "continue";
  return undefined;
}

export function promptTargetForSession(
  session: Session | undefined,
): PromptTarget | undefined {
  const route = promptModeForSession(session);
  if (!session || !route) return undefined;
  if (route === "steer") {
    return session.turnId
      ? { stateDir: session.stateDir, route, turnId: session.turnId }
      : undefined;
  }
  return { stateDir: session.stateDir, route };
}

export function resolvePromptTarget(
  sessions: Session[],
  target: PromptTarget,
): Session | undefined {
  const session = sessions.find(
    (candidate) => candidate.stateDir === target.stateDir,
  );
  if (promptModeForSession(session) !== target.route) return undefined;
  if (target.route === "steer" && session?.turnId !== target.turnId)
    return undefined;
  return session;
}

export interface ModelInfo {
  provider: string;
  id?: string;
  label?: string;
  efforts?: string[];
  contextWindow?: number;
  default?: boolean;
  available: boolean;
  note?: string;
}

// Embedded fallback for older rudder binaries without `rudder models`.
export const FALLBACK_MODELS: ModelInfo[] = [
  { provider: "codex", id: "gpt-5.6-sol", label: "GPT-5.6-Sol", default: true, available: true },
  { provider: "codex", id: "gpt-5.6-terra", label: "GPT-5.6-Terra", available: true },
  { provider: "codex", id: "gpt-5.6-luna", label: "GPT-5.6-Luna", available: true },
  { provider: "claude", id: "claude-fable-5-1", label: "Claude Fable 5.1", available: true },
  { provider: "claude", id: "claude-fable-5", label: "Claude Fable 5", available: true },
  { provider: "claude", id: "claude-opus-5", label: "Claude Opus 5", default: true, available: true },
  { provider: "claude", id: "claude-sonnet-5", label: "Claude Sonnet 5", available: true },
  { provider: "claude", id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", available: true },
  { provider: "opencode", id: "openrouter/deepseek/deepseek-v4-flash-vision-exp", label: "DeepSeek V4 Flash Vision Exp", default: true, available: true },
  { provider: "pi", id: "openrouter/deepseek/deepseek-v4-flash-vision-exp", label: "DeepSeek V4 Flash Vision Exp", efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], default: true, available: true },
];

export interface ModelPickerOption {
  name: string;
  description: string;
  value: string;
  disabled: boolean;
  model: ModelInfo;
}

export function modelPickerOptions(models: ModelInfo[]): ModelPickerOption[] {
  return models.map((model) => ({
    name: model.available
      ? `${model.label || model.id}${model.default ? " *" : ""}`
      : `${model.provider} (${model.note || "unavailable"})`,
    description: model.available
      ? model.provider
      : model.note || "unavailable",
    value: model.available ? `${model.provider}/${model.id}` : model.provider,
    disabled: !model.available,
    model,
  }));
}

export function parseModelCatalog(json: string): ModelInfo[] {
  try {
    const parsed = JSON.parse(json) as ModelInfo[];
    if (!Array.isArray(parsed)) return FALLBACK_MODELS;
    const valid = parsed.filter(
      (model) =>
        model &&
        typeof model.provider === "string" &&
        (model.available === false || typeof model.id === "string"),
    );
    return valid.length > 0 ? valid : FALLBACK_MODELS;
  } catch {
    return FALLBACK_MODELS;
  }
}

export interface NewSessionOptions {
  provider: string;
  model?: string;
  effort?: string;
  cwd: string;
  promptFile: string;
  stateDirectory: string;
  resumeThreadId?: string;
}

export function newSessionRunArguments(options: NewSessionOptions): string[] {
  const args = [
    "run",
    "--provider",
    options.provider,
    "--cwd",
    options.cwd,
    "--prompt-file",
    options.promptFile,
    "--state-dir",
    options.stateDirectory,
    "--sandbox",
    "workspace-write",
    "--approval-policy",
    "never",
    "--idle",
  ];
  if (options.resumeThreadId)
    args.push("--resume-thread", options.resumeThreadId);
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  return args;
}

export interface DejaHit {
  provider: "codex" | "claude" | "opencode" | "pi";
  sessionId: string;
  project: string;
  date: string;
  openingPrompt: string;
}

// deja find --json hits carry a `resume` command like "codex resume <id>" or
// "claude --resume <id>"; the id doubles as rudder's --resume-thread value.
export function parseDejaHits(json: string): DejaHit[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const hits =
    parsed && typeof parsed === "object" && Array.isArray((parsed as { hits?: unknown[] }).hits)
      ? ((parsed as { hits: unknown[] }).hits as Array<Record<string, unknown>>)
      : [];
  const results: DejaHit[] = [];
  for (const hit of hits) {
    const resume = typeof hit.resume === "string" ? hit.resume : "";
    const match =
      /^claude --resume (\S+)$/.exec(resume) ??
      /^codex resume (\S+)$/.exec(resume);
    if (!match) continue;
    results.push({
      provider: resume.startsWith("claude") ? "claude" : "codex",
      sessionId: match[1],
      project: typeof hit.project === "string" ? hit.project : "",
      date: typeof hit.date === "string" ? hit.date : "",
      openingPrompt:
        typeof hit.openingPrompt === "string" ? hit.openingPrompt : "",
    });
  }
  return results;
}

export function sessionDetails(session: Session | undefined): string {
  if (!session) {
    return `No active Rudder sessions.\n\nWatching the global registry and ${join(process.cwd(), ".scratch")}.\nNew runs appear automatically.`;
  }
  const elapsed = formatElapsed(session.startedAt, session.completedAt);
  return [
    `status   ${statusGlyph(session.status)} ${session.status}`,
    `provider ${session.provider ?? "codex"}`,
    `model    ${session.model || "—"}${session.effort ? ` / ${session.effort}` : ""}`,
    `thread   ${session.threadId || "—"}`,
    `turn     ${session.turnId || "—"}`,
    `cwd      ${session.cwd || "—"}`,
    `runtime  ${elapsed}    pid ${session.pid}    steers ${session.steers ?? 0}${session.turns ? `    turns ${session.turns}` : ""}`,
    session.tokenUsage ? `tokens   ${formatTokenUsage(session.tokenUsage)}` : "",
    session.error ? `error    ${session.error}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function statusGlyph(status: string): string {
  switch (status) {
    case "active":
      return "●";
    case "idle":
      return "◌";
    case "starting":
      return "◐";
    case "completed":
      return "✓";
    case "failed":
      return "×";
    case "interrupted":
      return "■";
    case "stale":
      return "!";
    default:
      return "?";
  }
}

function shortID(value: string | undefined): string {
  if (!value) return "no turn";
  return value.length > 14 ? `${value.slice(0, 12)}…` : value;
}

function formatAge(value: string | undefined, now = Date.now()): string {
  const timestamp = Date.parse(value ?? "");
  if (!Number.isFinite(timestamp)) return "unknown";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatElapsed(
  startValue: string | undefined,
  endValue: string | undefined,
  now = Date.now(),
): string {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) return "unknown";
  const parsedEnd = Date.parse(endValue ?? "");
  const end =
    Number.isFinite(parsedEnd) && parsedEnd >= start ? parsedEnd : now;
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
