import {
  bg,
  BoxRenderable,
  bold,
  createCliRenderer,
  fg,
  InputRenderable,
  InputRenderableEvents,
  italic,
  parseColor,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  StyledText,
  t,
  TextareaRenderable,
  TextRenderable,
  underline,
} from "@opentui/core";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactAllowsTextSelection,
  AsyncTaskGate,
  attachToolDetails,
  blendHex,
  clampScrollOffset,
  contextMeter,
  deleteSessionArtifacts,
  diffTreeWidthForRatio,
  filetypeForPath,
  filterPaletteCommands,
  formatElapsed,
  highlightCode,
  highlightLines,
  nextDiffPollDelay,
  parseMarkdown,
  renderMeter,
  typewriterReveal,
  gitDiffFileStats,
  gitDiffGutterWidth,
  gitDiffSummary,
  helpSegments,
  parseGitDiffHunkHeader,
  spinnerFrame,
  statusGlyphForKind,
  statusTimeoutMs,
  visibleGitDiffLineIndices,
  compactSessionDetails,
  continuationRunArguments,
  contextualHelp,
  dashboardNavigation,
  diffTreeWidthForPointer,
  discoverSessions,
  emptyPromptHint,
  filterSessions,
  formatTokenUsage,
  gitDiffTree,
  initialViewState,
  idlePromptControlArguments,
  latestAgentUpdate,
  modelPickerOptions,
  newSessionRunArguments,
  nextGitDiffBoundary,
  nextArtifact,
  parseArguments,
  parseChatTranscript,
  parseDejaHits,
  parseGitDiff,
  parseModelCatalog,
  parseToolEventDetails,
  parseTraceActivities,
  promptModeForSession,
  promptTargetForSession,
  readTail,
  reduceView,
  resolvePromptTarget,
  sessionDescription,
  sessionDetails,
  sessionIsDeletable,
  sessionLabel,
  sessionsPanelTitle,
  statusGlyph,
  steerControlArguments,
  visibleArtifactTail,
  visibleSessions,
  FALLBACK_MODELS,
  type Artifact,
  type ChatEntry,
  type DejaHit,
  type ModelInfo,
  type PromptTarget,
  type Session,
  type ToolEventDetail,
  type TraceActivity,
  type CodeSpan,
  type CodeToken,
  type GitDiffFileStats,
  type InlineSpan,
  type MarkdownLine,
  type PaletteCommand,
  type GitDiffLine,
  type GitDiffSummary,
  type GitDiffTreeEntry,
  type StatusKind,
  type TUILayout,
  type ViewState,
} from "./core";
import {
  defaultThemeName,
  findTheme,
  persistTheme,
  persistTUIConfig,
  readTUIConfig,
  resolveThemeName,
  themes,
  type ThemePalette,
} from "./themes";

let palette: ThemePalette = findTheme(defaultThemeName)!.palette;

const ACTIVITY_HISTORY_LIMIT = 200;
const OUTPUT_HISTORY_LINES = 1_000;
const ARTIFACT_TAIL_BYTES = 1024 * 1024;
const TOOL_OUTPUT_LINES = 40;
const DIFF_MAX_BYTES = 2 * 1024 * 1024;
const DIFF_REFRESH_MS = 1_000;
const diffCache = new Map<
  string,
  { readAt: number; delay: number; result: { content: string; error?: string } }
>();

