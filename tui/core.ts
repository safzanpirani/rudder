import { open, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface RunState {
  version: number;
  provider?: "codex" | "claude";
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
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  error?: string;
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
}

export interface DiscoverOptions {
  roots: string[];
  stateDirs: string[];
  registryDirs?: string[];
  processAlive?: (pid: number) => boolean;
}

export type Artifact = "trace" | "output";

export function artifactAllowsTextSelection(artifact: Artifact): boolean {
  return artifact === "output";
}
export type Focus = "sessions" | "artifact" | "steer";

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
  artifact: "trace",
  focus: "sessions",
  interruptArmedUntil: 0,
};

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
      return {
        ...state,
        artifact: state.artifact === "trace" ? "output" : "trace",
      };
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
      : status === "starting"
        ? 1
        : status === "stale"
          ? 3
          : 2;
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
    const live = session.status === "active" || session.status === "starting";
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
  for (const line of content.split("\n")) {
    try {
      const event = JSON.parse(line) as {
        method?: string;
        params?: {
          item?: {
            id?: string;
            type?: string;
            command?: string;
            cwd?: string;
            status?: string;
            aggregatedOutput?: string;
            exitCode?: number;
            durationMs?: number;
            query?: string;
            toolName?: string;
            input?: Record<string, unknown>;
          };
        };
      };
      const item = event.params?.item;
      if (!item?.id || !item.type || !event.method?.startsWith("item/"))
        continue;
      if (
        item.type !== "commandExecution" &&
        item.type !== "webSearch" &&
        item.type !== "fileChange" &&
        item.type !== "toolCall"
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
        command: item.command ?? previous?.command,
        cwd: item.cwd ?? previous?.cwd,
        status: eventStatus,
        output: item.aggregatedOutput ?? previous?.output,
        exitCode: item.exitCode ?? previous?.exitCode,
        durationMs: item.durationMs ?? previous?.durationMs,
        query: item.query ?? previous?.query,
        toolName: item.toolName ?? previous?.toolName,
        input: item.input ?? previous?.input,
      });
    } catch {
      // A bounded tail may begin in the middle of a JSONL record.
    }
  }
  return order.flatMap((id) => {
    const detail = byID.get(id);
    return detail ? [detail] : [];
  });
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
    session.error ? `error    ${session.error}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function continuationRunArguments(
  session: Session,
  promptFile: string,
  stateDirectory: string,
): string[] {
  if (!session.threadId || !session.cwd)
    throw new Error("continuation requires a thread and working directory");
  const args = [
    "run",
    "--provider",
    session.provider ?? "codex",
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
  ];
  if (session.model) args.push("--model", session.model);
  if (session.effort) args.push("--effort", session.effort);
  return args;
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
    `runtime  ${elapsed}    pid ${session.pid}    steers ${session.steers ?? 0}`,
    session.error ? `error    ${session.error}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function statusGlyph(status: string): string {
  switch (status) {
    case "active":
      return "●";
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