async function readWorkspaceDiff(
  cwd: string,
  force = false,
): Promise<{ content: string; error?: string }> {
  const cached = diffCache.get(cwd);
  if (cached && !force && Date.now() - cached.readAt < cached.delay)
    return cached.result;
  const remember = (result: { content: string; error?: string }) => {
    const changed = !cached || cached.result.content !== result.content;
    diffCache.set(cwd, {
      readAt: Date.now(),
      delay: nextDiffPollDelay(cached?.delay ?? DIFF_REFRESH_MS, changed),
      result,
    });
    return result;
  };

  const run = async (arguments_: string[]): Promise<[string, number]> => {
    const child = Bun.spawn(
      [
        "git",
        "-C",
        cwd,
        "diff",
        "--no-ext-diff",
        "--no-color",
        "--unified=3",
        ...arguments_,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    let truncated = false;
    const stdoutPromise = (async () => {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let size = 0;
      let output = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = DIFF_MAX_BYTES - size;
        if (value.byteLength > remaining) {
          output += decoder.decode(value.subarray(0, Math.max(0, remaining)), {
            stream: true,
          });
          truncated = true;
          child.kill();
          break;
        }
        size += value.byteLength;
        output += decoder.decode(value, { stream: true });
      }
      output += decoder.decode();
      if (truncated)
        output += `\n\\ Diff truncated at ${DIFF_MAX_BYTES / 1024 / 1024} MiB`;
      return output;
    })();
    const [stdout, stderr, exitCode] = await Promise.all([
      stdoutPromise,
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return [
      exitCode === 0 || truncated ? stdout : stderr.trim(),
      truncated ? 0 : exitCode,
    ];
  };

  try {
    const [headDiff, exitCode] = await run(["HEAD", "--"]);
    if (exitCode === 0) return remember({ content: headDiff });
    const [[staged, stagedExit], [unstaged, unstagedExit]] = await Promise.all([
      run(["--cached", "--"]),
      run(["--"]),
    ]);
    if (stagedExit === 0 && unstagedExit === 0)
      return remember({
        content: [staged, unstaged].filter(Boolean).join("\n"),
      });
    return remember({
      content: "",
      error: headDiff || "Git diff is unavailable.",
    });
  } catch (error) {
    return remember({ content: "", error: errorMessage(error) });
  }
}

/** Files whose mtime is at or after the session start: the session's edits. */
async function touchedSince(
  cwd: string,
  paths: Iterable<string>,
  startedAt: string | undefined,
): Promise<Set<string>> {
  const since = Date.parse(startedAt ?? "");
  const touched = new Set<string>();
  if (!Number.isFinite(since)) return touched;
  await Promise.all(
    [...paths].map(async (path) => {
      try {
        const info = await stat(join(cwd, path));
        if (info.mtimeMs >= since - 1_000) touched.add(path);
      } catch {
        // Deleted or unreadable files stay unmarked.
      }
    }),
  );
  return touched;
}

interface ActivityRow {
  id: string;
  activity?: TraceActivity;
  diff?: GitDiffLine;
  /** Index into the full parsed diff for diff rows (folding hides rows). */
  lineIndex?: number;
  detail?: ToolEventDetail;
  chat?: ChatEntry;
  /** Animated "working" row appended while the selected session is active. */
  live?: boolean;
  /** Clickable rows (empty states, retry hints) run this on click or Enter. */
  action?: () => void;
  text: string;
  copyText: string;
}

const ANIMATION_INTERVAL_MS = 100;
const LIVE_ROW_ID = "live";

interface DiffTints {
  additionBg: string;
  deletionBg: string;
  additionGutterBg: string;
  deletionGutterBg: string;
  hunkBg: string;
}

function diffTintsFor(theme: ThemePalette): DiffTints {
  return {
    additionBg: blendHex(theme.background, theme.success, 0.14),
    deletionBg: blendHex(theme.background, theme.danger, 0.14),
    additionGutterBg: blendHex(theme.background, theme.success, 0.24),
    deletionGutterBg: blendHex(theme.background, theme.danger, 0.24),
    hunkBg: blendHex(theme.background, theme.accent, 0.08),
  };
}

let diffTints: DiffTints = diffTintsFor(palette);

// The TUI resolves "auto" once when the input opens. A status change can then
// reject the captured command, but it can never convert prompt into steer.
type PromptMode = "steer" | "prompt" | "continue" | "new";
type SearchMode = "sessions" | "artifact" | "deja";

async function main(): Promise<void> {
  const args = parseArguments(Bun.argv.slice(2));
  const layout: TUILayout = args.beta ? "beta" : "classic";
  const persistedConfig = await readTUIConfig();
  let activeThemeName = resolveThemeName(
    args.theme || process.env.RUDDR_TUI_THEME || process.env.RUDDER_TUI_THEME,
    persistedConfig.theme,
  );
  palette = findTheme(activeThemeName)!.palette;
  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    consoleMode: "disabled",
    exitOnCtrlC: false,
    exitSignals: [],
    targetFps: 15,
    backgroundColor: palette.background,
    useMouse: true,
    enableMouseMovement: true,
  });
  let destroyed = false;

  try {
    let discoveredSessions: Session[] = [];
    let listedSessions: Session[] = [];
    let sessions: Session[] = [];
    let view: ViewState = initialViewState;
    const refreshGate = new AsyncTaskGate();
    let actionRunning = false;
    let detailsExpanded = false;
    let sessionQuery = "";
    const artifactQueries: Record<Artifact, string> = {
      chat: "",
      trace: "",
      output: "",
      diff: "",
    };
    let searchMode: SearchMode | undefined;
    let promptMode: PromptMode | undefined;
    let promptTarget: PromptTarget | undefined;
    let sessionsVisible = false;
    let modelPickerOpen = false;
    let dejaPickerOpen = false;
    let models: ModelInfo[] = FALLBACK_MODELS;
    let pendingModel: ModelInfo | undefined;
    let pendingResume: DejaHit | undefined;
    let dejaHits: DejaHit[] = [];
    const dejaAvailable = Boolean(Bun.which("deja"));
    let artifactRows: ActivityRow[] = [];
    let rowRenderables: TextRenderable[] = [];
    let selectedRow = -1;
    let expandedToolIDs = new Set<string>();
    let artifactSignature = "";
    let artifactKey = "";
    let artifactFollowing = true;
    let unseenRows = 0;
    let previousRowCount = 0;
    let themePickerOpen = false;
    let themeBeforePicker = activeThemeName;
    let diffTreeWidth = Math.max(
      20,
      Math.min(60, persistedConfig.diffTreeWidth ?? 30),
    );
    let diffDividerDragging = false;
    let diffDividerHovered = false;
    let diffNavigationPrefix: "[" | "]" | undefined;
    let diffNavigationTimer: ReturnType<typeof setTimeout> | undefined;
    const collapsedDiffDirectories = new Set<string>();
    const collapsedDiffFiles = new Set<string>();
    let diffLines: GitDiffLine[] = [];
    let diffSummary: GitDiffSummary | undefined;
    let diffFileStats = new Map<string, GitDiffFileStats>();
    let diffGutterWidth = 2;
    let diffError: string | undefined;
    let diffTouchedPaths = new Set<string>();
    // Highlight spans per parsed diff line, scanned hunk by hunk so block
    // comments and template strings keep their color across lines.
    let diffSpans: Array<CodeSpan[] | undefined> = [];
    let diffTouchedSignature = "";
    let diffTreeRatio: number | undefined = persistedConfig.diffTreeRatio;
    // Typewriter reveal for the newest agent message while a session works.
    let stream: { id: string; revealed: number; target: number } | undefined;
    const seenAgentLength = new Map<string, number>();
    let animationTick = 0;
    let statusState: { message: string; kind: StatusKind; idle: boolean } = {
      message: "",
      kind: "info",
      idle: true,
    };
    let statusTimer: ReturnType<typeof setTimeout> | undefined;
    let lastRefreshAt = 0;

    const sessionList = new SelectRenderable(renderer, {
      id: "sessions",
      flexGrow: 1,
      options: [],
      showDescription: true,
      wrapSelection: true,
      backgroundColor: palette.panel,
      focusedBackgroundColor: palette.panel,
      textColor: palette.text,
      focusedTextColor: palette.text,
      descriptionColor: palette.dim,
      selectedDescriptionColor: palette.text,
      selectedBackgroundColor: palette.selected,
      selectedTextColor: palette.accent,
      showScrollIndicator: true,
      renderAfter(buffer) {
        const linesPerItem = 2;
        const visibleItems = Math.max(
          1,
          Math.floor(this.height / linesPerItem),
        );
        const scrollOffset = listScrollOffset(this);
        const accent = parseColor(palette.accent);
        const success = parseColor(palette.success);
        const warning = parseColor(palette.warning);
        const danger = parseColor(palette.danger);
        const labelX = 3;

        const dimColor = parseColor(palette.dim);
        for (const [visibleIndex, session] of sessions
          .slice(scrollOffset, scrollOffset + visibleItems)
          .entries()) {
          const index = scrollOffset + visibleIndex;
          const live = isLive(session);
          const previous = sessions[index - 1];
          const firstOfGroup = !previous || isLive(previous) !== live;
          const statusColor =
            session.status === "active" || session.status === "completed"
              ? success
              : session.status === "starting" || session.status === "idle"
                ? warning
                : danger;
          const rowY = visibleIndex * linesPerItem;
          const provider = session.provider ?? "codex";

          buffer.drawText(
            session.status === "active" || session.status === "starting"
              ? spinnerFrame(animationTick)
              : statusGlyph(session.status),
            labelX,
            rowY,
            statusColor,
          );
          buffer.drawText(provider, labelX, rowY + 1, accent);
          buffer.drawText(
            session.status,
            labelX + provider.length + 3,
            rowY + 1,
            statusColor,
          );
          if (firstOfGroup) {
            const tag = live ? "LIVE" : "RECENT";
            const age = sessionLabel(session).split("  ").pop() ?? "";
            const tagX =
              labelX + sessionCardInnerWidth() - [...age].length - 1 - tag.length - 1;
            buffer.drawText(tag, Math.max(labelX, tagX), rowY, live ? success : dimColor);
          }
        }
      },
    });
    const sessionsPanel = new BoxRenderable(renderer, {
      position: layout === "beta" ? "absolute" : "relative",
      left: layout === "beta" ? "8%" : undefined,
      top: layout === "beta" ? "8%" : undefined,
      width: layout === "beta" ? "84%" : "34%",
      minWidth: layout === "classic" ? 36 : undefined,
      maxWidth: layout === "classic" ? 44 : undefined,
      height: layout === "beta" ? "84%" : "100%",
      flexShrink: 0,
      zIndex: layout === "beta" ? 15 : 0,
      border: true,
      borderStyle: "rounded",
      borderColor: palette.border,
      focusedBorderColor: palette.accent,
      title: sessionsPanelTitle({
        layout,
        liveCount: 0,
        recentCount: 0,
      }),
      padding: 1,
      backgroundColor: palette.background,
      visible: layout === "classic",
    });
    sessionsPanel.add(sessionList);

    const details = new TextRenderable(renderer, {
      content: "No session selected",
      fg: palette.text,
      width: "100%",
    });
    const detailsPanel = new BoxRenderable(renderer, {
      width: "100%",
      height: 8,
      border: true,
      borderStyle: "rounded",
      borderColor: palette.border,
      title: " Session · i hide ",
      padding: 1,
      backgroundColor: palette.background,
      visible: layout === "classic",
    });
    detailsPanel.add(details);

    const chatTab = new TextRenderable(renderer, {
      content: "chat",
      fg: palette.accent,
    });
    const activityTab = new TextRenderable(renderer, {
      content: "activity",
      fg: palette.dim,
    });
    const outputTab = new TextRenderable(renderer, {
      content: "output",
      fg: palette.dim,
    });
    const diffTab = new TextRenderable(renderer, {
      content: "diff",
      fg: palette.dim,
    });
    const tabsLeft = new BoxRenderable(renderer, {
      height: 1,
      flexDirection: "row",
      gap: 2,
    });
    tabsLeft.add(chatTab);
    tabsLeft.add(activityTab);
    tabsLeft.add(outputTab);
    tabsLeft.add(diffTab);
    // Only speaks up when live-follow is paused; silence is the default.
    const followIndicator = new TextRenderable(renderer, {
      content: "",
      fg: palette.warning,
    });
    // Live pulse for the selected session: spinner + elapsed while it works.
    const workingIndicator = new TextRenderable(renderer, {
      content: "",
      fg: palette.success,
    });
    const tabsRight = new BoxRenderable(renderer, {
      height: 1,
      flexDirection: "row",
      gap: 2,
    });
    tabsRight.add(workingIndicator);
    tabsRight.add(followIndicator);
    const tabsBar = new BoxRenderable(renderer, {
      width: "100%",
      height: 1,
      flexDirection: "row",
      justifyContent: "space-between",
      paddingLeft: 1,
      paddingRight: 1,
    });
    tabsBar.add(tabsLeft);
    tabsBar.add(tabsRight);

    const artifactScroll = new ScrollBoxRenderable(renderer, {
      id: "artifact",
      width: "100%",
      flexGrow: 1,
      scrollY: true,
      scrollX: true,
      stickyScroll: true,
      stickyStart: "bottom",
      viewportCulling: false,
      verticalScrollbarOptions: {
        trackOptions: {
          foregroundColor: palette.accent,
          backgroundColor: palette.border,
        },
      },
    });
    const diffSummaryLine = new TextRenderable(renderer, {
      id: "diff-summary",
      content: "",
      fg: palette.dim,
      height: 1,
      width: "100%",
      paddingLeft: 1,
      wrapMode: "none",
      truncate: true,
    });
    const diffFileList = new SelectRenderable(renderer, {
      id: "diff-files",
      width: "100%",
      flexGrow: 1,
      options: [],
      showDescription: false,
      showScrollIndicator: true,
      showSelectionIndicator: true,
      backgroundColor: palette.panel,
      focusedBackgroundColor: palette.panel,
      textColor: palette.dim,
      focusedTextColor: palette.text,
      selectedBackgroundColor: palette.selected,
      selectedTextColor: palette.accent,
      renderAfter(buffer) {
        const options = this.options;
        const visibleItems = Math.max(1, Math.floor(this.height));
        const scrollOffset = listScrollOffset(this);
        const addition = parseColor(palette.success);
        const deletion = parseColor(palette.danger);
        const labelX = 3;
        for (const [visibleIndex, option] of options
          .slice(scrollOffset, scrollOffset + visibleItems)
          .entries()) {
          const entry = option.value as GitDiffTreeEntry | undefined;
          const match = entry ? /(\+\d+) (−\d+)$/.exec(entry.label) : null;
          if (!match) continue;
          if (entry && diffTouchedPaths.has(entry.path)) {
            const indent = /^\s*/.exec(entry.label)?.[0].length ?? 0;
            buffer.drawText("●", labelX + indent, visibleIndex, parseColor(palette.accent));
          }
          const countWidth = match[1].length + 1 + match[2].length;
          const countX = Math.max(labelX, this.width - countWidth - 2);
          if (entry?.status) {
            const statusColor =
              entry.status === "A"
                ? addition
                : entry.status === "D"
                  ? deletion
                  : parseColor(
                      entry.status === "R" ? palette.warning : palette.accent,
                    );
            buffer.drawText(entry.status, Math.max(labelX, countX - 3), visibleIndex, statusColor);
          }
          buffer.drawText(match[1], countX, visibleIndex, addition);
          buffer.drawText(
            match[2],
            countX + match[1].length + 1,
            visibleIndex,
            deletion,
          );
        }
      },
    });
    const diffSidebar = new BoxRenderable(renderer, {
      id: "diff-sidebar",
      width: 30,
      height: "100%",
      flexShrink: 0,
      flexDirection: "column",
      backgroundColor: palette.panel,
      visible: false,
    });
    diffSidebar.add(diffSummaryLine);
    diffSidebar.add(diffFileList);
    const diffDivider = new BoxRenderable(renderer, {
      id: "diff-divider",
      width: 1,
      height: "100%",
      flexShrink: 0,
      backgroundColor: palette.background,
      visible: false,
      renderAfter(buffer) {
        const color = parseColor(
          diffDividerDragging || diffDividerHovered
            ? palette.accent
            : palette.border,
        );
        const gripStart = Math.max(0, Math.floor(this.height / 2) - 1);
        const active = diffDividerDragging || diffDividerHovered;
        for (let y = 0; y < this.height; y++) {
          const grip = y >= gripStart && y < gripStart + 3;
          buffer.drawText(
            grip ? "┃" : "┆",
            0,
            y,
            grip && !active ? parseColor(palette.dim) : color,
          );
        }
      },
    });
    const artifactBody = new BoxRenderable(renderer, {
      width: "100%",
      flexGrow: 1,
      flexDirection: "row",
      gap: 0,
    });
    artifactBody.add(diffSidebar);
    artifactBody.add(diffDivider);
    artifactBody.add(artifactScroll);
    // Borderless main surface: the conversation floats on the background the
    // way opencode's does; the prompt input is the only framed element.
    const artifactPanel = new BoxRenderable(renderer, {
      width: "100%",
      flexGrow: 1,
      flexDirection: "column",
      gap: 1,
      paddingLeft: 1,
      paddingRight: 1,
      paddingTop: 0,
    });
    artifactPanel.add(tabsBar);
    artifactPanel.add(artifactBody);

    const rightColumn = new BoxRenderable(renderer, {
      width: layout === "beta" ? "100%" : undefined,
      minWidth: layout === "classic" ? 50 : undefined,
      height: "100%",
      flexGrow: 1,
      flexDirection: "column",
      gap: 1,
      backgroundColor: palette.background,
    });
    rightColumn.add(detailsPanel);
    rightColumn.add(artifactPanel);

    const body = new BoxRenderable(renderer, {
      width: "100%",
      flexGrow: 1,
      flexDirection: layout === "beta" ? "column" : "row",
      gap: 1,
    });
    if (layout === "classic") body.add(sessionsPanel);
    body.add(rightColumn);

    // Meta line under the input: mode + model on the left, tokens/cost right.
    const promptMetaLeft = new TextRenderable(renderer, {
      content: "",
      fg: palette.dim,
      height: 1,
      flexGrow: 1,
      flexShrink: 1,
      wrapMode: "none",
      truncate: true,
    });
    const promptMetaRight = new TextRenderable(renderer, {
      content: "",
      fg: palette.dim,
      height: 1,
      flexShrink: 0,
      wrapMode: "none",
      truncate: true,
    });
    const promptMeta = new BoxRenderable(renderer, {
      width: "100%",
      height: 1,
      flexDirection: "row",
      justifyContent: "space-between",
      paddingLeft: 1,
      paddingRight: 1,
    });
    promptMeta.add(promptMetaLeft);
    promptMeta.add(promptMetaRight);

    const statusLine = new TextRenderable(renderer, {
      content: "",
      fg: palette.dim,
      height: 1,
      paddingLeft: 1,
    });
    const footerLeft = new TextRenderable(renderer, {
      content: "",
      fg: palette.dim,
      height: 1,
      width: "34%",
      flexShrink: 1,
      wrapMode: "none",
      truncate: true,
    });
    const footerRight = new TextRenderable(renderer, {
      content: "",
      fg: palette.dim,
      height: 1,
      width: "64%",
      flexGrow: 1,
      flexShrink: 1,
      paddingLeft: 1,
      wrapMode: "none",
      truncate: true,
    });
    const footerBar = new BoxRenderable(renderer, {
      width: "100%",
      height: 1,
      flexDirection: "row",
      justifyContent: "flex-start",
      gap: 1,
      paddingLeft: 1,
      paddingRight: 1,
    });
    footerBar.add(footerLeft);
    footerBar.add(footerRight);

    const searchInput = new InputRenderable(renderer, {
      id: "search-input",
      width: "100%",
      placeholder: "Filter project, thread, status, or model…",
      backgroundColor: palette.panel,
      focusedBackgroundColor: palette.selected,
      textColor: palette.text,
      focusedTextColor: palette.text,
      placeholderColor: palette.dim,
    });
    const searchPanel = new BoxRenderable(renderer, {
      position: "absolute",
      left: "18%",
      top: "35%",
      width: "64%",
      height: 5,
      zIndex: 10,
      border: true,
      borderStyle: "double",
      borderColor: palette.accent,
      title: " Search · Enter keep · Esc clear ",
      padding: 1,
      backgroundColor: palette.background,
      visible: false,
    });
    searchPanel.add(searchInput);

    const PROMPT_MIN_ROWS = 1;
    const PROMPT_MAX_ROWS = 6;
    const promptInput = new TextareaRenderable(renderer, {
      id: "prompt-input",
      width: "100%",
      height: PROMPT_MIN_ROWS,
      placeholder: "Message for the selected provider…",
      backgroundColor: palette.panel,
      focusedBackgroundColor: palette.selected,
      textColor: palette.text,
      focusedTextColor: palette.text,
      placeholderColor: palette.dim,
      cursorColor: palette.accent,
      wrapMode: "word",
      keyBindings: [
        { name: "return", action: "submit" },
        { name: "return", shift: true, action: "newline" },
        { name: "return", meta: true, action: "newline" },
        { name: "j", ctrl: true, action: "newline" },
      ],
      onSubmit: () => {
        if (promptMode) void submitPrompt();
      },
      onContentChange: () => fitPromptHeight(),
    });
    const promptPanel = new BoxRenderable(renderer, {
      width: "100%",
      height: PROMPT_MIN_ROWS + 2,
      border: true,
      borderStyle: "rounded",
      borderColor: palette.border,
      focusedBorderColor: palette.accent,
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: palette.background,
    });
    promptPanel.add(promptInput);
    function fitPromptHeight(): void {
      const rows = Math.max(
        PROMPT_MIN_ROWS,
        Math.min(PROMPT_MAX_ROWS, promptInput.lineCount || 1),
      );
      if (promptInput.height !== rows) {
        promptInput.height = rows;
        promptPanel.height = rows + 2;
      }
    }

    // Command palette: every action, searchable, with its key beside it.
    const paletteInput = new InputRenderable(renderer, {
      id: "palette-input",
      width: "100%",
      placeholder: "Type a command…",
      backgroundColor: palette.panel,
      focusedBackgroundColor: palette.selected,
      textColor: palette.text,
      focusedTextColor: palette.text,
      placeholderColor: palette.dim,
    });
    const paletteList = new SelectRenderable(renderer, {
      id: "palette-list",
      width: "100%",
      flexGrow: 1,
      options: [],
      showDescription: true,
      wrapSelection: true,
      backgroundColor: palette.background,
      focusedBackgroundColor: palette.background,
      textColor: palette.text,
      focusedTextColor: palette.text,
      descriptionColor: palette.dim,
      selectedDescriptionColor: palette.text,
      selectedBackgroundColor: palette.selected,
      selectedTextColor: palette.accent,
      showScrollIndicator: true,
    });
    const palettePanel = new BoxRenderable(renderer, {
      position: "absolute",
      left: "22%",
      top: "12%",
      width: "56%",
      height: "70%",
      zIndex: 25,
      border: true,
      borderStyle: "rounded",
      borderColor: palette.accent,
      title: " Commands · Enter run · Esc close ",
      padding: 1,
      gap: 1,
      flexDirection: "column",
      backgroundColor: palette.background,
      visible: false,
    });
    palettePanel.add(paletteInput);
    palettePanel.add(paletteList);
    let paletteOpen = false;
    let paletteCommands: PaletteCommand[] = [];

    // Right-click context menu. Items are plain closures; a destructive item
    // swaps the menu for a confirm/cancel pair instead of acting at once.
    interface MenuItem {
      label: string;
      hint?: string;
      danger?: boolean;
      run: () => void | Promise<void>;
    }
    const contextList = new SelectRenderable(renderer, {
      id: "context-menu",
      width: "100%",
      flexGrow: 1,
      options: [],
      showDescription: true,
      wrapSelection: true,
      backgroundColor: palette.panel,
      focusedBackgroundColor: palette.panel,
      textColor: palette.text,
      focusedTextColor: palette.text,
      descriptionColor: palette.dim,
      selectedDescriptionColor: palette.text,
      selectedBackgroundColor: palette.selected,
      selectedTextColor: palette.accent,
      showScrollIndicator: false,
    });
    const contextPanel = new BoxRenderable(renderer, {
      id: "context-panel",
      position: "absolute",
      left: 0,
      top: 0,
      width: 44,
      height: 6,
      zIndex: 30,
      border: true,
      borderStyle: "rounded",
      borderColor: palette.accent,
      backgroundColor: palette.panel,
      visible: false,
    });
    contextPanel.add(contextList);
    let contextItems: MenuItem[] = [];
    let contextOpen = false;
    let contextOpenedAt = 0;

    function openContextMenu(items: MenuItem[], x: number, y: number, title = ""): void {
      if (items.length === 0) return;
      contextItems = items;
      const width = Math.min(
        renderer.width - 2,
        Math.max(28, ...items.map((item) => Math.max(item.label.length, (item.hint ?? "").length) + 6)),
      );
      const height = Math.min(renderer.height - 2, items.length * 2 + 2);
      contextPanel.width = width;
      contextPanel.height = height;
      contextPanel.left = Math.max(0, Math.min(x, renderer.width - width - 1));
      contextPanel.top = Math.max(0, Math.min(y, renderer.height - height - 1));
      contextPanel.title = title ? ` ${title} ` : "";
      contextList.options = items.map((item, index) => ({
        name: item.danger ? `⚠ ${item.label}` : item.label,
        description: item.hint ?? "",
        value: String(index),
      }));
      contextList.setSelectedIndex(0);
      contextOpen = true;
      contextOpenedAt = Date.now();
      contextPanel.visible = true;
      contextList.focus();
    }

    function closeContextMenu(): void {
      if (!contextOpen) return;
      contextOpen = false;
      contextPanel.visible = false;
      focusCurrentPanel();
    }

    function runContextItem(index = contextList.getSelectedIndex()): void {
      const item = contextItems[index];
      closeContextMenu();
      if (item) void item.run();
    }
    contextPanel.onMouseDown = (event) => {
      const clicked = Math.floor((event.y - contextPanel.y - 1) / 2);
      if (clicked >= 0 && clicked < contextItems.length) runContextItem(clicked);
      event.preventDefault();
    };

    const modelPicker = new SelectRenderable(renderer, {
      id: "model-picker",
      width: "100%",
      flexGrow: 1,
      options: [],
      showDescription: true,
      wrapSelection: true,
      backgroundColor: palette.panel,
      focusedBackgroundColor: palette.panel,
      textColor: palette.text,
      focusedTextColor: palette.text,
      descriptionColor: palette.dim,
      selectedDescriptionColor: palette.text,
      selectedBackgroundColor: palette.selected,
      selectedTextColor: palette.accent,
      showScrollIndicator: true,
    });
    const modelPanel = new BoxRenderable(renderer, {
      position: "absolute",
      left: "27%",
      top: "18%",
      width: "46%",
      height: "64%",
      zIndex: 20,
      border: true,
      borderStyle: "double",
      borderColor: palette.accent,
      title: " Model · Enter choose · Esc cancel ",
      padding: 1,
      backgroundColor: palette.background,
      visible: false,
    });
    modelPanel.add(modelPicker);

    const dejaPicker = new SelectRenderable(renderer, {
      id: "deja-picker",
      width: "100%",
      flexGrow: 1,
      options: [],
      showDescription: true,
      wrapSelection: true,
      backgroundColor: palette.panel,
      focusedBackgroundColor: palette.panel,
      textColor: palette.text,
      focusedTextColor: palette.text,
      descriptionColor: palette.dim,
      selectedDescriptionColor: palette.text,
      selectedBackgroundColor: palette.selected,
      selectedTextColor: palette.accent,
      showScrollIndicator: true,
    });
    const dejaPanel = new BoxRenderable(renderer, {
      position: "absolute",
      left: "12%",
      top: "14%",
      width: "76%",
      height: "72%",
      zIndex: 20,
      border: true,
      borderStyle: "double",
      borderColor: palette.accent,
      title: " Resume past session · Enter pick · Esc cancel ",
      padding: 1,
      backgroundColor: palette.background,
      visible: false,
    });
    dejaPanel.add(dejaPicker);

    const themePicker = new SelectRenderable(renderer, {
      id: "theme-picker",
      width: "100%",
      flexGrow: 1,
      options: themes.map((theme) => ({
        name: theme.label,
        description:
          theme.source === "OpenCode" ? "OpenCode · dark" : "Ruddr default",
        value: theme.name,
      })),
      showDescription: true,
      wrapSelection: true,
      backgroundColor: palette.panel,
      focusedBackgroundColor: palette.panel,
      textColor: palette.text,
      focusedTextColor: palette.text,
      descriptionColor: palette.dim,
      selectedDescriptionColor: palette.text,
      selectedBackgroundColor: palette.selected,
      selectedTextColor: palette.accent,
      showScrollIndicator: true,
    });
    const themePanel = new BoxRenderable(renderer, {
      position: "absolute",
      left: "27%",
      top: "12%",
      width: "46%",
      height: "76%",
      zIndex: 20,
      border: true,
      borderStyle: "double",
      borderColor: palette.accent,
      title: " Theme · live preview · Enter save · Esc cancel ",
      padding: 1,
      backgroundColor: palette.background,
      visible: false,
    });
    themePanel.add(themePicker);

    const root = new BoxRenderable(renderer, {
      width: "100%",
      height: "100%",
      flexDirection: "column",
      padding: 1,
      backgroundColor: palette.background,
    });
    root.add(body);
    root.add(promptPanel);
    root.add(promptMeta);
    root.add(statusLine);
    root.add(footerBar);
    if (layout === "beta") root.add(sessionsPanel);
    root.add(searchPanel);
    root.add(palettePanel);
    root.add(contextPanel);
    root.add(themePanel);
    root.add(modelPanel);
    root.add(dejaPanel);
    renderer.root.add(root);
    // Mouse events bubble here last; a click anywhere outside the open menu
    // dismisses it. The opening click itself bubbles too, hence the delay.
    root.onMouseDown = (event) => {
      if (!contextOpen || Date.now() - contextOpenedAt < 150) return;
      const inside =
        event.x >= contextPanel.x &&
        event.x < contextPanel.x + contextPanel.width &&
        event.y >= contextPanel.y &&
        event.y < contextPanel.y + contextPanel.height;
      if (!inside) closeContextMenu();
    };
    artifactScroll.focus();
    view = { ...view, focus: "artifact" };

    chatTab.onMouseDown = () => setArtifact("chat");
    activityTab.onMouseDown = () => setArtifact("trace");
    outputTab.onMouseDown = () => setArtifact("output");
    diffTab.onMouseDown = () => setArtifact("diff");
    followIndicator.onMouseDown = () => resumeFollowing();
    promptPanel.onMouseDown = () => openPrompt("auto");
    sessionsPanel.onMouseDown = () => focusSessions();
    modelPanel.onMouseDown = () => modelPicker.focus();
    palettePanel.onMouseDown = () => paletteInput.focus();
    paletteInput.on(InputRenderableEvents.INPUT, (value: string) => {
      if (paletteOpen) fillPalette(value);
    });
    paletteList.on(SelectRenderableEvents.ITEM_SELECTED, () => {
      if (paletteOpen) runPaletteSelection();
    });
    dejaPanel.onMouseDown = () => dejaPicker.focus();
    let sessionScrollOffset: number | undefined;
    sessionList.onMouseScroll = (event) => {
      const steps = Math.max(1, Math.round(event.scroll?.delta ?? 1));
      const direction =
        event.scroll?.direction === "up" ? -1 : event.scroll?.direction === "down" ? 1 : 0;
      if (direction === 0) return;
      sessionScrollOffset = scrollListBy(sessionList, direction * steps, 2);
    };
    sessionList.on(SelectRenderableEvents.SELECTION_CHANGED, () => {
      sessionScrollOffset = undefined;
    });
    sessionList.onMouseDown = (event) => {
      focusSessions();
      const linesPerItem = 2;
      const scrollOffset = listScrollOffset(sessionList);
      const clickedIndex =
        scrollOffset + Math.floor((event.y - sessionList.y) / linesPerItem);
      if (clickedIndex >= 0 && clickedIndex < sessions.length)
        sessionList.setSelectedIndex(clickedIndex);
      if (event.button === 2) {
        event.preventDefault();
        const session = sessions[clickedIndex];
        if (session) openContextMenu(sessionMenu(session), event.x, event.y, sessionMenuTitle(session));
      }
    };

    function sessionMenuTitle(session: Session): string {
      return sessionLabel(session).split("  ")[0]?.trim() ?? "session";
    }

    function sessionMenu(session: Session): MenuItem[] {
      const items: MenuItem[] = [];
      const target = promptTargetForSession(session);
      if (target)
        items.push({
          label:
            target.route === "steer"
              ? "Steer running turn"
              : target.route === "prompt"
                ? "Send a prompt"
                : "Continue thread in a new run",
          run: () => openPrompt(target.route === "continue" ? "continue" : "auto"),
        });
      if (session.status === "active" || session.status === "idle")
        items.push({
          label: session.status === "idle" ? "End idle session" : "Interrupt turn",
          hint: "asks once more before acting",
          run: () => requestInterrupt(),
        });
      items.push(
        { label: "Open chat", run: () => setArtifact("chat") },
        { label: "Open diff", run: () => setArtifact("diff") },
      );
      if (session.threadId)
        items.push({
          label: "Copy thread ID",
          hint: session.threadId,
          run: () => copyText(session.threadId!),
        });
      items.push({
        label: "Copy state directory",
        hint: session.stateDir,
        run: () => copyText(session.stateDir),
      });
      if (sessionIsDeletable(session))
        items.push({
          label: "Delete session…",
          hint: "removes its state directory and registry entry",
          danger: true,
          run: () => confirmDelete([session], `Delete ${sessionMenuTitle(session)}?`),
        });
      const filtered = sessions.filter(sessionIsDeletable);
      if (sessionQuery.trim() && filtered.length > 1)
        items.push({
          label: `Delete ${filtered.length} finished sessions matching "${sessionQuery.trim()}"…`,
          hint: "live sessions in the filter are kept",
          danger: true,
          run: () => confirmDelete(filtered, `Delete ${filtered.length} sessions matching "${sessionQuery.trim()}"?`),
        });
      const broken = listedSessions.filter(
        (candidate) => candidate.status === "failed" || candidate.status === "stale",
      );
      if (broken.length > 0)
        items.push({
          label: `Delete all ${broken.length} failed or stale sessions…`,
          danger: true,
          run: () => confirmDelete(broken, `Delete ${broken.length} failed or stale sessions?`),
        });
      return items;
    }

    function confirmDelete(targets: Session[], question: string): void {
      const x = contextPanel.left as number;
      const y = contextPanel.top as number;
      openContextMenu(
        [
          {
            label: `Yes, delete ${targets.length === 1 ? "it" : `${targets.length} sessions`}`,
            hint: "cannot be undone",
            danger: true,
            run: () => deleteSessions(targets),
          },
          { label: "Cancel", run: () => undefined },
        ],
        x,
        y,
        question,
      );
    }

    async function deleteSessions(targets: Session[]): Promise<void> {
      if (actionRunning) return;
      actionRunning = true;
      setStatus(`Deleting ${targets.length} ${targets.length === 1 ? "session" : "sessions"}…`);
      let removed = 0;
      const failures: string[] = [];
      for (const target of targets) {
        try {
          const result = await deleteSessionArtifacts(target);
          if (result.removedStateDir || result.removedRegistryEntries > 0) removed++;
          else failures.push(`${sessionMenuTitle(target)}: state file did not match`);
          const explicit = args.stateDirs.indexOf(target.stateDir);
          if (explicit >= 0) args.stateDirs.splice(explicit, 1);
        } catch (error) {
          failures.push(`${sessionMenuTitle(target)}: ${errorMessage(error)}`);
        }
      }
      actionRunning = false;
      if (targets.some((target) => target.stateDir === view.selectedStateDir))
        view = reduceView(view, { type: "select", stateDir: undefined });
      await refresh();
      if (failures.length > 0)
        setStatus(`Deleted ${removed}; ${failures[0]}${failures.length > 1 ? ` (+${failures.length - 1} more)` : ""}`, "warning");
      else setStatus(`Deleted ${removed} ${removed === 1 ? "session" : "sessions"}`, "success");
    }

    function copyText(value: string): void {
      const copied = renderer.copyToClipboardOSC52(value);
      setStatus(
        copied ? "Copied to clipboard" : "Terminal clipboard copy is unavailable",
        copied ? "success" : "error",
      );
    }
    artifactPanel.onMouseDown = () => focusArtifact();
    artifactScroll.onMouseScroll = () => {
      focusArtifact();
      setTimeout(updateFollowFromPosition, 0);
    };
    diffFileList.onMouseScroll = (event) => {
      const steps = Math.max(1, Math.round(event.scroll?.delta ?? 1));
      const direction =
        event.scroll?.direction === "up" ? -1 : event.scroll?.direction === "down" ? 1 : 0;
      if (direction !== 0) scrollListBy(diffFileList, direction * steps, 1);
    };
    diffDivider.onMouseOver = () => {
      diffDividerHovered = true;
      diffDivider.requestRender();
    };
    diffDivider.onMouseOut = () => {
      diffDividerHovered = false;
      diffDivider.requestRender();
    };
    const resizeDiffTree = (pointerX: number) => {
      diffTreeWidth = diffTreeWidthForPointer(
        pointerX,
        artifactBody.x,
        artifactBody.width,
      );
      diffSidebar.width = diffTreeWidth;
      diffDivider.requestRender();
      updateDiffFileTree();
    };
    const finishDiffTreeDrag = () => {
      if (!diffDividerDragging) return;
      diffDividerDragging = false;
      diffDivider.requestRender();
      if (artifactBody.width > 0) diffTreeRatio = diffTreeWidth / artifactBody.width;
      persistedConfig.diffTreeRatio = diffTreeRatio;
      persistedConfig.diffTreeWidth = diffTreeWidth;
      void persistTUIConfig({
        ...persistedConfig,
        theme: activeThemeName,
        diffTreeWidth,
        ...(diffTreeRatio !== undefined ? { diffTreeRatio } : {}),
      }).catch((error) =>
        setStatus(`Sidebar resized, but could not save: ${errorMessage(error)}`, true),
      );
    };
    diffDivider.onMouseDown = (event) => {
      diffDividerDragging = true;
      diffDivider.requestRender();
      resizeDiffTree(event.x);
      event.preventDefault();
    };
    artifactBody.onMouseDrag = (event) => {
      if (diffDividerDragging) resizeDiffTree(event.x);
    };
    artifactBody.onMouseDragEnd = finishDiffTreeDrag;
    artifactBody.onMouseUp = finishDiffTreeDrag;
    diffFileList.onMouseDown = (event) => {
      diffFileList.focus();
      const options = diffFileList.options;
      const scrollOffset = listScrollOffset(diffFileList);
      const clickedIndex =
        scrollOffset + Math.floor(event.y - diffFileList.y);
      if (clickedIndex >= 0 && clickedIndex < options.length) {
        diffFileList.setSelectedIndex(clickedIndex);
        activateDiffTreeEntry(options[clickedIndex]?.value, true);
      }
    };
    diffFileList.on(SelectRenderableEvents.SELECTION_CHANGED, (_index, option) => {
      activateDiffTreeEntry(option?.value, false);
    });
    diffFileList.on(SelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
      activateDiffTreeEntry(option?.value, true);
    });
    function activateDiffTreeEntry(value: unknown, toggleDirectory: boolean): void {
      const entry = value as GitDiffTreeEntry | undefined;
      if (!entry || view.artifact !== "diff") return;
      if (entry.kind === "directory") {
        if (!toggleDirectory) return;
        if (collapsedDiffDirectories.has(entry.path))
          collapsedDiffDirectories.delete(entry.path);
        else collapsedDiffDirectories.add(entry.path);
        updateDiffFileTree(entry.path);
        return;
      }
      jumpToDiffLine(entry.rowIndex);
    }
    /** Jump to a row by its index in the full parsed diff (tree row index). */
    function jumpToDiffLine(lineIndex: unknown): void {
      if (view.artifact !== "diff" || typeof lineIndex !== "number") return;
      const rowIndex = artifactRows.findIndex(
        (row) => row.lineIndex === lineIndex,
      );
      if (rowIndex < 0) return;
      jumpToDiffRow(rowIndex);
    }
    function jumpToDiffRow(rowIndex: number): void {
      if (view.artifact !== "diff") return;
      const previousRow = selectedRow;
      selectedRow = rowIndex;
      artifactFollowing = false;
      artifactScroll.stickyScroll = false;
      refreshArtifactRow(previousRow);
      refreshArtifactRow(selectedRow);
      artifactScroll.scrollTo({ x: 0, y: Math.max(0, selectedRow - 1) });
      updateChrome();
    }

    // Diff rows carry placeholder context lines for the blank spacer rows so
    // boundary search keeps working on the visible row list.
    function diffRowLines(): GitDiffLine[] {
      return artifactRows.map(
        (row) => row.diff ?? { kind: "context", text: "" },
      );
    }

    function moveToDiffBoundary(kind: "hunk" | "file", direction: number): void {
      const lines = diffRowLines();
      const target = nextGitDiffBoundary(lines, selectedRow, kind, direction);
      if (target === undefined) {
        setStatus(`No diff ${kind}s`, true);
        return;
      }
      jumpToDiffRow(target);
      syncDiffTreeToRow(target);
      const boundaries = lines.flatMap((line, index) =>
        line.kind === kind ? [index] : [],
      );
      setStatus(`${kind === "hunk" ? "Hunk" : "File"} ${boundaries.indexOf(target) + 1} of ${boundaries.length}`);
    }

    function syncDiffTreeToRow(rowIndex: number): void {
      const path = artifactRows[rowIndex]?.diff?.path;
      if (!path) return;
      const optionIndex = diffFileList.options.findIndex(
        (option) =>
          (option.value as GitDiffTreeEntry | undefined)?.kind === "file" &&
          (option.value as GitDiffTreeEntry).path === path,
      );
      if (optionIndex >= 0 && optionIndex !== diffFileList.getSelectedIndex())
        diffFileList.setSelectedIndex(optionIndex);
    }

    function toggleDiffFile(path: string): void {
      if (view.artifact !== "diff") return;
      const folded = !collapsedDiffFiles.has(path);
      if (folded) collapsedDiffFiles.add(path);
      else collapsedDiffFiles.delete(path);
      setArtifactRows(buildDiffRows());
      const headerRow = artifactRows.findIndex(
        (row) => row.diff?.kind === "file" && row.diff.path === path,
      );
      if (headerRow >= 0) jumpToDiffRow(headerRow);
      updateDiffFileTree(path);
      setStatus(`${folded ? "Folded" : "Unfolded"} ${path}`);
    }

    function toggleAllDiffFiles(): void {
      if (view.artifact !== "diff" || diffLines.length === 0) return;
      const paths = [...diffFileStats.keys()];
      const foldAll = collapsedDiffFiles.size < paths.length;
      collapsedDiffFiles.clear();
      if (foldAll) for (const path of paths) collapsedDiffFiles.add(path);
      setArtifactRows(buildDiffRows());
      if (selectedRow >= artifactRows.length) selectedRow = 0;
      renderArtifactRows(true);
      updateDiffFileTree();
      setStatus(foldAll ? "Folded every file" : "Unfolded every file");
    }
    renderer.on("resize", () => {
      updateChrome();
      if (view.artifact !== "diff") applySessionFilter();
      renderArtifactRows(true);
    });
    themePanel.onMouseDown = () => themePicker.focus();

    themePicker.on(
      SelectRenderableEvents.SELECTION_CHANGED,
      (_index, option) => {
        if (themePickerOpen && option?.value) applyTheme(option.value);
      },
    );
    // TODO(review): Confirm OpenTUI's keyboard ordering does not deliver Enter to both this ITEM_SELECTED handler and the global keypress handler.
    themePicker.on(SelectRenderableEvents.ITEM_SELECTED, () => {
      if (themePickerOpen) void commitThemePicker();
    });
    modelPicker.on(SelectRenderableEvents.ITEM_SELECTED, () => {
      if (modelPickerOpen) commitModelPicker();
    });
    dejaPicker.on(SelectRenderableEvents.ITEM_SELECTED, () => {
      if (dejaPickerOpen) commitDejaPicker();
    });

    searchInput.on(InputRenderableEvents.INPUT, (value: string) => {
      if (searchMode === "sessions") {
        sessionQuery = value;
        applySessionFilter();
      } else if (searchMode === "artifact") {
        artifactQueries[view.artifact] = value;
        renderArtifactRows(true);
      }
      updateChrome();
    });

    sessionList.on(
      SelectRenderableEvents.SELECTION_CHANGED,
      (_index, option) => {
        const changed = option?.value !== view.selectedStateDir;
        view = reduceView(view, { type: "select", stateDir: option?.value });
        if (changed) {
          if (!promptMode) {
            pendingModel = undefined;
            pendingResume = undefined;
          }
          resetArtifactPosition();
        }
        void updateSelectedSession();
        updateChrome();
      },
    );

    renderer.keyInput.on("keypress", (key) => {
      if (key.ctrl && key.name === "c") {
        key.preventDefault();
        key.stopPropagation();
        void shutdown();
        return;
      }
      if (contextOpen) {
        key.preventDefault();
        key.stopPropagation();
        if (key.name === "escape" || key.name === "q") closeContextMenu();
        else if (key.name === "return" || key.name === "enter") runContextItem();
        else if (key.name === "up" || key.name === "k") contextList.moveUp(1);
        else if (key.name === "down" || key.name === "j") contextList.moveDown(1);
        return;
      }
      if (paletteOpen) {
        if (key.name === "escape") {
          key.preventDefault();
          key.stopPropagation();
          closePalette();
        } else if (key.name === "return" || key.name === "enter") {
          key.preventDefault();
          key.stopPropagation();
          runPaletteSelection();
        } else if (key.name === "up" || (key.ctrl && key.name === "p")) {
          key.preventDefault();
          key.stopPropagation();
          paletteList.moveUp(1);
        } else if (key.name === "down" || (key.ctrl && key.name === "n")) {
          key.preventDefault();
          key.stopPropagation();
          paletteList.moveDown(1);
        }
        return;
      }
      if (key.ctrl && key.name === "k") {
        key.preventDefault();
        key.stopPropagation();
        if (!promptMode && !searchMode) openPalette();
        return;
      }
      if (themePickerOpen) {
        if (key.name === "escape" || key.name === "t") {
          key.preventDefault();
          key.stopPropagation();
          cancelThemePicker();
        } else if (key.name === "return" || key.name === "enter") {
          key.preventDefault();
          key.stopPropagation();
          void commitThemePicker();
        }
        return;
      }
      if (modelPickerOpen) {
        if (key.name === "escape" || key.name === "m") {
          key.preventDefault();
          key.stopPropagation();
          closeModelPicker();
        } else if (key.name === "return" || key.name === "enter") {
          key.preventDefault();
          key.stopPropagation();
          commitModelPicker();
        }
        return;
      }
      if (dejaPickerOpen) {
        if (key.name === "escape") {
          key.preventDefault();
          key.stopPropagation();
          closeDejaPicker();
        } else if (key.name === "return" || key.name === "enter") {
          key.preventDefault();
          key.stopPropagation();
          commitDejaPicker();
        }
        return;
      }
      if (searchMode) {
        if (key.name === "escape") {
          key.preventDefault();
          key.stopPropagation();
          clearAndCloseSearch();
        } else if (key.name === "return" || key.name === "enter") {
          key.preventDefault();
          key.stopPropagation();
          if (searchMode === "deja") void submitDejaSearch();
          else closeSearch();
        }
        return;
      }
      if (sessionsVisible) {
        if (
          key.name === "escape" ||
          key.name === "tab" ||
          key.name === "return" ||
          key.name === "enter"
        ) {
          key.preventDefault();
          key.stopPropagation();
          hideSessions();
        } else if (key.name === "/") {
          key.preventDefault();
          key.stopPropagation();
          openSearch();
        } else if (key.name === "q") {
          key.preventDefault();
          key.stopPropagation();
          void shutdown();
        }
        return;
      }
      if (promptMode) {
        // Enter submits through the textarea's own binding; Shift/Alt+Enter
        // and Ctrl+J insert newlines there, so only Escape is handled here.
        if (key.name === "escape") {
          key.preventDefault();
          key.stopPropagation();
          closePrompt();
        }
        return;
      }

      if (view.focus === "artifact" && view.artifact === "diff") {
        if (key.name === "[" || key.name === "]") {
          key.preventDefault();
          key.stopPropagation();
          diffNavigationPrefix = key.name;
          if (diffNavigationTimer) clearTimeout(diffNavigationTimer);
          diffNavigationTimer = setTimeout(() => {
            diffNavigationPrefix = undefined;
          }, 1_200);
          setStatus(`${key.name}c hunk · ${key.name}f file`);
          return;
        }
        if (diffNavigationPrefix && (key.name === "c" || key.name === "f")) {
          key.preventDefault();
          key.stopPropagation();
          const direction = diffNavigationPrefix === "]" ? 1 : -1;
          const kind = key.name === "c" ? "hunk" : "file";
          diffNavigationPrefix = undefined;
          if (diffNavigationTimer) clearTimeout(diffNavigationTimer);
          moveToDiffBoundary(kind, direction);
          return;
        }
        diffNavigationPrefix = undefined;
        if (diffNavigationTimer) clearTimeout(diffNavigationTimer);
        if (key.name === "z" && key.shift) {
          key.preventDefault();
          key.stopPropagation();
          toggleAllDiffFiles();
          return;
        }
        if (key.name === "z" || key.name === "space") {
          key.preventDefault();
          key.stopPropagation();
          activateSelectedRow();
          return;
        }
      }

      const navigation = dashboardNavigation(layout, view.focus, key.name);
      if (navigation) {
        key.preventDefault();
        key.stopPropagation();
        if (navigation === "show-sessions") showSessions();
        else if (navigation === "focus-sessions") focusSessions();
        else focusArtifact();
        return;
      }

      const handled =
        [
          "q",
          "r",
          "tab",
          "o",
          "s",
          "x",
          "i",
          "/",
          "n",
          "m",
          "f",
          "c",
          "return",
          "enter",
          "end",
          "t",
          ":",
          "?",
        ].includes(key.name) ||
        (view.focus === "artifact" && (key.name === "j" || key.name === "k"));
      if (handled) {
        key.preventDefault();
        key.stopPropagation();
      }
      if (key.name === "q") {
        void shutdown();
        return;
      }
      if (key.name === ":" || key.name === "?") openPalette();
      else if (key.name === "t") openThemePicker();
      else if (key.name === "r" && key.shift) openPrompt("continue");
      else if (key.name === "r") void refresh("Refreshing sessions…");
      else if (key.name === "o") setArtifact(nextArtifactView());
      else if (key.name === "s") openPrompt("auto");
      else if (key.name === "n" && !key.shift) {
        if (view.focus === "artifact" && artifactQueries[view.artifact].trim())
          moveToSearchMatch(1);
        else startNewSessionFlow();
      }
      else if (key.name === "m") openModelPicker();
      else if (key.name === "f") openDejaSearch();
      else if (key.name === "x") void requestInterrupt();
      else if (key.name === "i") {
        cycleDetails();
      } else if (key.name === "/") openSearch();
      else if (key.name === "n" && key.shift) moveToSearchMatch(-1);
      else if (key.name === "c") copyCurrentSelection();
      else if (
        (key.name === "return" || key.name === "enter") &&
        view.focus === "artifact"
      )
        activateSelectedRow();
      else if (key.name === "end" && view.focus === "artifact")
        resumeFollowing();
      else if (view.focus === "artifact" && key.name === "j")
        moveSelectedRow(1);
      else if (view.focus === "artifact" && key.name === "k")
        moveSelectedRow(-1);
      else if (
        view.focus === "artifact" &&
        (key.name === "up" || key.name === "down")
      )
        setTimeout(updateFollowFromPosition, 0);
    });

    function selectedSession(): Session | undefined {
      return sessions.find(
        (session) => session.stateDir === view.selectedStateDir,
      );
    }

    function openThemePicker(): void {
      themeBeforePicker = activeThemeName;
      themePickerOpen = true;
      themePanel.visible = true;
      const selectedIndex = themes.findIndex(
        (theme) => theme.name === activeThemeName,
      );
      themePicker.setSelectedIndex(Math.max(0, selectedIndex));
      themePicker.focus();
    }

    function closeThemePicker(): void {
      themePickerOpen = false;
      themePanel.visible = false;
      focusCurrentPanel();
    }

    function cancelThemePicker(): void {
      applyTheme(themeBeforePicker);
      closeThemePicker();
      setStatus(`Kept ${findTheme(activeThemeName)!.label} theme`);
    }

    async function commitThemePicker(): Promise<void> {
      const selected = themePicker.getSelectedOption()?.value as
        | string
        | undefined;
      if (selected) applyTheme(selected);
      closeThemePicker();
      try {
        await persistTheme(activeThemeName);
        setStatus(`Theme saved: ${findTheme(activeThemeName)!.label}`, "success");
      } catch (error) {
        setStatus(`Theme changed, but could not save: ${errorMessage(error)}`, true);
      }
    }

    function applyTheme(name: string): void {
      const theme = findTheme(name);
      if (!theme) return;
      activeThemeName = theme.name;
      palette = theme.palette;
      renderer.setBackgroundColor(palette.background);
      root.backgroundColor = palette.background;
      rightColumn.backgroundColor = palette.background;
      artifactPanel.backgroundColor = palette.background;
      sessionList.backgroundColor = palette.panel;
      sessionList.focusedBackgroundColor = palette.panel;
      sessionList.textColor = palette.text;
      sessionList.focusedTextColor = palette.text;
      sessionList.descriptionColor = palette.dim;
      sessionList.selectedDescriptionColor = palette.text;
      sessionList.selectedBackgroundColor = palette.selected;
      sessionList.selectedTextColor = palette.accent;
      diffFileList.backgroundColor = palette.panel;
      diffFileList.focusedBackgroundColor = palette.panel;
      diffFileList.textColor = palette.dim;
      diffFileList.focusedTextColor = palette.text;
      diffFileList.selectedBackgroundColor = palette.selected;
      diffFileList.selectedTextColor = palette.accent;
      diffDivider.backgroundColor = palette.background;
      diffDivider.requestRender();
      diffSidebar.backgroundColor = palette.panel;
      diffSummaryLine.fg = palette.dim;
      diffTints = diffTintsFor(palette);
      workingIndicator.fg = palette.success;
      sessionsPanel.borderColor = palette.border;
      sessionsPanel.focusedBorderColor = palette.accent;
      sessionsPanel.titleColor = palette.accent;
      details.fg = palette.text;
      detailsPanel.backgroundColor = palette.background;
      detailsPanel.borderColor = palette.border;
      detailsPanel.titleColor = palette.accent;
      artifactScroll.verticalScrollbarOptions = {
        trackOptions: {
          foregroundColor: palette.accent,
          backgroundColor: palette.border,
        },
      };
      statusLine.fg = palette.dim;
      footerLeft.fg = palette.dim;
      footerRight.fg = palette.dim;
      promptMetaLeft.fg = palette.dim;
      promptMetaRight.fg = palette.dim;
      followIndicator.fg = palette.warning;
      chatTab.fg = palette.accent;
      sessionsPanel.backgroundColor = palette.background;
      promptPanel.backgroundColor = palette.background;
      promptPanel.focusedBorderColor = palette.accent;
      for (const picker of [modelPicker, dejaPicker]) {
        picker.backgroundColor = palette.panel;
        picker.focusedBackgroundColor = palette.panel;
        picker.textColor = palette.text;
        picker.focusedTextColor = palette.text;
        picker.descriptionColor = palette.dim;
        picker.selectedDescriptionColor = palette.text;
        picker.selectedBackgroundColor = palette.selected;
        picker.selectedTextColor = palette.accent;
      }
      for (const panel of [modelPanel, dejaPanel]) {
        panel.backgroundColor = palette.background;
        panel.borderColor = palette.accent;
        panel.titleColor = palette.accent;
      }
      for (const input of [searchInput, paletteInput]) {
        input.backgroundColor = palette.panel;
        input.focusedBackgroundColor = palette.selected;
        input.textColor = palette.text;
        input.focusedTextColor = palette.text;
        input.placeholderColor = palette.dim;
      }
      promptInput.backgroundColor = palette.panel;
      promptInput.focusedBackgroundColor = palette.selected;
      promptInput.textColor = palette.text;
      promptInput.focusedTextColor = palette.text;
      promptInput.placeholderColor = palette.dim;
      contextPanel.backgroundColor = palette.panel;
      contextPanel.borderColor = palette.accent;
      contextPanel.titleColor = palette.accent;
      contextList.backgroundColor = palette.panel;
      contextList.focusedBackgroundColor = palette.panel;
      contextList.textColor = palette.text;
      contextList.focusedTextColor = palette.text;
      contextList.descriptionColor = palette.dim;
      contextList.selectedDescriptionColor = palette.text;
      contextList.selectedBackgroundColor = palette.selected;
      contextList.selectedTextColor = palette.accent;
      palettePanel.backgroundColor = palette.background;
      palettePanel.borderColor = palette.accent;
      palettePanel.titleColor = palette.accent;
      paletteList.backgroundColor = palette.background;
      paletteList.focusedBackgroundColor = palette.background;
      paletteList.textColor = palette.text;
      paletteList.focusedTextColor = palette.text;
      paletteList.descriptionColor = palette.dim;
      paletteList.selectedDescriptionColor = palette.text;
      paletteList.selectedBackgroundColor = palette.selected;
      paletteList.selectedTextColor = palette.accent;
      searchPanel.backgroundColor = palette.background;
      searchPanel.borderColor = palette.accent;
      searchPanel.titleColor = palette.accent;
      promptPanel.borderColor = palette.border;
      promptPanel.titleColor = palette.accent;
      themePanel.backgroundColor = palette.background;
      themePanel.borderColor = palette.accent;
      themePanel.titleColor = palette.accent;
      themePicker.backgroundColor = palette.panel;
      themePicker.focusedBackgroundColor = palette.panel;
      themePicker.textColor = palette.text;
      themePicker.focusedTextColor = palette.text;
      themePicker.descriptionColor = palette.dim;
      themePicker.selectedDescriptionColor = palette.text;
      themePicker.selectedBackgroundColor = palette.selected;
      themePicker.selectedTextColor = palette.accent;
      updateDetails();
      renderArtifactRows(true);
      updateChrome();
    }

    function buildPaletteCommands(): PaletteCommand[] {
      const session = selectedSession();
      const stoppable =
        session?.status === "active" || session?.status === "idle";
      const target = promptTargetForSession(session);
      return [
        { id: "prompt", label: "Send a prompt", key: "s", hint: "steer, prompt, or continue the selected session", disabled: target ? undefined : "no promptable session selected" },
        { id: "new", label: "New session", key: "n", hint: "pick a provider and model, then type the first prompt" },
        { id: "continue", label: "Continue thread in a new run", key: "R", hint: "finished sessions only", disabled: target?.route === "continue" ? undefined : "select a finished session with a thread" },
        { id: "model", label: "Choose model", key: "m" },
        { id: "find", label: "Find a past session", key: "f", hint: "deja search", disabled: dejaAvailable ? undefined : "deja is not on PATH" },
        { id: "stop", label: session?.status === "idle" ? "End idle session" : "Interrupt turn", key: "x x", disabled: stoppable ? undefined : "no active or idle session" },
        { id: "tab-chat", label: "Show chat", key: "o" },
        { id: "tab-trace", label: "Show activity", key: "o" },
        { id: "tab-output", label: "Show output", key: "o" },
        { id: "tab-diff", label: "Show diff", key: "o", hint: "tracked changes against HEAD" },
        { id: "fold", label: "Fold or unfold every diff file", key: "Z", disabled: view.artifact === "diff" ? undefined : "diff tab only" },
        { id: "search", label: "Search this pane", key: "/" },
        { id: "filter", label: "Filter sessions", key: "/", hint: "project, thread, status, or model" },
        { id: "follow", label: "Resume live follow", key: "End", disabled: artifactFollowing ? "already following" : undefined },
        { id: "details", label: "Cycle session details", key: "i" },
        { id: "sessions", label: layout === "beta" ? "Open sessions" : "Focus sessions", key: "Tab" },
        { id: "theme", label: "Change theme", key: "t", hint: "live preview" },
        { id: "refresh", label: "Refresh sessions", key: "r" },
        { id: "copy", label: "Copy selected row", key: "c" },
        { id: "quit", label: "Quit", key: "q" },
      ];
    }

    function openPalette(): void {
      paletteCommands = buildPaletteCommands();
      paletteOpen = true;
      palettePanel.visible = true;
      paletteInput.value = "";
      fillPalette("");
      paletteInput.focus();
    }

    function fillPalette(query: string): void {
      const matches = filterPaletteCommands(paletteCommands, query);
      paletteList.options = matches.map((command) => ({
        name: `${command.label}${command.key ? `   ${command.key}` : ""}`,
        description: command.disabled
          ? `unavailable · ${command.disabled}`
          : (command.hint ?? ""),
        value: command.id,
      }));
      paletteList.setSelectedIndex(0);
    }

    function closePalette(): void {
      paletteOpen = false;
      palettePanel.visible = false;
      focusCurrentPanel();
    }

    function runPaletteSelection(): void {
      const id = paletteList.getSelectedOption()?.value as string | undefined;
      const command = paletteCommands.find((candidate) => candidate.id === id);
      closePalette();
      if (!command) return;
      if (command.disabled) {
        setStatus(`${command.label}: ${command.disabled}`, "warning");
        return;
      }
      switch (command.id) {
        case "prompt": openPrompt("auto"); break;
        case "new": startNewSessionFlow(); break;
        case "continue": openPrompt("continue"); break;
        case "model": openModelPicker(); break;
        case "find": openDejaSearch(); break;
        case "stop": void requestInterrupt(); break;
        case "tab-chat": setArtifact("chat"); break;
        case "tab-trace": setArtifact("trace"); break;
        case "tab-output": setArtifact("output"); break;
        case "tab-diff": setArtifact("diff"); break;
        case "fold": toggleAllDiffFiles(); break;
        case "search": focusArtifact(); openSearch(); break;
        case "filter": focusSessions(); openSearch(); break;
        case "follow": resumeFollowing(); break;
        case "details": cycleDetails(); break;
        case "sessions": layout === "beta" ? showSessions() : focusSessions(); break;
        case "theme": openThemePicker(); break;
        case "refresh": void refresh("Refreshing sessions…"); break;
        case "copy": copyCurrentSelection(); break;
        case "quit": void shutdown(); break;
      }
    }

    function focusCurrentPanel(): void {
      if (
        view.focus === "sessions" &&
        (layout === "classic" || sessionsVisible)
      )
        sessionList.focus();
      else {
        view = { ...view, focus: "artifact" };
        artifactScroll.focus();
      }
      updateChrome();
    }

    function focusSessions(): void {
      view = { ...view, focus: "sessions" };
      sessionList.focus();
      updateChrome();
    }

    function focusArtifact(): void {
      view = { ...view, focus: "artifact" };
      artifactScroll.focus();
      updateChrome();
    }

    function setArtifact(artifact: Artifact): void {
      if (view.artifact !== artifact) {
        view = { ...view, artifact };
        resetArtifactPosition();
      }
      focusArtifact();
      updateChrome();
      void updateSelectedSession();
    }

    function resetArtifactPosition(): void {
      artifactKey = "";
      artifactSignature = "";
      selectedRow = -1;
      artifactFollowing = view.artifact !== "diff";
      artifactScroll.stickyScroll = view.artifact !== "diff";
      artifactScroll.stickyStart = view.artifact === "diff" ? "top" : "bottom";
      artifactScroll.scrollTo({ x: 0, y: 0 });
      unseenRows = 0;
      previousRowCount = 0;
      expandedToolIDs = new Set();
    }

    function openSearch(): void {
      searchMode = view.focus === "artifact" ? "artifact" : "sessions";
      searchInput.value =
        searchMode === "sessions"
          ? sessionQuery
          : artifactQueries[view.artifact];
      searchInput.placeholder =
        searchMode === "sessions"
          ? "Filter project, thread, status, or model…"
          : `Search ${
              view.artifact === "trace" ? "activity" : view.artifact
            }…`;
      searchPanel.title =
        searchMode === "sessions"
          ? " Filter sessions · Enter keep · Esc clear "
          : " Search pane · Enter keep · n/N matches · Esc clear ";
      searchPanel.visible = true;
      searchInput.focus();
    }

    function closeSearch(): void {
      searchPanel.visible = false;
      searchMode = undefined;
      focusCurrentPanel();
    }

    function clearAndCloseSearch(): void {
      if (searchMode === "sessions") {
        sessionQuery = "";
        applySessionFilter();
      } else if (searchMode === "artifact") {
        artifactQueries[view.artifact] = "";
        renderArtifactRows(true);
      }
      closeSearch();
    }

    function showSessions(): void {
      sessionsVisible = true;
      sessionsPanel.visible = true;
      view = { ...view, focus: "sessions" };
      sessionList.focus();
      updateChrome();
    }

    function hideSessions(): void {
      sessionsVisible = false;
      sessionsPanel.visible = false;
      view = { ...view, focus: "artifact" };
      artifactScroll.focus();
      updateChrome();
    }

    function nextArtifactView(): Artifact {
      return nextArtifact(view.artifact);
    }

    function cycleDetails(): void {
      if (!detailsPanel.visible) {
        detailsPanel.visible = true;
        detailsExpanded = false;
      } else if (!detailsExpanded) {
        detailsExpanded = true;
      } else {
        detailsPanel.visible = false;
        detailsExpanded = false;
      }
      updateDetails();
    }

    function availableModels(): ModelInfo[] {
      if (promptMode === "new") return models;
      const provider = selectedSession()?.provider;
      return provider
        ? models.filter((model) => model.provider === provider)
        : models;
    }

    function openModelPicker(): void {
      modelPickerOpen = true;
      modelPanel.visible = true;
      const options = modelPickerOptions(availableModels());
      modelPicker.options = options.map((option) => ({
        name: option.name,
        description: option.description,
        value: option.value,
      }));
      const current = pendingModel
        ? options.findIndex((option) => option.model === pendingModel)
        : options.findIndex((option) => option.model.default);
      modelPicker.setSelectedIndex(Math.max(0, current));
      modelPicker.focus();
    }

    function closeModelPicker(): void {
      modelPickerOpen = false;
      modelPanel.visible = false;
      if (promptMode) promptInput.focus();
      else focusCurrentPanel();
      updateChrome();
    }

    function commitModelPicker(): void {
      const selected = modelPicker.getSelectedOption()?.value as
        | string
        | undefined;
      const option = modelPickerOptions(availableModels()).find(
        (candidate) => candidate.value === selected,
      );
      if (!option) return;
      if (option.disabled) {
        setStatus(
          `${option.model.provider} is ${option.model.note || "unavailable"}`,
          true,
        );
        return;
      }
      pendingModel = option.model;
      closeModelPicker();
      setStatus(`Model: ${option.model.label || option.model.id}`);
      updatePromptChrome();
    }

    function startNewSessionFlow(): void {
      pendingResume = undefined;
      pendingModel = undefined;
      promptMode = "new";
      promptTarget = undefined;
      openPromptInput();
      openModelPicker();
    }

    function openDejaSearch(): void {
      if (!dejaAvailable) {
        setStatus("deja is not on PATH; install it to resume past sessions", true);
        return;
      }
      searchMode = "deja";
      searchInput.value = "";
      searchInput.placeholder = "Search past Claude/Codex sessions…";
      searchPanel.title = " deja find · Enter search · Esc cancel ";
      searchPanel.visible = true;
      searchInput.focus();
    }

    async function submitDejaSearch(): Promise<void> {
      const terms = searchInput.value.trim();
      searchPanel.visible = false;
      searchMode = undefined;
      if (!terms) {
        focusCurrentPanel();
        return;
      }
      setStatus(`Searching past sessions for “${terms}”…`);
      try {
        const child = Bun.spawn(
          ["deja", "find", ...terms.split(/\s+/), "--json", "--quiet"],
          { stdout: "pipe", stderr: "pipe" },
        );
        const [stdout, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          child.exited,
        ]);
        if (exitCode !== 0) throw new Error(`deja find exited ${exitCode}`);
        dejaHits = parseDejaHits(stdout);
        if (dejaHits.length === 0) {
          setStatus(`No resumable sessions matched “${terms}”`, true);
          focusCurrentPanel();
          return;
        }
        openDejaPicker();
      } catch (error) {
        setStatus(errorMessage(error), true);
        focusCurrentPanel();
      }
    }

    function openDejaPicker(): void {
      dejaPickerOpen = true;
      dejaPanel.visible = true;
      dejaPicker.options = dejaHits.map((hit, index) => ({
        name: `${hit.provider}  ${hit.project || "unknown project"}  ${hit.date}`,
        description: hit.openingPrompt.slice(0, 120) || hit.sessionId,
        value: String(index),
      }));
      dejaPicker.setSelectedIndex(0);
      dejaPicker.focus();
      setStatus(`${dejaHits.length} resumable sessions found`, "success");
    }

    function closeDejaPicker(): void {
      dejaPickerOpen = false;
      dejaPanel.visible = false;
      focusCurrentPanel();
    }

    function commitDejaPicker(): void {
      const index = Number(dejaPicker.getSelectedOption()?.value ?? -1);
      const hit = dejaHits[index];
      closeDejaPicker();
      if (!hit) return;
      pendingResume = hit;
      pendingModel = undefined;
      promptMode = "new";
      promptTarget = undefined;
      openPromptInput();
      setStatus(
        `Resuming ${hit.provider} session ${hit.sessionId.slice(0, 12)}… — type the next prompt`,
      );
    }

    function openPrompt(mode: "auto" | "continue"): void {
      const session = selectedSession();
      const target = promptTargetForSession(session);
      if (!target) {
        setStatus(
          mode === "continue"
            ? "Select a finished session with a thread and working directory to continue"
            : session
              ? `Session is ${session.status}; press n for a new session`
              : "No session selected; press n for a new session",
          true,
        );
        return;
      }
      if (
        mode === "continue" &&
        target.route !== "continue"
      ) {
        setStatus(
          "Select a finished session with a thread and working directory to continue",
          true,
        );
        return;
      }
      promptMode = target.route;
      promptTarget = target;
      if (promptMode === "steer" || promptMode === "prompt")
        pendingModel = undefined;
      openPromptInput();
    }

    function openPromptInput(): void {
      view = reduceView(view, { type: "open-steer" });
      promptInput.setText("");
      fitPromptHeight();
      updatePromptChrome();
      promptInput.focus();
      updateChrome();
    }

    function updatePromptChrome(): void {
      const modeTitle =
        promptMode === "steer"
          ? " steer "
          : promptMode === "prompt"
            ? " prompt "
            : promptMode === "continue"
              ? " continue thread "
              : promptMode === "new"
                ? pendingResume
                  ? " resume session "
                  : " new session "
                : "";
      promptPanel.title = modeTitle;
      promptPanel.borderColor = promptMode ? palette.accent : palette.border;
      const promptStateDir = promptTarget?.stateDir;
      const session =
        promptMode && promptMode !== "new" && promptStateDir
          ? discoveredSessions.find(
              (candidate) => candidate.stateDir === promptStateDir,
            )
          : selectedSession();
      const modelLabel =
        pendingModel && (promptMode === "new" || promptMode === "continue")
          ? (pendingModel.label ?? pendingModel.id)
          : (session?.model ?? "");
      const effort = session?.effort ? ` · ${session.effort}` : "";
      promptMetaRight.content = renderUsage(session);
      if (promptMode === "new") {
        const target = pendingResume
          ? `resume ${pendingResume.provider} ${pendingResume.sessionId.slice(0, 12)}…`
          : `new session`;
        promptMetaLeft.content = `${modelLabel || (pendingModel?.provider ?? "codex")} · ${target}`;
        promptInput.placeholder = "First prompt for the session… (Esc cancels)";
        return;
      }
      const route =
        promptMode === "steer" ||
        promptMode === "prompt" ||
        promptMode === "continue"
          ? promptMode
          : promptModeForSession(session);
      if (!session || !route) {
        promptMetaLeft.content = emptyPromptHint(layout);
        promptInput.placeholder = "Ask anything — n starts a new session";
        return;
      }
      const routeLabel =
        route === "steer"
          ? "steering active turn"
          : route === "prompt"
            ? "ready"
            : "continues thread";
      promptMetaLeft.content = [modelLabel, effort ? session.effort : "", routeLabel]
        .filter(Boolean)
        .join(" · ");
      promptInput.placeholder =
        route === "steer"
          ? "Send a new direction to the running turn…"
          : route === "prompt"
            ? "Ask for changes or a follow-up…"
            : "Continue this thread in a new run…";
    }

    function closePrompt(): void {
      pendingModel = undefined;
      pendingResume = undefined;
      promptMode = undefined;
      promptTarget = undefined;
      view = reduceView(view, { type: "close-steer" });
      view = { ...view, focus: "artifact" };
      artifactScroll.focus();
      updatePromptChrome();
      updateChrome();
    }

    async function submitPrompt(): Promise<void> {
      if (actionRunning || !promptMode) return;
      const mode = promptMode;
      const message = promptInput.plainText.trim();
      if (!message) return;
      if (mode === "new") {
        await startNewSession(message);
        return;
      }
      const target = promptTarget;
      if (!target || target.route !== mode) {
        setStatus(
          "The prompt target is no longer available; the prompt was not sent",
          true,
        );
        return;
      }
      const session = resolvePromptTarget(discoveredSessions, target);
      if (!session) {
        const current = discoveredSessions.find(
          (candidate) => candidate.stateDir === target.stateDir,
        );
        setStatus(
          current?.status === "active" && target.route === "steer"
            ? "The active turn changed; the prompt was not sent"
            : current
              ? `Session is now ${current.status}; the prompt was not sent`
            : "The prompt session is no longer available; the prompt was not sent",
          true,
        );
        return;
      }
      if (mode === "steer") await submitSteer(message, session);
      else if (mode === "prompt") await submitIdlePrompt(message, session);
      else await continueThread(message, session);
    }

    async function submitIdlePrompt(
      message: string,
      session: Session,
    ): Promise<void> {
      if (session.status !== "idle") {
        setStatus("Session is no longer idle; the prompt was not sent", true);
        return;
      }
      actionRunning = true;
      closePrompt();
      setStatus("Sending prompt…");
      let scratchDirectory = "";
      try {
        scratchDirectory = await mkdtemp(join(tmpdir(), "ruddr-tui-prompt-"));
        await chmod(scratchDirectory, 0o700);
        const messageFile = join(scratchDirectory, "message.md");
        await writeFile(messageFile, `${message}\n`, { mode: 0o600 });
        const result = await runControl(
          args.ruddr,
          idlePromptControlArguments(session.stateDir, messageFile),
        );
        setStatus(result || "Prompt accepted", "success");
        await refresh();
        setTimeout(() => void refresh(), 300);
      } catch (error) {
        setStatus(errorMessage(error), true);
      } finally {
        actionRunning = false;
        if (scratchDirectory)
          await rm(scratchDirectory, { recursive: true, force: true });
      }
    }

    async function startNewSession(message: string): Promise<void> {
      actionRunning = true;
      const resume = pendingResume;
      const model = pendingModel;
      closePrompt();
      try {
        const provider = resume?.provider ?? model?.provider ?? "codex";
        // TODO(review): Deja hits do not expose their original cwd, so resumes currently use the TUI launch directory.
        const cwd = process.cwd();
        const baseDirectory = join(cwd, ".scratch", "ruddr-tui");
        await mkdir(baseDirectory, { recursive: true, mode: 0o700 });
        await chmod(baseDirectory, 0o700);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const stateDirectory = join(baseDirectory, `${stamp}.run`);
        await mkdir(stateDirectory, { mode: 0o700 });
        const promptFile = join(stateDirectory, "prompt.md");
        await writeFile(promptFile, `${message}\n`, { mode: 0o600 });
        const runArgs = newSessionRunArguments({
          provider,
          model: model?.id,
          cwd,
          promptFile,
          stateDirectory,
          ...(resume ? { resumeThreadId: resume.sessionId } : {}),
        });
        const child = Bun.spawn([args.ruddr, ...runArgs], {
          cwd,
          stdout: "ignore",
          stderr: "ignore",
          stdin: "ignore",
        });
        child.unref();
        args.stateDirs.push(stateDirectory);
        view = reduceView(view, { type: "select", stateDir: stateDirectory });
        setStatus(
          resume
            ? `Resuming ${resume.provider} session…`
            : `Starting ${provider} session…`,
        );
        setTimeout(() => void refresh(), 250);
        setTimeout(() => void refresh(), 1_000);
      } catch (error) {
        setStatus(errorMessage(error), true);
      } finally {
        actionRunning = false;
      }
    }

    async function submitSteer(
      message: string,
      session: Session,
    ): Promise<void> {
      if (session.status !== "active") {
        setStatus("Turn is no longer active; the steer was not sent", true);
        return;
      }
      actionRunning = true;
      closePrompt();
      setStatus(`Steering ${sessionLabel(session)}…`);
      let scratchDirectory = "";
      try {
        scratchDirectory = await mkdtemp(join(tmpdir(), "ruddr-tui-steer-"));
        await chmod(scratchDirectory, 0o700);
        const messageFile = join(scratchDirectory, "message.md");
        await writeFile(messageFile, `${message}\n`, { mode: 0o600 });
        const result = await runControl(
          args.ruddr,
          steerControlArguments(session.stateDir, session.turnId!, messageFile),
        );
        setStatus(result || "Steer accepted", "success");
        await refresh();
      } catch (error) {
        setStatus(errorMessage(error), true);
      } finally {
        actionRunning = false;
        if (scratchDirectory)
          await rm(scratchDirectory, { recursive: true, force: true });
      }
    }

    async function continueThread(
      message: string,
      session: Session,
    ): Promise<void> {
      if (!session?.threadId || !session.cwd || isLive(session)) return;
      const modelOverride = pendingModel;
      actionRunning = true;
      closePrompt();
      try {
        const baseDirectory = join(session.cwd, ".scratch", "ruddr-tui");
        await mkdir(baseDirectory, { recursive: true, mode: 0o700 });
        await chmod(baseDirectory, 0o700);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const stateDirectory = join(baseDirectory, `${stamp}.run`);
        await mkdir(stateDirectory, { mode: 0o700 });
        const promptFile = join(stateDirectory, "prompt.md");
        await writeFile(promptFile, `${message}\n`, { mode: 0o600 });
        const overrides =
          modelOverride &&
          modelOverride.provider === (session.provider ?? "codex")
            ? { model: modelOverride.id }
            : {};
        const runArgs = continuationRunArguments(
          session,
          promptFile,
          stateDirectory,
          overrides,
        );
        const child = Bun.spawn([args.ruddr, ...runArgs], {
          cwd: session.cwd,
          stdout: "ignore",
          stderr: "ignore",
          stdin: "ignore",
        });
        child.unref();
        args.stateDirs.push(stateDirectory);
        setStatus(
          `Started a new run for thread ${session.threadId.slice(0, 12)}`,
          "success",
        );
        setTimeout(() => void refresh(), 250);
      } catch (error) {
        setStatus(errorMessage(error), true);
      } finally {
        actionRunning = false;
      }
    }

    async function requestInterrupt(): Promise<void> {
      if (actionRunning) return;
      const session = selectedSession();
      if (
        !session ||
        (session.status !== "active" && session.status !== "idle")
      ) {
        setStatus("Only an active or idle session can be stopped", true);
        return;
      }
      const idle = session.status === "idle";
      const now = Date.now();
      if (view.interruptArmedUntil < now) {
        view = reduceView(view, { type: "arm-interrupt", now });
        renderStatus();
        return;
      }
      view = reduceView(view, { type: "clear-interrupt" });
      actionRunning = true;
      setStatus(idle ? "Ending idle session…" : "Interrupting selected turn…", "warning");
      try {
        const result = await runControl(args.ruddr, [
          idle ? "stop" : "interrupt",
          "--state-dir",
          session.stateDir,
        ]);
        setStatus(result || (idle ? "Shutdown requested" : "Interrupt requested"), "success");
        await refresh();
      } catch (error) {
        setStatus(errorMessage(error), true);
      } finally {
        actionRunning = false;
      }
    }

    async function refresh(reason?: string): Promise<void> {
      return refreshGate.run(async () => {
        if (reason) setStatus(reason);
        try {
          discoveredSessions = await discoverSessions({
            roots: args.roots,
            stateDirs: args.stateDirs,
          });
          listedSessions = visibleSessions(
            discoveredSessions,
            args.includeAll,
            args.stateDirs,
          );
          applySessionFilter();
          await updateSelectedSession();
          lastRefreshAt = Date.now();
          if (reason) showIdleStatus();
        } catch (error) {
          setStatus(errorMessage(error), true);
        }
      });
    }

    function applySessionFilter(): void {
      const selectedStateDir = view.selectedStateDir;
      sessions = filterSessions(listedSessions, sessionQuery);
      view = reduceView(view, { type: "sessions", sessions });
      sessionList.options = sessions.map((session) => ({
        name: sessionCardTitle(session),
        description: sessionDescription(session),
        value: session.stateDir,
      }));
      const selectedIndex = sessions.findIndex(
        (session) => session.stateDir === selectedStateDir,
      );
      if (selectedIndex >= 0) {
        const keep = sessionScrollOffset;
        sessionList.setSelectedIndex(selectedIndex);
        view = reduceView(view, { type: "select", stateDir: selectedStateDir });
        sessionScrollOffset = keep;
      }
      if (sessionScrollOffset !== undefined)
        sessionScrollOffset = scrollListBy(
          sessionList,
          sessionScrollOffset - listScrollOffset(sessionList),
          2,
        );
      const liveCount = sessions.filter(isLive).length;
      const historyCount = sessions.length - liveCount;
      sessionsPanel.title = sessionsPanelTitle({
        layout,
        liveCount,
        recentCount: historyCount,
        query: sessionQuery,
      });
      updateDetails();
      updateChrome();
    }

    // "● project            2m ago": the age hugs the right edge of the card.
    const SESSION_TAG_CELLS = 8;
    function sessionCardInnerWidth(): number {
      return Math.max(24, (sessionList.width || 36) - 4);
    }
    function sessionCardTitle(session: Session): string {
      const label = sessionLabel(session);
      const separator = label.lastIndexOf("  ");
      const head = separator > 0 ? label.slice(0, separator) : label;
      const age = separator > 0 ? label.slice(separator + 2) : "";
      const room = sessionCardInnerWidth() - [...age].length - 1 - SESSION_TAG_CELLS;
      const shownHead =
        [...head].length > room ? `${[...head].slice(0, Math.max(1, room - 1)).join("")}…` : head;
      return `${shownHead.padEnd(room)}${" ".repeat(SESSION_TAG_CELLS)} ${age}`;
    }

    async function updateSelectedSession(): Promise<void> {
      const session = selectedSession();
      updateDetails();
      if (!session) {
        setArtifactRows([
          {
            id: "empty-action",
            text: "No sessions yet. Press n or click here to start one.",
            copyText: "",
            action: () => startNewSessionFlow(),
          },
        ]);
        return;
      }
      const currentKey = `${session.stateDir}:${view.artifact}`;
      const forceDiff = artifactKey !== currentKey;
      if (artifactKey !== currentKey) {
        artifactKey = currentKey;
        artifactSignature = "";
        // The diff reads top-down; every other artifact tails its newest rows.
        artifactFollowing = view.artifact !== "diff";
        artifactScroll.stickyScroll = artifactFollowing;
        if (!artifactFollowing) artifactScroll.scrollTo({ x: 0, y: 0 });
        unseenRows = 0;
        previousRowCount = 0;
        selectedRow = -1;
      }
      const artifactPath =
        view.artifact === "trace" ? session.tracePath : session.outputPath;
      const diffResult =
        view.artifact === "diff" && session.cwd
          ? await readWorkspaceDiff(session.cwd, forceDiff)
          : undefined;
      const [content, eventContent] = await Promise.all([
        view.artifact === "chat" || view.artifact === "diff"
          ? Promise.resolve("")
          : readTail(artifactPath, ARTIFACT_TAIL_BYTES),
        view.artifact === "output" || view.artifact === "diff"
          ? Promise.resolve("")
          : readTail(session.eventsPath, ARTIFACT_TAIL_BYTES),
      ]);
      if (session.stateDir !== view.selectedStateDir) return;
      if (view.artifact === "chat") {
        const entries = parseChatTranscript(eventContent, session.threadId);
        const rows: ActivityRow[] = [];
        const initialLoad = artifactSignature === "";
        for (const [index, entry] of entries.entries()) {
          const previous = entries[index - 1];
          // Breathing room: a blank line before each speaker change keeps the
          // transcript readable the way opencode's conversation flow is.
          if (previous && entry.kind !== previous.kind)
            rows.push({ id: `chat-gap:${index}`, text: "", copyText: "" });
          rows.push({
            id: `chat:${entry.itemId ?? index}`,
            chat: entry,
            text: entry.text,
            copyText: entry.text,
          });
        }
        // Stream only text that arrived while we were watching; a transcript
        // opened mid-session appears fully written.
        const lastAgent = [...rows].reverse().find((row) => row.chat?.kind === "agent");
        if (lastAgent && sessionIsWorking(session)) {
          const previousLength = seenAgentLength.get(lastAgent.id);
          if (!initialLoad && previousLength !== lastAgent.text.length) {
            const from =
              stream?.id === lastAgent.id ? stream.revealed : (previousLength ?? 0);
            stream = { id: lastAgent.id, revealed: from, target: lastAgent.text.length };
          }
        } else if (stream && lastAgent?.id !== stream.id) stream = undefined;
        for (const row of rows)
          if (row.chat?.kind === "agent") seenAgentLength.set(row.id, row.text.length);
        setArtifactRows(
          rows.length > 0
            ? [...rows, ...liveRow(session)]
            : [
                session.status === "starting"
                  ? { id: "empty", text: "Session is starting…", copyText: "" }
                  : {
                      id: "empty-action",
                      text: "No conversation yet. Press s or click here to send a prompt.",
                      copyText: "",
                      action: () => openPrompt("auto"),
                    },
                ...liveRow(session),
              ],
        );
      } else if (view.artifact === "trace") {
        let activities = parseTraceActivities(content);
        const fullUpdate = latestAgentUpdate(eventContent);
        if (fullUpdate) {
          activities = activities.filter(
            (activity) => activity.kind !== "message",
          );
          activities.push({ timestamp: "", kind: "message", text: fullUpdate });
        }
        activities = activities.slice(-ACTIVITY_HISTORY_LIMIT);
        const detailsByActivity = attachToolDetails(
          activities,
          parseToolEventDetails(eventContent),
        );
        const rows = activities.map((activity, index) => {
          const detail = detailsByActivity[index];
          const id =
            detail?.id || `${activity.kind}:${activity.timestamp}:${index}`;
          return {
            id,
            activity,
            detail,
            text: activitySearchText(activity, detail),
            copyText: activityCopyText(activity, detail),
          };
        });
        setArtifactRows(
          rows.length > 0
            ? [...rows, ...liveRow(session)]
            : [
                {
                  id: "empty",
                  text: "No activity has been recorded yet.",
                  copyText: "",
                },
                ...liveRow(session),
              ],
        );
      } else if (view.artifact === "output") {
        const output = visibleArtifactTail(content, OUTPUT_HISTORY_LINES);
        const rows = output
          ? output.split("\n").map((line, index) => ({
              id: `output:${index}`,
              text: line,
              copyText: line,
            }))
          : [
              {
                id: "empty",
                text: "No output has been written yet.",
                copyText: "",
              },
            ];
        setArtifactRows(rows);
      } else {
        diffLines = parseGitDiff(diffResult?.content ?? "");
        diffSummary = gitDiffSummary(diffLines);
        diffFileStats = gitDiffFileStats(diffLines);
        diffGutterWidth = gitDiffGutterWidth(diffLines);
        diffSpans = highlightDiffLines(diffLines);
        diffError =
          diffResult?.error ??
          (session.cwd ? undefined : "This session has no working directory.");
        for (const path of collapsedDiffFiles)
          if (!diffFileStats.has(path)) collapsedDiffFiles.delete(path);
        const touchedSignature = `${session.stateDir}:${session.startedAt}:${[...diffFileStats.keys()].join("\u0000")}:${diffResult?.content.length ?? 0}`;
        if (touchedSignature !== diffTouchedSignature && session.cwd) {
          diffTouchedSignature = touchedSignature;
          diffTouchedPaths = await touchedSince(
            session.cwd,
            diffFileStats.keys(),
            session.startedAt,
          );
          if (session.stateDir !== view.selectedStateDir) return;
          artifactSignature = "";
        }
        setArtifactRows(buildDiffRows());
      }
    }


    function highlightDiffLines(lines: readonly GitDiffLine[]): Array<CodeSpan[] | undefined> {
      const result: Array<CodeSpan[] | undefined> = new Array(lines.length);
      let hunkStart = -1;
      const flush = (end: number) => {
        if (hunkStart < 0) return;
        const filetype = filetypeForPath(lines[hunkStart].path);
        const contentLines = lines.slice(hunkStart, end).map((line) => line.text.slice(1));
        const spans = highlightLines(contentLines, filetype);
        for (const [offset, lineSpans] of spans.entries()) result[hunkStart + offset] = lineSpans;
        hunkStart = -1;
      };
      for (const [index, line] of lines.entries()) {
        const isContent =
          line.kind === "addition" || line.kind === "deletion" || line.kind === "context";
        if (isContent) {
          if (hunkStart < 0) hunkStart = index;
        } else flush(index);
      }
      flush(lines.length);
      return result;
    }

    function buildDiffRows(): ActivityRow[] {
      if (diffLines.length === 0) {
        if (diffError)
          return [
            { id: "empty", text: `× ${diffError}`, copyText: "" },
            {
              id: "empty-action",
              text: "  Click here or press Enter to retry.",
              copyText: "",
              action: () => {
                const cwd = selectedSession()?.cwd;
                if (cwd) diffCache.delete(cwd);
                artifactSignature = "";
                void updateSelectedSession();
              },
            },
          ];
        return [
          { id: "empty", text: "✓ Working tree matches HEAD", copyText: "" },
          {
            id: "empty-hint",
            text: "  Tracked changes appear here as the session edits files. Untracked files are not shown.",
            copyText: "",
          },
        ];
      }
      const rows: ActivityRow[] = [];
      for (const index of visibleGitDiffLineIndices(diffLines, collapsedDiffFiles)) {
        const diff = diffLines[index];
        if (diff.kind === "file" && rows.length > 0)
          rows.push({ id: `diff-gap:${diff.path}`, text: "", copyText: "" });
        rows.push({
          id: `diff:${index}:${diff.text}`,
          diff,
          lineIndex: index,
          text: diff.text,
          copyText: diff.text,
        });
      }
      return rows;
    }

    function liveRow(session: Session | undefined): ActivityRow[] {
      return session?.status === "active" || session?.status === "starting"
        ? [{ id: LIVE_ROW_ID, live: true, text: "", copyText: "" }]
        : [];
    }

    function artifactRowMenu(row: ActivityRow): MenuItem[] {
      const items: MenuItem[] = [];
      if (row.copyText)
        items.push({ label: "Copy row", run: () => copyText(row.copyText) });
      if (row.diff?.path) {
        const path = row.diff.path;
        items.push(
          {
            label: collapsedDiffFiles.has(path) ? "Unfold file" : "Fold file",
            hint: path,
            run: () => toggleDiffFile(path),
          },
          {
            label: collapsedDiffFiles.size < diffFileStats.size ? "Fold every file" : "Unfold every file",
            run: () => toggleAllDiffFiles(),
          },
          { label: "Copy file path", hint: path, run: () => copyText(path) },
        );
      }
      if (row.activity?.kind === "tool")
        items.push({
          label: expandedToolIDs.has(row.id) ? "Collapse tool" : "Expand tool",
          run: () => toggleTool(row.id),
        });
      if (row.action) items.push({ label: "Run", run: row.action });
      if (!artifactFollowing && view.artifact !== "diff")
        items.push({ label: "Resume live follow", run: () => resumeFollowing() });
      return items;
    }

    function activateSelectedRow(): void {
      const row = artifactRows[selectedRow];
      if (!row) return;
      if (row.action) row.action();
      else if (row.diff?.path) toggleDiffFile(row.diff.path);
      else toggleSelectedTool();
    }

    function setArtifactRows(rows: ActivityRow[]): void {
      const nextSignature = rows
        .map(
          (row) =>
            `${row.id}:${row.text}:${row.detail?.status}:${row.detail?.output?.length ?? 0}`,
        )
        .join("\u0000");
      if (nextSignature === artifactSignature) return;
      if (!artifactFollowing && artifactSignature)
        unseenRows += Math.max(0, rows.length - previousRowCount);
      artifactRows = rows;
      if (view.artifact === "diff") updateDiffFileTree();
      previousRowCount = rows.length;
      artifactSignature = nextSignature;
      if (selectedRow >= rows.length) selectedRow = rows.length - 1;
      renderArtifactRows(true);
      updateChrome();
    }

    function updateDiffFileTree(selectedPath?: string): void {
      const entries = gitDiffTree(
        diffLines,
        collapsedDiffDirectories,
        collapsedDiffFiles,
      );
      diffFileList.options = entries.map((entry) => ({
        name: entry.kind === "file" ? diffTreeFileName(entry) : entry.label,
        description: "",
        value: entry,
      }));
      updateDiffSummaryLine();
      if (selectedPath) {
        const selectedIndex = entries.findIndex(
          (entry) => entry.path === selectedPath,
        );
        if (selectedIndex >= 0) diffFileList.setSelectedIndex(selectedIndex);
      }
    }

    // Leaves a fixed column free on the right for "M  +12 −3" so the counts
    // drawn by renderAfter never overlap a long file name.
    function diffTreeFileName(entry: GitDiffTreeEntry): string {
      const match = /^(\s*)  󰈔 (.+?)  [MADR]  (\+\d+ −\d+)$/.exec(entry.label);
      if (!match) return entry.label;
      const [, indent, name, counts] = match;
      const icon = entry.collapsed ? "▸" : "󰈔";
      const reserved = counts.length + 4 + 4; // status letter, gaps, indicator
      const available = Math.max(6, diffTreeWidth - 3 - indent.length - 4 - reserved);
      const shown =
        name.length <= available
          ? name
          : `${name.slice(0, Math.max(1, Math.ceil((available - 1) / 2)))}…${name.slice(-(Math.floor((available - 1) / 2)))}`;
      return `${indent}  ${icon} ${shown}`;
    }

    function updateDiffSummaryLine(): void {
      if (!diffSummary || diffSummary.files === 0) {
        diffSummaryLine.content = t`${fg(palette.dim)("no changes")}`;
        return;
      }
      const folded =
        collapsedDiffFiles.size > 0 ? ` · ${collapsedDiffFiles.size} folded` : "";
      diffSummaryLine.content = t`${fg(palette.text)(`${diffSummary.files} ${diffSummary.files === 1 ? "file" : "files"}`)} ${fg(palette.success)(`+${diffSummary.additions}`)} ${fg(palette.danger)(`−${diffSummary.deletions}`)}${fg(palette.dim)(folded)}`;
    }

    function renderArtifactRows(preserveScroll: boolean): void {
      const oldScrollTop = artifactScroll.scrollTop;
      for (const row of rowRenderables) {
        artifactScroll.remove(row);
        row.destroy();
      }
      rowRenderables = artifactRows.map((row, index) => {
        const match = rowMatchesQuery(row);
        // scrollX leaves the content box unbounded, so "100%" would never
        // wrap; pin prose rows to the viewport width instead.
        const renderable = new TextRenderable(renderer, {
          id: `artifact-row-${index}`,
          width: view.artifact === "diff" ? diffRowWidth(row) : proseRowWidth(),
          wrapMode: view.artifact === "diff" ? "none" : "word",
          content: renderArtifactRow(row, match, index === selectedRow),
          fg: palette.text,
          // Activity is a structured list: mouse gestures select/expand rows.
          // Letting OpenTUI begin a text selection first also activates its
          // drag auto-scroll, which makes an ordinary click feel erratic.
          selectable: artifactAllowsTextSelection(view.artifact),
        });
        renderable.onMouseDown = (event) => {
          focusArtifact();
          const previousRow = selectedRow;
          selectedRow = index;
          refreshArtifactRow(previousRow);
          if (event.button === 2) {
            refreshArtifactRow(index);
            event.preventDefault();
            openContextMenu(artifactRowMenu(row), event.x, event.y);
            return;
          }
          if (row.action) row.action();
          else if (row.activity?.kind === "tool") toggleTool(row.id);
          else if (row.diff?.kind === "file" && row.diff.path)
            toggleDiffFile(row.diff.path);
          else {
            refreshArtifactRow(index);
            if (row.diff) syncDiffTreeToRow(index);
          }
        };
        artifactScroll.add(renderable);
        return renderable;
      });
      if (artifactFollowing) resumeFollowing(false);
      else if (view.artifact === "diff" && !preserveScroll)
        artifactScroll.scrollTo({ x: 0, y: 0 });
      else if (preserveScroll) artifactScroll.scrollTop = oldScrollTop;
    }

    function renderArtifactRow(
      row: ActivityRow,
      match: boolean,
      selected: boolean,
    ): string | StyledText {
      const selection = selected ? t`${bold(fg(palette.accent)("▎"))}` : t` `;
      const marker = match ? t`${bold(fg(palette.warning)("◆ "))}` : t``;
      if (row.chat)
        return new StyledText([
          ...selection.chunks,
          ...marker.chunks,
          ...renderChatEntry(
            row.chat,
            stream?.id === row.id ? stream.revealed : undefined,
          ).chunks,
        ]);
      if (row.action)
        return new StyledText([
          ...selection.chunks,
          ...marker.chunks,
          ...t`${underline(fg(palette.accent)(row.text.trimStart()))}`.chunks,
        ]);
      if (row.live)
        return t`${fg(palette.success)(spinnerFrame(animationTick))} ${italic(fg(palette.dim)(liveRowText()))}`;
      if (row.diff) return renderDiffRow(row, match, selected);
      if (view.artifact === "diff" && row.id.startsWith("diff-gap:"))
        return renderDiffSpacerRow(row, selected);
      if (view.artifact === "output" || !row.activity) {
        // Empty-state rows lead with a status glyph; color it like a toast.
        const glyphColor = row.text.startsWith("✓ ")
          ? palette.success
          : row.text.startsWith("× ")
            ? palette.danger
            : undefined;
        const body =
          glyphColor && row.id.startsWith("empty")
            ? t`${bold(fg(glyphColor)(row.text.slice(0, 1)))}${fg(palette.text)(row.text.slice(1))}`
            : t`${fg(row.id.startsWith("empty") ? palette.dim : palette.text)(row.text)}`;
        return new StyledText([
          ...selection.chunks,
          ...marker.chunks,
          ...body.chunks,
        ]);
      }
      const expanded =
        row.activity.kind === "tool" && expandedToolIDs.has(row.id);
      const base = renderTraceActivity(row.activity, row.detail, expanded);
      const chunks = [...selection.chunks, ...marker.chunks, ...base.chunks];
      if (expanded)
        chunks.push(...renderToolDetail(row.detail, row.activity).chunks);
      return new StyledText(chunks);
    }

    function liveRowText(): string {
      const session = selectedSession();
      if (!session) return "";
      const elapsed = formatElapsed(session.startedAt, undefined);
      const verb = session.status === "starting" ? "starting" : "working";
      return `${verb} · ${elapsed}`;
    }

    function renderDiffSpacerRow(row: ActivityRow, selected: boolean): StyledText {
      const width = diffRowWidth(row);
      const text = " ".repeat(width);
      return selected ? t`${bg(palette.selected)(text)}` : t`${text}`;
    }

    function padCells(text: string, width: number): string {
      const missing = width - [...text].length;
      return missing > 0 ? text + " ".repeat(missing) : text;
    }

    function renderDiffRow(
      row: ActivityRow,
      match: boolean,
      selected: boolean,
    ): StyledText {
      const diff = row.diff!;
      const width = diffRowWidth(row);
      const gutterWidth = diffGutterWidth;
      const blankGutter = " ".repeat(diffGutterCells());
      const markerText = match ? "◆" : " ";
      const markerColor = match ? palette.warning : palette.dim;

      if (diff.kind === "file") {
        const path = diff.path ?? diff.text;
        const stats = diffFileStats.get(path);
        const folded = collapsedDiffFiles.has(path);
        const rowBg = selected ? palette.selected : palette.panel;
        const statusColor =
          stats?.status === "A"
            ? palette.success
            : stats?.status === "D"
              ? palette.danger
              : stats?.status === "R"
                ? palette.warning
                : palette.accent;
        const head = ` ${folded ? "▸" : "▾"} ${path}`;
        const counts = stats
          ? `  ${stats.status}  +${stats.additions} −${stats.deletions}`
          : "";
        const tail = padCells("", Math.max(0, width - [...head].length - [...counts].length - (folded ? 9 : 0) - (diffTouchedPaths.has(path) ? 16 : 0)));
        const chunks = [
          ...t`${bg(rowBg)(fg(markerColor)(markerText))}${bg(rowBg)(bold(fg(palette.accent)(head)))}`.chunks,
        ];
        if (stats)
          chunks.push(
            ...t`${bg(rowBg)(fg(palette.dim)("  "))}${bg(rowBg)(bold(fg(statusColor)(stats.status)))}${bg(rowBg)(fg(palette.dim)("  "))}${bg(rowBg)(fg(palette.success)(`+${stats.additions}`))}${bg(rowBg)(fg(palette.dim)(" "))}${bg(rowBg)(fg(palette.danger)(`−${stats.deletions}`))}`
              .chunks,
          );
        if (folded)
          chunks.push(...t`${bg(rowBg)(italic(fg(palette.dim)("  folded")))}`.chunks);
        if (diffTouchedPaths.has(path))
          chunks.push(
            ...t`${bg(rowBg)(fg(palette.dim)("  "))}${bg(rowBg)(fg(palette.accent)("●"))}${bg(rowBg)(fg(palette.dim)(" this session"))}`
              .chunks,
          );
        chunks.push(...t`${bg(rowBg)(tail)}`.chunks);
        return new StyledText(chunks);
      }

      if (diff.kind === "hunk") {
        const header = parseGitDiffHunkHeader(diff.text);
        const rowBg = selected ? palette.selected : diffTints.hunkBg;
        const range = header
          ? `@@ -${header.oldStart},${header.oldCount} +${header.newStart},${header.newCount} @@`
          : diff.text;
        const context = header?.context ? ` ${header.context}` : "";
        const body = ` ${range}${context}`;
        const tail = padCells("", Math.max(0, width - diffGutterCells() - 1 - [...body].length));
        return t`${bg(rowBg)(fg(markerColor)(markerText))}${bg(rowBg)(fg(palette.dim)(blankGutter.slice(1)))}${bg(rowBg)(fg(palette.accent)(` ${range}`))}${bg(rowBg)(italic(fg(palette.dim)(context)))}${bg(rowBg)(tail)}`;
      }

      if (diff.kind === "metadata") {
        const rowBg = selected ? palette.selected : palette.background;
        const body = ` ${diff.text}`;
        const tail = padCells("", Math.max(0, width - diffGutterCells() - 1 - [...body].length));
        return t`${bg(rowBg)(fg(markerColor)(markerText))}${bg(rowBg)(blankGutter.slice(1))}${bg(rowBg)(fg(palette.dim)(body))}${bg(rowBg)(tail)}`;
      }

      const oldNumber =
        diff.oldLine === undefined ? "" : String(diff.oldLine);
      const newNumber =
        diff.newLine === undefined ? "" : String(diff.newLine);
      const gutter = `${oldNumber.padStart(gutterWidth)} ${newNumber.padStart(gutterWidth)} `;
      const sign = diff.text[0] ?? " ";
      const content = diff.text.slice(1);
      const lineBg = selected
        ? palette.selected
        : diff.kind === "addition"
          ? diffTints.additionBg
          : diff.kind === "deletion"
            ? diffTints.deletionBg
            : palette.background;
      const gutterBg = selected
        ? palette.selected
        : diff.kind === "addition"
          ? diffTints.additionGutterBg
          : diff.kind === "deletion"
            ? diffTints.deletionGutterBg
            : palette.background;
      const signColor =
        diff.kind === "addition"
          ? palette.success
          : diff.kind === "deletion"
            ? palette.danger
            : palette.dim;
      const tail = padCells("", Math.max(0, width - diffGutterCells() - 1 - [...content].length));
      return new StyledText([
        ...t`${bg(gutterBg)(fg(markerColor)(markerText))}${bg(gutterBg)(fg(palette.dim)(gutter))}${bg(lineBg)(bold(fg(signColor)(sign)))}`
          .chunks,
        ...spanChunks(
          (row.lineIndex !== undefined ? diffSpans[row.lineIndex] : undefined) ??
            highlightCode(content, filetypeForPath(diff.path)),
          diff.kind === "context",
          lineBg,
        ),
        ...t`${bg(lineBg)(tail)}`.chunks,
      ]);
    }

    function refreshArtifactRow(index: number): void {
      const row = artifactRows[index];
      const renderable = rowRenderables[index];
      if (!row || !renderable) return;
      if (view.artifact === "diff") renderable.width = diffRowWidth(row);
      renderable.content = renderArtifactRow(
        row,
        rowMatchesQuery(row),
        index === selectedRow,
      );
    }

    function proseRowWidth(): number {
      return Math.max(20, artifactScroll.width - 1);
    }

    function diffGutterCells(): number {
      return diffGutterWidth * 2 + 3;
    }

    function diffRowWidth(row: ActivityRow): number {
      const textWidth =
        row.diff?.kind === "file"
          ? (row.diff.path?.length ?? row.text.length) + 24
          : row.text.length;
      return Math.max(artifactScroll.width, diffGutterCells() + textWidth + 3);
    }

    function toggleSelectedTool(): void {
      const row = artifactRows[selectedRow];
      if (row?.activity?.kind === "tool") toggleTool(row.id);
    }

    function moveSelectedRow(direction: number): void {
      if (artifactRows.length === 0) return;
      const previousRow = selectedRow;
      if (selectedRow < 0)
        selectedRow = direction > 0 ? 0 : artifactRows.length - 1;
      else
        selectedRow = Math.max(
          0,
          Math.min(artifactRows.length - 1, selectedRow + direction),
        );
      artifactFollowing = false;
      refreshArtifactRow(previousRow);
      refreshArtifactRow(selectedRow);
      artifactScroll.scrollChildIntoView(`artifact-row-${selectedRow}`);
      updateChrome();
    }

    function toggleTool(id: string): void {
      if (expandedToolIDs.has(id)) expandedToolIDs.delete(id);
      else expandedToolIDs.add(id);
      refreshArtifactRow(selectedRow);
      updateChrome();
    }

    function rowMatchesQuery(row: ActivityRow): boolean {
      const query = artifactQueries[view.artifact].trim().toLocaleLowerCase();
      return Boolean(query && row.text.toLocaleLowerCase().includes(query));
    }

    function moveToSearchMatch(direction: number): void {
      if (view.focus !== "artifact") return;
      const query = artifactQueries[view.artifact].trim();
      if (!query) {
        openSearch();
        return;
      }
      const matches = artifactRows.flatMap((row, index) =>
        rowMatchesQuery(row) ? [index] : [],
      );
      if (matches.length === 0) {
        setStatus(`No matches for “${query}”`, true);
        return;
      }
      const currentMatch = matches.findIndex((index) => index === selectedRow);
      const next =
        currentMatch < 0
          ? direction > 0
            ? 0
            : matches.length - 1
          : (currentMatch + direction + matches.length) % matches.length;
      selectedRow = matches[next];
      artifactFollowing = false;
      renderArtifactRows(true);
      artifactScroll.scrollChildIntoView(`artifact-row-${selectedRow}`);
      updateChrome();
      setStatus(`Match ${next + 1} of ${matches.length}`);
    }

    function copyCurrentSelection(): void {
      let value = "";
      if (view.focus === "artifact")
        value = artifactRows[selectedRow]?.copyText || "";
      else {
        const session = selectedSession();
        value = session?.threadId || session?.stateDir || "";
      }
      if (!value) {
        setStatus("Select a row to copy", true);
        return;
      }
      const copied = renderer.copyToClipboardOSC52(value);
      setStatus(
        copied ? "Copied selection" : "Terminal clipboard copy is unavailable",
        copied ? "success" : "error",
      );
    }

    function updateFollowFromPosition(): void {
      const maxScroll = Math.max(
        0,
        artifactScroll.scrollHeight - artifactScroll.height,
      );
      const atBottom = artifactScroll.scrollTop >= maxScroll - 1;
      artifactFollowing = atBottom;
      if (atBottom) unseenRows = 0;
      updateChrome();
    }

    function resumeFollowing(render = true): void {
      artifactFollowing = true;
      unseenRows = 0;
      artifactScroll.stickyScroll = true;
      artifactScroll.scrollTo({
        x: 0,
        y: Math.max(0, artifactScroll.scrollHeight),
      });
      if (render) updateChrome();
    }

    function updateDetails(): void {
      const session = selectedSession();
      detailsPanel.height = detailsExpanded ? 12 : 8;
      detailsPanel.title = detailsExpanded
        ? " Session · i hide "
        : " Session · i expand ";
      details.content = renderSessionDetails(
        session,
        detailsExpanded
          ? sessionDetails(session)
          : compactSessionDetails(session),
      );
    }

    function updateChrome(): void {
      const tabs: Array<[TextRenderable, Artifact]> = [
        [chatTab, "chat"],
        [activityTab, "trace"],
        [outputTab, "output"],
        [diffTab, "diff"],
      ];
      for (const [tab, artifact] of tabs) {
        const selected = view.artifact === artifact;
        tab.content = renderTabLabel(artifact, selected);
      }
      diffSidebar.visible = view.artifact === "diff" && renderer.width >= 100;
      diffDivider.visible = diffSidebar.visible;
      if (!diffDividerDragging) {
        const container = artifactBody.width || Math.max(60, renderer.width - 46);
        const next = diffTreeWidthForRatio(diffTreeRatio, container, diffTreeWidth);
        if (next !== diffTreeWidth) {
          diffTreeWidth = next;
          updateDiffFileTree();
        }
      }
      diffSidebar.width = diffTreeWidth;
      updateDiffSummaryLine();
      followIndicator.content = view.artifact === "diff" || artifactFollowing
        ? ""
        : `paused${unseenRows > 0 ? ` · ${unseenRows} new` : ""} · End resumes`;
      const session = selectedSession();
      const query = artifactQueries[view.artifact];
      sessionsPanel.borderColor =
        view.focus === "sessions" ? palette.accent : palette.border;
      footerLeft.content = renderLocation(sessionLocationSummary(session));
      footerRight.content = renderHelp(
        contextualHelp({
          layout,
          focus: view.focus,
          session,
          hasQuery: Boolean(query),
          dejaAvailable,
          compact: renderer.width < 120,
          artifact: view.focus === "artifact" ? view.artifact : undefined,
        }),
      );
      updateWorkingIndicator();
      renderStatus();
      updatePromptChrome();
    }

    function renderTabLabel(artifact: Artifact, selected: boolean): StyledText {
      const label =
        artifact === "trace" ? "activity" : artifact;
      const color = selected ? palette.accent : palette.dim;
      const name = selected
        ? underline(bold(fg(color)(label)))
        : fg(color)(label);
      if (artifact === "diff" && diffSummary && diffSummary.files > 0) {
        const additions = selected ? palette.success : palette.dim;
        const deletions = selected ? palette.danger : palette.dim;
        return t`${name} ${fg(additions)(`+${diffSummary.additions}`)} ${fg(deletions)(`−${diffSummary.deletions}`)}`;
      }
      return t`${name}`;
    }

    function renderHelp(help: string): StyledText {
      const chunks: StyledText["chunks"] = [...t` `.chunks];
      for (const [index, segment] of helpSegments(help).entries()) {
        if (index > 0) chunks.push(...t`${fg(palette.border)("  ")}`.chunks);
        chunks.push(
          ...t`${bold(fg(palette.accent)(segment.key))} ${fg(palette.dim)(segment.label)}`
            .chunks,
        );
      }
      return new StyledText(chunks);
    }

    function renderLocation(location: string): StyledText {
      const separator = location.lastIndexOf(":");
      if (separator <= 0) return t`${fg(palette.dim)(location)}`;
      return t`${fg(palette.dim)(location.slice(0, separator))}${fg(palette.border)(":")}${fg(palette.accent)(location.slice(separator + 1))}`;
    }

    // "~/dev/ruddr:main" for the footer's left corner, opencode style.
    const branchByCwd = new Map<string, string>();
    function sessionLocationSummary(session: Session | undefined): string {
      const cwd = session?.cwd ?? process.cwd();
      const home = process.env.HOME ?? "";
      const shortCwd =
        home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
      const branch = branchByCwd.get(cwd);
      if (branch === undefined) {
        branchByCwd.set(cwd, "");
        void (async () => {
          try {
            const child = Bun.spawn(
              ["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
              { stdout: "pipe", stderr: "ignore" },
            );
            const [name, exitCode] = await Promise.all([
              new Response(child.stdout).text(),
              child.exited,
            ]);
            if (exitCode === 0 && name.trim())
              branchByCwd.set(cwd, name.trim());
            updateChrome();
          } catch {
            // Not a git checkout; the bare path is enough.
          }
        })();
      }
      return branch ? `${shortCwd}:${branch}` : shortCwd;
    }

    function renderUsage(session: Session | undefined): StyledText {
      if (!session) return t``;
      const chunks: StyledText["chunks"] = [];
      const meter = contextMeter(session.tokenUsage, 8);
      if (meter) {
        const color =
          meter.ratio >= 0.85
            ? palette.danger
            : meter.ratio >= 0.6
              ? palette.warning
              : palette.success;
        chunks.push(
          ...t`${fg(color)(renderMeter(meter))} ${fg(palette.text)(meter.label)}`.chunks,
        );
        const cost = session.tokenUsage?.costUsd;
        if (cost !== undefined)
          chunks.push(...t`${fg(palette.dim)(` · $${cost.toFixed(cost < 1 ? 3 : 2)}`)}`.chunks);
      } else {
        const usage = formatTokenUsage(session.tokenUsage);
        if (usage) chunks.push(...t`${fg(palette.text)(usage)}`.chunks);
      }
      if (chunks.length > 0) chunks.push(...t`${fg(palette.dim)(" · ")}`.chunks);
      chunks.push(
        ...t`${fg(sessionStatusColor(session.status))(session.status)}`.chunks,
      );
      return new StyledText(chunks);
    }

    function setStatus(
      message: string,
      danger: boolean | StatusKind = false,
      kind?: StatusKind,
    ): void {
      const resolved: StatusKind =
        typeof danger === "string" ? danger : danger ? "error" : (kind ?? "info");
      statusState = { message, kind: resolved, idle: false };
      if (statusTimer) clearTimeout(statusTimer);
      statusTimer = setTimeout(showIdleStatus, statusTimeoutMs(resolved));
      renderStatus();
    }

    function showIdleStatus(): void {
      if (statusTimer) clearTimeout(statusTimer);
      statusTimer = undefined;
      statusState = { message: "", kind: "info", idle: true };
      renderStatus();
    }

    function renderStatus(): void {
      if (destroyed) return;
      const now = Date.now();
      if (view.interruptArmedUntil > now) {
        const remaining = Math.max(1, Math.ceil((view.interruptArmedUntil - now) / 1000));
        const idle = selectedSession()?.status === "idle";
        statusLine.content = t`${bold(fg(palette.warning)("!"))} ${fg(palette.warning)(`Press x again to ${idle ? "end the idle session" : "interrupt the turn"}`)} ${fg(palette.dim)(`· ${remaining}s`)}`;
        return;
      }
      if (statusState.idle) {
        const liveCount = sessions.filter(isLive).length;
        const summary =
          liveCount > 0
            ? `${liveCount} live ${liveCount === 1 ? "session" : "sessions"}`
            : "watching for sessions";
        const glyph = liveCount > 0 ? spinnerFrame(animationTick) : "·";
        const refreshed =
          lastRefreshAt > 0 ? ` · refreshed ${formatSecondsAgo(lastRefreshAt, now)}` : "";
        statusLine.content = t`${fg(liveCount > 0 ? palette.success : palette.dim)(glyph)} ${fg(palette.dim)(`${summary}${refreshed}`)}`;
        return;
      }
      const busy = actionRunning && statusState.message.endsWith("…");
      const color =
        statusState.kind === "error"
          ? palette.danger
          : statusState.kind === "warning"
            ? palette.warning
            : statusState.kind === "success"
              ? palette.success
              : palette.accent;
      const glyph = busy
        ? spinnerFrame(animationTick)
        : statusGlyphForKind(statusState.kind);
      const textColor =
        statusState.kind === "error" || statusState.kind === "warning"
          ? color
          : palette.text;
      statusLine.content = t`${bold(fg(color)(glyph))} ${fg(textColor)(statusState.message)}`;
    }

    function formatSecondsAgo(timestamp: number, now: number): string {
      const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
      if (seconds < 1) return "just now";
      if (seconds < 60) return `${seconds}s ago`;
      return `${Math.floor(seconds / 60)}m ago`;
    }

    function sessionIsWorking(session: Session | undefined): boolean {
      return session?.status === "active" || session?.status === "starting";
    }

    function updateWorkingIndicator(): void {
      const session = selectedSession();
      if (!sessionIsWorking(session)) {
        workingIndicator.content = "";
        return;
      }
      const verb = session!.status === "starting" ? "starting" : "working";
      const elapsed = formatElapsed(session!.startedAt, undefined);
      workingIndicator.fg =
        session!.status === "starting" ? palette.warning : palette.success;
      workingIndicator.content = `${spinnerFrame(animationTick)} ${verb} · ${elapsed}`;
    }

    // One cheap ticker drives every animation; each pass only touches the
    // renderables that are actually animating so idle frames stay idle.
    function animate(): void {
      if (destroyed) return;
      animationTick++;
      const session = selectedSession();
      const anyLive = sessions.some(isLive);
      const working = sessionIsWorking(session);
      const armed = view.interruptArmedUntil > Date.now();
      if (anyLive) sessionList.requestRender();
      if (working) {
        updateWorkingIndicator();
        const liveIndex = artifactRows.findIndex((row) => row.live);
        if (liveIndex >= 0) refreshArtifactRow(liveIndex);
        if (stream && stream.revealed < stream.target) {
          stream.revealed = typewriterReveal(stream.revealed, stream.target);
          const streamIndex = artifactRows.findIndex((row) => row.id === stream!.id);
          if (streamIndex >= 0) refreshArtifactRow(streamIndex);
          if (artifactFollowing) resumeFollowing(false);
        }
      }
      if (
        statusState.idle ||
        armed ||
        (actionRunning && statusState.message.endsWith("…"))
      )
        renderStatus();
      if (animationTick % 10 === 0 && working) updateDetails();
    }

    let resolveDone: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    let shutdownPromise: Promise<void> | undefined;
    const refreshTimer = setInterval(() => void refresh(), args.interval);
    const animationTimer = setInterval(animate, ANIMATION_INTERVAL_MS);
    const signalNames: NodeJS.Signals[] = [
      "SIGINT",
      "SIGTERM",
      "SIGQUIT",
      "SIGHUP",
    ];
    for (const signal of signalNames) process.once(signal, shutdown);

    function shutdown(): Promise<void> {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        clearInterval(refreshTimer);
        clearInterval(animationTimer);
        if (statusTimer) clearTimeout(statusTimer);
        if (diffNavigationTimer) clearTimeout(diffNavigationTimer);
        for (const signal of signalNames) process.off(signal, shutdown);
        await refreshGate.stop();
        if (!destroyed) {
          renderer.destroy();
          destroyed = true;
        }
        resolveDone?.();
      })();
      return shutdownPromise;
    }

    applyTheme(activeThemeName);
    void (async () => {
      try {
        models = parseModelCatalog(
          await runControl(args.ruddr, ["models", "--json"]),
        );
      } catch {
        models = FALLBACK_MODELS;
      }
    })();
    await refresh();
    await done;
  } finally {
    if (!destroyed) renderer.destroy();
  }
}

function tokenColor(token: CodeToken, muted: boolean): string {
  let base: string;
  switch (token) {
    case "keyword":
      base = palette.accent;
      break;
    case "string":
      base = palette.success;
      break;
    case "regex":
      base = blendHex(palette.success, palette.warning, 0.4);
      break;
    case "number":
    case "constant":
      base = palette.warning;
      break;
    case "comment":
      base = palette.dim;
      break;
    case "type":
      base = blendHex(palette.text, palette.warning, 0.45);
      break;
    case "function":
      base = blendHex(palette.text, palette.accent, 0.55);
      break;
    case "tag":
      base = palette.danger;
      break;
    case "attribute":
      base = blendHex(palette.warning, palette.text, 0.35);
      break;
    case "property":
      base = blendHex(palette.text, palette.accent, 0.35);
      break;
    case "operator":
      base = blendHex(palette.text, palette.danger, 0.3);
      break;
    case "punctuation":
      base = blendHex(palette.text, palette.dim, 0.5);
      break;
    case "heading":
      base = palette.accent;
      break;
    default:
      base = palette.text;
  }
  return muted ? blendHex(base, palette.dim, 0.55) : base;
}

function spanChunks(
  spans: readonly CodeSpan[],
  muted: boolean,
  rowBg?: string,
): StyledText["chunks"] {
  const chunks: StyledText["chunks"] = [];
  for (const span of spans) {
    let chunk = fg(tokenColor(span.token, muted))(span.text);
    if (span.token === "comment") chunk = italic(chunk);
    else if (span.token === "keyword" || span.token === "function" || span.token === "heading")
      chunk = bold(chunk);
    else if (span.token === "attribute") chunk = italic(chunk);
    if (rowBg) chunk = bg(rowBg)(chunk);
    chunks.push(...t`${chunk}`.chunks);
  }
  return chunks;
}

function codeChunks(
  line: string,
  filetype: string,
  muted: boolean,
  rowBg?: string,
): StyledText["chunks"] {
  return spanChunks(highlightCode(line, filetype), muted, rowBg);
}

// SelectRenderable only scrolls to follow its selection; wheel scrolling has
// to move the viewport without touching the selected item, so read and write
// its offset directly. The list re-centers on the next selection change.
interface ScrollableList {
  scrollOffset: number;
}

function listScrollOffset(list: SelectRenderable): number {
  return (list as unknown as ScrollableList).scrollOffset ?? 0;
}

function scrollListBy(
  list: SelectRenderable,
  delta: number,
  linesPerItem: number,
): number {
  const visible = Math.max(1, Math.floor(list.height / linesPerItem));
  const next = clampScrollOffset(
    listScrollOffset(list) + delta,
    list.options.length,
    visible,
  );
  (list as unknown as ScrollableList).scrollOffset = next;
  list.requestRender();
  return next;
}

function renderSessionDetails(
  session: Session | undefined,
  content: string,
): string | StyledText {
  if (!session) return content;
  const chunks: StyledText["chunks"] = [];
  const lines = content.split("\n");
  for (const [index, line] of lines.entries()) {
    const match = /^(\S+)(\s+)(.*)$/.exec(line);
    if (!match) chunks.push(...t`${fg(palette.text)(line)}`.chunks);
    else {
      const [, label, spacing, value] = match;
      const labelChunk = fg(palette.dim)(`${label}${spacing}`);
      if (label === "status")
        chunks.push(
          ...t`${labelChunk}${bold(fg(sessionStatusColor(session.status))(value))}`
            .chunks,
        );
      else if (label === "provider" || label === "model" || label === "cwd")
        chunks.push(...t`${labelChunk}${fg(palette.accent)(value)}`.chunks);
      else chunks.push(...t`${labelChunk}${fg(palette.text)(value)}`.chunks);
    }
    if (index < lines.length - 1) chunks.push(...t`\n`.chunks);
  }
  return new StyledText(chunks);
}

function sessionStatusColor(status: string): string {
  if (status === "active" || status === "completed") return palette.success;
  if (status === "starting") return palette.warning;
  if (status === "failed" || status === "interrupted" || status === "stale")
    return palette.danger;
  return palette.text;
}

function renderChatEntry(entry: ChatEntry, revealed?: number): StyledText {
  if (entry.kind === "user")
    return t`${bold(fg(palette.accent)("❯ "))}${bold(fg(palette.text)(entry.text))}`;
  if (entry.kind === "agent") {
    const text =
      revealed !== undefined && revealed < entry.text.length
        ? entry.text.slice(0, revealed)
        : entry.text;
    const chunks = renderMarkdown(text);
    if (revealed !== undefined && revealed < entry.text.length)
      chunks.push(...t`${fg(palette.accent)("▍")}`.chunks);
    return new StyledText(chunks);
  }
  if (entry.kind === "thought")
    return t`${italic(fg(palette.dim)(entry.text))}`;
  const status = entry.status ?? "running";
  const glyph = status === "completed" ? "•" : status === "failed" ? "×" : "◐";
  const color =
    status === "completed"
      ? palette.dim
      : status === "failed"
        ? palette.danger
        : palette.warning;
  return t`  ${fg(color)(glyph)} ${fg(palette.dim)(entry.text)}`;
}

function renderInline(spans: InlineSpan[], baseColor = palette.text): StyledText["chunks"] {
  const chunks: StyledText["chunks"] = [];
  for (const span of spans) {
    const chunk =
      span.style === "code"
        ? bg(palette.panel)(fg(palette.accent)(` ${span.text} `))
        : span.style === "bold"
          ? bold(fg(baseColor)(span.text))
          : span.style === "italic"
            ? italic(fg(baseColor)(span.text))
            : span.style === "link"
              ? underline(fg(palette.accent)(span.text))
              : fg(baseColor)(span.text);
    chunks.push(...t`${chunk}`.chunks);
  }
  return chunks;
}

function renderMarkdownLine(line: MarkdownLine): StyledText["chunks"] {
  switch (line.kind) {
    case "heading": {
      const color = (line.level ?? 1) <= 2 ? palette.accent : palette.text;
      const prefix = (line.level ?? 1) <= 2 ? "" : `${"#".repeat(line.level ?? 3)} `;
      return t`${bold(fg(color)(prefix))}${bold(fg(color)(line.spans.map((span) => span.text).join("")))}`.chunks;
    }
    case "bullet":
      return [
        ...t`${"  ".repeat(line.indent ?? 0)}${fg(palette.accent)("•")} `.chunks,
        ...renderInline(line.spans),
      ];
    case "numbered":
      return [
        ...t`${"  ".repeat(line.indent ?? 0)}${fg(palette.accent)(line.marker ?? "1.")} `.chunks,
        ...renderInline(line.spans),
      ];
    case "quote":
      return [
        ...t`${fg(palette.border)("▎ ")}`.chunks,
        ...renderInline(line.spans, palette.dim),
      ];
    case "fence":
      return t`${fg(palette.dim)(`  ${line.language ? `▎ ${line.language}` : "▎"}`)}`.chunks;
    case "code": {
      const text = line.spans.map((span) => span.text).join("");
      return [
        ...t`${bg(palette.panel)("  ")}`.chunks,
        ...codeChunks(text, line.language ?? "plain", false, palette.panel),
        ...t`${bg(palette.panel)(" ")}`.chunks,
      ];
    }
    case "rule":
      return t`${fg(palette.border)("─".repeat(24))}`.chunks;
    case "blank":
      return [];
    default:
      return renderInline(line.spans);
  }
}

function renderMarkdown(text: string): StyledText["chunks"] {
  const lines = parseMarkdown(text);
  const chunks: StyledText["chunks"] = [];
  let block: { start: number; language: string } | undefined;
  let blockSpans: CodeSpan[][] = [];
  for (const [index, line] of lines.entries()) {
    if (index > 0) chunks.push(...t`\n`.chunks);
    if (line.kind === "code") {
      if (!block || block.language !== (line.language ?? "plain")) {
        block = { start: index, language: line.language ?? "plain" };
        const run: string[] = [];
        for (let cursor = index; cursor < lines.length && lines[cursor].kind === "code"; cursor++)
          run.push(lines[cursor].spans.map((span) => span.text).join(""));
        blockSpans = highlightLines(run, block.language);
      }
      chunks.push(
        ...t`${bg(palette.panel)("  ")}`.chunks,
        ...spanChunks(blockSpans[index - block.start] ?? [], false, palette.panel),
        ...t`${bg(palette.panel)(" ")}`.chunks,
      );
      continue;
    }
    block = undefined;
    chunks.push(...renderMarkdownLine(line));
  }
  return chunks;
}

function renderTraceActivity(
  activity: TraceActivity,
  detail?: ToolEventDetail,
  expanded = false,
): StyledText {
  if (activity.kind === "thought")
    return t`${italic(fg(palette.dim)(activity.text))}`;
  if (activity.kind === "tool") {
    const state = detail?.status ?? activity.toolStatus ?? "running";
    const glyph = state === "completed" ? "✓" : state === "failed" ? "×" : "◐";
    const color =
      state === "completed"
        ? palette.success
        : state === "failed"
          ? palette.danger
          : palette.warning;
    const durationMs = detail?.durationMs ?? activity.durationMs;
    const duration =
      durationMs === undefined ? "" : `  ${formatDuration(durationMs)}`;
    const subAgent = detail?.type === "subAgentActivity";
    const label = subAgent ? "agent" : (activity.label ?? "tool");
    const text = subAgent
      ? `${detail.activityKind ?? "activity"} ${detail.agentPath ?? detail.agentThreadId ?? "sub-agent"}`
      : activity.text;
    const caret = expanded ? "▾" : "▸";
    const exit =
      detail?.exitCode !== undefined && detail.exitCode !== 0
        ? `  exit ${detail.exitCode}`
        : "";
    return t`${fg(palette.dim)(caret)} ${fg(color)(glyph)} ${bold(fg(color)(label))}  ${fg(palette.text)(text)}${fg(palette.dim)(duration)}${fg(palette.danger)(exit)}`;
  }
  if (activity.kind === "message")
    return t`${fg(palette.accent)("›")} ${fg(palette.text)(activity.text)}`;
  if (activity.kind === "warning")
    return t`${fg(palette.warning)("!")} ${fg(palette.warning)(activity.text)}`;
  if (activity.kind === "error")
    return t`${fg(palette.danger)("×")} ${fg(palette.danger)(activity.text)}`;
  const label = activity.label ? `${activity.label} ` : "";
  return t`${fg(palette.dim)(`• ${label}${activity.text}`)}`;
}

function renderToolDetail(
  detail: ToolEventDetail | undefined,
  activity: TraceActivity,
): StyledText {
  const rail = fg(palette.border)("  │ ");
  const chunks: StyledText["chunks"] = [];
  const line = (...parts: StyledText["chunks"][]) => {
    chunks.push(...t`\n${rail}`.chunks);
    for (const part of parts) chunks.push(...part);
  };
  const field = (label: string, value: string, color = palette.text) =>
    line(t`${fg(palette.dim)(label.padEnd(8))}${fg(color)(value)}`.chunks);
  if (!detail) {
    line(t`${italic(fg(palette.dim)("No additional tool detail was captured."))}`.chunks);
    return new StyledText(chunks);
  }
  const command = detail.command || detail.query || detail.toolName || activity.text;
  const status = `${detail.status}${detail.exitCode === undefined ? "" : ` · exit ${detail.exitCode}`}${
    detail.durationMs === undefined
      ? ""
      : ` · ${formatDuration(detail.durationMs)}`
  }`;
  field("command", command);
  field("status", status, sessionStatusColor(detail.status));
  if (detail.cwd) field("cwd", detail.cwd, palette.accent);
  if (detail.agentThreadId) field("thread", detail.agentThreadId, palette.accent);
  if (detail.input && Object.keys(detail.input).length > 0) {
    line(t`${fg(palette.dim)("input")}`.chunks);
    for (const inputLine of JSON.stringify(detail.input, null, 2).split("\n"))
      line(codeChunks(inputLine, "json", false));
  }
  if (detail.output) {
    const outputLines = detail.output.trimEnd().split("\n");
    const clipped = outputLines.length > TOOL_OUTPUT_LINES;
    line(
      t`${fg(palette.dim)(clipped ? `output · last ${TOOL_OUTPUT_LINES} of ${outputLines.length} lines` : "output")}`
        .chunks,
    );
    for (const outputLine of outputLines.slice(-TOOL_OUTPUT_LINES))
      line(t`${fg(palette.text)(outputLine)}`.chunks);
  }
  chunks.push(...t`\n${fg(palette.border)("  ╰")}`.chunks);
  return new StyledText(chunks);
}

function activitySearchText(
  activity: TraceActivity,
  detail?: ToolEventDetail,
): string {
  return [
    activity.label,
    activity.text,
    activity.toolStatus,
    detail?.command,
    detail?.cwd,
    detail?.status,
    detail?.output,
    detail?.query,
    detail?.toolName,
    detail?.agentThreadId,
    detail?.agentPath,
    detail?.activityKind,
    detail?.input ? JSON.stringify(detail.input) : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

function activityCopyText(
  activity: TraceActivity,
  detail?: ToolEventDetail,
): string {
  if (!detail) return activity.text;
  return [
    detail.command || detail.query || activity.text,
    `status: ${detail.status}${detail.exitCode === undefined ? "" : ` (exit ${detail.exitCode})`}`,
    detail.cwd ? `cwd: ${detail.cwd}` : "",
    detail.agentThreadId ? `thread: ${detail.agentThreadId}` : "",
    detail.output || "",
  ]
    .filter(Boolean)
    .join("\n");
}

function isLive(session: Session): boolean {
  return (
    session.status === "active" ||
    session.status === "idle" ||
    session.status === "starting"
  );
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
}

async function runControl(ruddr: string, args: string[]): Promise<string> {
  const child = Bun.spawn([ruddr, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(stderr.trim() || `ruddr ${args[0]} exited ${exitCode}`);
  return stdout.trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

await main().catch((error) => {
  process.stderr.write(`ruddr tui: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
