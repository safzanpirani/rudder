import {
  BoxRenderable,
  bold,
  createCliRenderer,
  fg,
  InputRenderable,
  InputRenderableEvents,
  italic,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  StyledText,
  t,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactAllowsTextSelection,
  compactSessionDetails,
  continuationRunArguments,
  discoverSessions,
  filterSessions,
  initialViewState,
  latestAgentUpdate,
  parseToolEventDetails,
  parseTraceActivities,
  readTail,
  reduceView,
  sessionDescription,
  sessionDetails,
  sessionLabel,
  visibleArtifactTail,
  visibleSessions,
  type Artifact,
  type Session,
  type ToolEventDetail,
  type TraceActivity,
  type ViewState,
} from "./core";
import {
  defaultThemeName,
  findTheme,
  persistTheme,
  readPersistedTheme,
  resolveThemeName,
  themes,
  type ThemePalette,
} from "./themes";

let palette: ThemePalette = findTheme(defaultThemeName)!.palette;

const ACTIVITY_HISTORY_LIMIT = 200;
const OUTPUT_HISTORY_LINES = 1_000;
const ARTIFACT_TAIL_BYTES = 1024 * 1024;
const TOOL_OUTPUT_LINES = 40;

interface Arguments {
  rudder: string;
  roots: string[];
  stateDirs: string[];
  interval: number;
  includeAll: boolean;
  theme?: string;
}

interface ActivityRow {
  id: string;
  activity?: TraceActivity;
  detail?: ToolEventDetail;
  text: string;
  copyText: string;
}

type PromptMode = "steer" | "continue";
type SearchMode = "sessions" | "artifact";

async function main(): Promise<void> {
  const args = parseArguments(Bun.argv.slice(2));
  let activeThemeName = resolveThemeName(
    args.theme || process.env.RUDDER_TUI_THEME,
    await readPersistedTheme(),
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
    let sessions: Session[] = [];
    let view: ViewState = initialViewState;
    let refreshRunning = false;
    let actionRunning = false;
    let detailsExpanded = false;
    let sessionQuery = "";
    const artifactQueries: Record<Artifact, string> = { trace: "", output: "" };
    let searchMode: SearchMode | undefined;
    let promptMode: PromptMode | undefined;
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

    const header = new TextRenderable(renderer, {
      content: "RUDDER  /  SESSIONS",
      fg: palette.accent,
      attributes: TextAttributes.BOLD,
    });
    const sessionCount = new TextRenderable(renderer, {
      content: "0 runs",
      fg: palette.dim,
    });
    const headerBar = new BoxRenderable(renderer, {
      width: "100%",
      height: 1,
      flexDirection: "row",
      justifyContent: "space-between",
    });
    headerBar.add(header);
    headerBar.add(sessionCount);

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
      selectedDescriptionColor: palette.dim,
      selectedBackgroundColor: palette.selected,
      selectedTextColor: palette.accent,
      showScrollIndicator: true,
    });
    const sessionsPanel = new BoxRenderable(renderer, {
      width: "34%",
      height: "100%",
      border: true,
      borderStyle: "rounded",
      borderColor: palette.border,
      focusedBorderColor: palette.accent,
      title: " Sessions · LIVE / RECENT ",
      padding: 1,
    });
    sessionsPanel.add(sessionList);

    const details = new TextRenderable(renderer, {
      content: "No session selected",
      fg: palette.text,
      width: "100%",
    });
    const detailsPanel = new BoxRenderable(renderer, {
      width: "100%",
      height: 7,
      border: true,
      borderStyle: "rounded",
      borderColor: palette.border,
      title: " Session · i details ",
      padding: 1,
    });
    detailsPanel.add(details);

    const activityTab = new TextRenderable(renderer, {
      content: " Activity ",
      fg: palette.accent,
      attributes: TextAttributes.BOLD,
    });
    const outputTab = new TextRenderable(renderer, {
      content: " Output ",
      fg: palette.dim,
    });
    const tabsLeft = new BoxRenderable(renderer, {
      height: 1,
      flexDirection: "row",
      gap: 1,
    });
    tabsLeft.add(activityTab);
    tabsLeft.add(outputTab);
    const followIndicator = new TextRenderable(renderer, {
      content: " FOLLOWING ",
      fg: palette.success,
      attributes: TextAttributes.BOLD,
    });
    const tabsBar = new BoxRenderable(renderer, {
      width: "100%",
      height: 1,
      flexDirection: "row",
      justifyContent: "space-between",
    });
    tabsBar.add(tabsLeft);
    tabsBar.add(followIndicator);

    const artifactScroll = new ScrollBoxRenderable(renderer, {
      id: "artifact",
      width: "100%",
      flexGrow: 1,
      scrollY: true,
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
    const artifactPanel = new BoxRenderable(renderer, {
      width: "100%",
      flexGrow: 1,
      flexDirection: "column",
      gap: 1,
      border: true,
      borderStyle: "rounded",
      borderColor: palette.border,
      focusedBorderColor: palette.accent,
      title: " Timeline ",
      padding: 1,
    });
    artifactPanel.add(tabsBar);
    artifactPanel.add(artifactScroll);

    const right = new BoxRenderable(renderer, {
      flexGrow: 1,
      height: "100%",
      flexDirection: "column",
      gap: 1,
    });
    right.add(detailsPanel);
    right.add(artifactPanel);
    const body = new BoxRenderable(renderer, {
      width: "100%",
      flexGrow: 1,
      flexDirection: "row",
      gap: 1,
    });
    body.add(sessionsPanel);
    body.add(right);

    const statusLine = new TextRenderable(renderer, {
      content: "Watching for Rudder sessions",
      fg: palette.dim,
      height: 1,
    });
    const footer = new TextRenderable(renderer, {
      content: "",
      fg: palette.dim,
      height: 1,
    });

    const searchInput = new InputRenderable(renderer, {
      id: "search-input",
      width: "100%",
      placeholder: "Filter project, thread, status, or model…",
      backgroundColor: palette.panel,
      focusedBackgroundColor: palette.selected,
      textColor: palette.text,
      focusedTextColor: palette.text,
      placeholderColor: palette.dim,
      onSubmit: () => closeSearch(),
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

    const promptInput = new InputRenderable(renderer, {
      id: "prompt-input",
      width: "100%",
      placeholder: "Message for the selected provider…",
      backgroundColor: palette.panel,
      focusedBackgroundColor: palette.selected,
      textColor: palette.text,
      focusedTextColor: palette.text,
      placeholderColor: palette.dim,
      onSubmit: () => void submitPrompt(),
    });
    const promptPanel = new BoxRenderable(renderer, {
      position: "absolute",
      left: "15%",
      top: "42%",
      width: "70%",
      height: 5,
      zIndex: 10,
      border: true,
      borderStyle: "double",
      borderColor: palette.accent,
      title: " Prompt ",
      padding: 1,
      backgroundColor: palette.background,
      visible: false,
    });
    promptPanel.add(promptInput);

    const themePicker = new SelectRenderable(renderer, {
      id: "theme-picker",
      width: "100%",
      flexGrow: 1,
      options: themes.map((theme) => ({
        name: theme.label,
        description:
          theme.source === "OpenCode" ? "OpenCode · dark" : "Rudder default",
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
      gap: 1,
      padding: 1,
      backgroundColor: palette.background,
    });
    root.add(headerBar);
    root.add(body);
    root.add(statusLine);
    root.add(footer);
    root.add(searchPanel);
    root.add(promptPanel);
    root.add(themePanel);
    renderer.root.add(root);
    sessionList.focus();

    activityTab.onMouseDown = () => setArtifact("trace");
    outputTab.onMouseDown = () => setArtifact("output");
    followIndicator.onMouseDown = () => resumeFollowing();
    sessionsPanel.onMouseDown = () => focusSessions();
    sessionList.onMouseScroll = (event) => {
      focusSessions();
      const steps = Math.max(1, Math.round(event.scroll?.delta ?? 1));
      if (event.scroll?.direction === "up") sessionList.moveUp(steps);
      else if (event.scroll?.direction === "down") sessionList.moveDown(steps);
    };
    sessionList.onMouseDown = (event) => {
      focusSessions();
      const linesPerItem = 2;
      const visibleItems = Math.max(
        1,
        Math.floor(sessionList.height / linesPerItem),
      );
      const selectedIndex = sessionList.getSelectedIndex();
      const scrollOffset = Math.max(
        0,
        Math.min(
          selectedIndex - Math.floor(visibleItems / 2),
          Math.max(0, sessions.length - visibleItems),
        ),
      );
      const clickedIndex =
        scrollOffset + Math.floor((event.y - sessionList.y) / linesPerItem);
      if (clickedIndex >= 0 && clickedIndex < sessions.length)
        sessionList.setSelectedIndex(clickedIndex);
    };
    artifactPanel.onMouseDown = () => focusArtifact();
    artifactScroll.onMouseScroll = () => {
      focusArtifact();
      setTimeout(updateFollowFromPosition, 0);
    };
    themePanel.onMouseDown = () => themePicker.focus();

    themePicker.on(
      SelectRenderableEvents.SELECTION_CHANGED,
      (_index, option) => {
        if (themePickerOpen && option?.value) applyTheme(option.value);
      },
    );
    themePicker.on(SelectRenderableEvents.ITEM_SELECTED, () => {
      if (themePickerOpen) void commitThemePicker();
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
        if (changed) resetArtifactPosition();
        void updateSelectedSession();
        updateChrome();
      },
    );

    renderer.keyInput.on("keypress", (key) => {
      if (key.ctrl && key.name === "c") {
        key.preventDefault();
        key.stopPropagation();
        shutdown();
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
      if (searchMode) {
        if (key.name === "escape") {
          key.preventDefault();
          key.stopPropagation();
          clearAndCloseSearch();
        } else if (key.name === "return" || key.name === "enter") {
          key.preventDefault();
          key.stopPropagation();
          closeSearch();
        }
        return;
      }
      if (promptMode) {
        if (key.name === "escape") {
          key.preventDefault();
          key.stopPropagation();
          closePrompt();
        } else if (key.name === "return" || key.name === "enter") {
          key.preventDefault();
          key.stopPropagation();
          void submitPrompt();
        }
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
          "c",
          "return",
          "enter",
          "end",
          "t",
        ].includes(key.name) ||
        (view.focus === "artifact" && (key.name === "j" || key.name === "k"));
      if (handled) {
        key.preventDefault();
        key.stopPropagation();
      }
      if (key.name === "q") {
        shutdown();
        return;
      }
      if (key.name === "t") openThemePicker();
      else if (key.name === "r" && key.shift) openPrompt("continue");
      else if (key.name === "r") void refresh("Refreshing sessions…");
      else if (key.name === "tab") {
        view = reduceView(view, { type: "toggle-focus" });
        focusCurrentPanel();
      } else if (key.name === "o")
        setArtifact(view.artifact === "trace" ? "output" : "trace");
      else if (key.name === "s") openPrompt("steer");
      else if (key.name === "x") void requestInterrupt();
      else if (key.name === "i") {
        detailsExpanded = !detailsExpanded;
        updateDetails();
      } else if (key.name === "/") openSearch();
      else if (key.name === "n") moveToSearchMatch(key.shift ? -1 : 1);
      else if (key.name === "c") copyCurrentSelection();
      else if (
        (key.name === "return" || key.name === "enter") &&
        view.focus === "artifact"
      )
        toggleSelectedTool();
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
        setStatus(`Theme saved: ${findTheme(activeThemeName)!.label}`);
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
      header.fg = palette.accent;
      sessionCount.fg = palette.dim;
      sessionList.backgroundColor = palette.panel;
      sessionList.focusedBackgroundColor = palette.panel;
      sessionList.textColor = palette.text;
      sessionList.focusedTextColor = palette.text;
      sessionList.descriptionColor = palette.dim;
      sessionList.selectedDescriptionColor = palette.text;
      sessionList.selectedBackgroundColor = palette.selected;
      sessionList.selectedTextColor = palette.accent;
      sessionsPanel.borderColor = palette.border;
      sessionsPanel.focusedBorderColor = palette.accent;
      sessionsPanel.titleColor = palette.accent;
      details.fg = palette.text;
      detailsPanel.borderColor = palette.border;
      detailsPanel.titleColor = palette.accent;
      artifactScroll.verticalScrollbarOptions = {
        trackOptions: {
          foregroundColor: palette.accent,
          backgroundColor: palette.border,
        },
      };
      artifactPanel.borderColor = palette.border;
      artifactPanel.focusedBorderColor = palette.accent;
      artifactPanel.titleColor = palette.accent;
      statusLine.fg = palette.dim;
      footer.fg = palette.dim;
      for (const input of [searchInput, promptInput]) {
        input.backgroundColor = palette.panel;
        input.focusedBackgroundColor = palette.selected;
        input.textColor = palette.text;
        input.focusedTextColor = palette.text;
        input.placeholderColor = palette.dim;
      }
      for (const panel of [searchPanel, promptPanel]) {
        panel.backgroundColor = palette.background;
        panel.borderColor = palette.accent;
        panel.titleColor = palette.accent;
      }
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

    function focusCurrentPanel(): void {
      if (view.focus === "artifact") artifactScroll.focus();
      else sessionList.focus();
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
      artifactFollowing = true;
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
          : `Search ${view.artifact === "trace" ? "activity" : "output"}…`;
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

    function openPrompt(mode: PromptMode): void {
      const session = selectedSession();
      if (mode === "steer" && (!session || session.status !== "active")) {
        setStatus("Only an active session can be steered", true);
        return;
      }
      if (
        mode === "continue" &&
        (!session || isLive(session) || !session.threadId || !session.cwd)
      ) {
        setStatus(
          "Select a finished session with a thread and working directory to continue",
          true,
        );
        return;
      }
      promptMode = mode;
      view = reduceView(view, { type: "open-steer" });
      promptInput.value = "";
      promptInput.placeholder =
        mode === "steer"
          ? `New direction for ${session?.provider === "claude" ? "Claude" : "Codex"}…`
          : `What should the resumed ${session?.provider === "claude" ? "Claude session" : "Codex thread"} do?`;
      promptPanel.title =
        mode === "steer"
          ? " Steer active turn · Enter send · Esc cancel "
          : " Continue thread in a new run · Enter start · Esc cancel ";
      promptPanel.visible = true;
      promptInput.focus();
    }

    function closePrompt(): void {
      promptMode = undefined;
      view = reduceView(view, { type: "close-steer" });
      promptPanel.visible = false;
      sessionList.focus();
      updateChrome();
    }

    async function submitPrompt(): Promise<void> {
      if (actionRunning || !promptMode) return;
      const mode = promptMode;
      const message = promptInput.value.trim();
      if (!message) return;
      if (mode === "steer") await submitSteer(message);
      else await continueThread(message);
    }

    async function submitSteer(message: string): Promise<void> {
      const session = selectedSession();
      if (!session || session.status !== "active") return;
      actionRunning = true;
      closePrompt();
      setStatus(`Steering ${sessionLabel(session)}…`);
      let scratchDirectory = "";
      try {
        scratchDirectory = await mkdtemp(join(tmpdir(), "rudder-tui-steer-"));
        await chmod(scratchDirectory, 0o700);
        const messageFile = join(scratchDirectory, "message.md");
        await writeFile(messageFile, `${message}\n`, { mode: 0o600 });
        const result = await runControl(args.rudder, [
          "steer",
          "--state-dir",
          session.stateDir,
          "--message-file",
          messageFile,
        ]);
        setStatus(result || "Steer accepted");
        await refresh();
      } catch (error) {
        setStatus(errorMessage(error), true);
      } finally {
        actionRunning = false;
        if (scratchDirectory)
          await rm(scratchDirectory, { recursive: true, force: true });
      }
    }

    async function continueThread(message: string): Promise<void> {
      const session = selectedSession();
      if (!session?.threadId || !session.cwd || isLive(session)) return;
      actionRunning = true;
      closePrompt();
      try {
        const baseDirectory = join(session.cwd, ".scratch", "rudder-tui");
        await mkdir(baseDirectory, { recursive: true, mode: 0o700 });
        await chmod(baseDirectory, 0o700);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const stateDirectory = join(baseDirectory, `${stamp}.run`);
        await mkdir(stateDirectory, { mode: 0o700 });
        const promptFile = join(stateDirectory, "prompt.md");
        await writeFile(promptFile, `${message}\n`, { mode: 0o600 });
        const runArgs = continuationRunArguments(
          session,
          promptFile,
          stateDirectory,
        );
        const child = Bun.spawn([args.rudder, ...runArgs], {
          cwd: session.cwd,
          stdout: "ignore",
          stderr: "ignore",
          stdin: "ignore",
        });
        child.unref();
        args.stateDirs.push(stateDirectory);
        setStatus(
          `Started a new run for thread ${session.threadId.slice(0, 12)}…`,
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
      if (!session || session.status !== "active") {
        setStatus("Only an active session can be interrupted", true);
        return;
      }
      const now = Date.now();
      if (view.interruptArmedUntil < now) {
        view = reduceView(view, { type: "arm-interrupt", now });
        setStatus(
          "Press x again within 2 seconds to interrupt the selected turn",
          true,
        );
        return;
      }
      view = reduceView(view, { type: "clear-interrupt" });
      actionRunning = true;
      setStatus("Interrupting selected turn…", true);
      try {
        const result = await runControl(args.rudder, [
          "interrupt",
          "--state-dir",
          session.stateDir,
        ]);
        setStatus(result || "Interrupt requested");
        await refresh();
      } catch (error) {
        setStatus(errorMessage(error), true);
      } finally {
        actionRunning = false;
      }
    }

    async function refresh(reason?: string): Promise<void> {
      if (refreshRunning || destroyed) return;
      refreshRunning = true;
      if (reason) setStatus(reason);
      try {
        discoveredSessions = visibleSessions(
          await discoverSessions({
            roots: args.roots,
            stateDirs: args.stateDirs,
          }),
          args.includeAll,
          args.stateDirs,
        );
        applySessionFilter();
        await updateSelectedSession();
        if (reason) setStatus("Watching for session changes");
      } catch (error) {
        setStatus(errorMessage(error), true);
      } finally {
        refreshRunning = false;
      }
    }

    function applySessionFilter(): void {
      const selectedStateDir = view.selectedStateDir;
      sessions = filterSessions(discoveredSessions, sessionQuery);
      view = reduceView(view, { type: "sessions", sessions });
      sessionList.options = sessions.map((session) => ({
        name: `${isLive(session) ? "LIVE" : "RECENT"}  ${sessionLabel(session)}`,
        description: sessionDescription(session),
        value: session.stateDir,
      }));
      const selectedIndex = sessions.findIndex(
        (session) => session.stateDir === selectedStateDir,
      );
      if (selectedIndex >= 0) {
        sessionList.setSelectedIndex(selectedIndex);
        view = reduceView(view, { type: "select", stateDir: selectedStateDir });
      }
      const liveCount = sessions.filter(isLive).length;
      const historyCount = sessions.length - liveCount;
      const filterSuffix = sessionQuery ? ` · /${sessionQuery}` : "";
      sessionCount.content = `${liveCount} live · ${historyCount} recent${filterSuffix}`;
      updateDetails();
      updateChrome();
    }

    async function updateSelectedSession(): Promise<void> {
      const session = selectedSession();
      updateDetails();
      if (!session) {
        setArtifactRows([
          { id: "empty", text: "No trace or output to display.", copyText: "" },
        ]);
        return;
      }
      const currentKey = `${session.stateDir}:${view.artifact}`;
      if (artifactKey !== currentKey) {
        artifactKey = currentKey;
        artifactSignature = "";
        artifactFollowing = true;
        unseenRows = 0;
        previousRowCount = 0;
        selectedRow = -1;
      }
      const artifactPath =
        view.artifact === "trace" ? session.tracePath : session.outputPath;
      const [content, eventContent] = await Promise.all([
        readTail(artifactPath, ARTIFACT_TAIL_BYTES),
        view.artifact === "trace"
          ? readTail(session.eventsPath, ARTIFACT_TAIL_BYTES)
          : "",
      ]);
      if (session.stateDir !== view.selectedStateDir) return;
      if (view.artifact === "trace") {
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
            ? rows
            : [
                {
                  id: "empty",
                  text: "No activity has been recorded yet.",
                  copyText: "",
                },
              ],
        );
      } else {
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
      }
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
      previousRowCount = rows.length;
      artifactSignature = nextSignature;
      if (selectedRow >= rows.length) selectedRow = rows.length - 1;
      renderArtifactRows(true);
      updateChrome();
    }

    function renderArtifactRows(preserveScroll: boolean): void {
      const oldScrollTop = artifactScroll.scrollTop;
      for (const row of rowRenderables) {
        artifactScroll.remove(row);
        row.destroy();
      }
      rowRenderables = artifactRows.map((row, index) => {
        const match = rowMatchesQuery(row);
        const renderable = new TextRenderable(renderer, {
          id: `artifact-row-${index}`,
          width: "100%",
          content: renderArtifactRow(row, match, index === selectedRow),
          fg: palette.text,
          // Activity is a structured list: mouse gestures select/expand rows.
          // Letting OpenTUI begin a text selection first also activates its
          // drag auto-scroll, which makes an ordinary click feel erratic.
          selectable: artifactAllowsTextSelection(view.artifact),
        });
        renderable.onMouseDown = () => {
          focusArtifact();
          selectedRow = index;
          if (row.activity?.kind === "tool") toggleTool(row.id);
          else renderArtifactRows(true);
        };
        artifactScroll.add(renderable);
        return renderable;
      });
      if (artifactFollowing) resumeFollowing(false);
      else if (preserveScroll) artifactScroll.scrollTop = oldScrollTop;
    }

    function renderArtifactRow(
      row: ActivityRow,
      match: boolean,
      selected: boolean,
    ): string | StyledText {
      const selection = selected ? t`${bold(fg(palette.accent)("▸ "))}` : t``;
      const marker = match ? t`${bold(fg(palette.warning)("◆ "))}` : t``;
      if (view.artifact === "output" || !row.activity)
        return new StyledText([
          ...selection.chunks,
          ...marker.chunks,
          ...t`${fg(palette.text)(row.text)}`.chunks,
        ]);
      const base = renderTraceActivity(row.activity, row.detail);
      const chunks = [...selection.chunks, ...marker.chunks, ...base.chunks];
      if (row.activity.kind === "tool" && expandedToolIDs.has(row.id))
        chunks.push(...renderToolDetail(row.detail, row.activity).chunks);
      return new StyledText(chunks);
    }

    function toggleSelectedTool(): void {
      const row = artifactRows[selectedRow];
      if (row?.activity?.kind === "tool") toggleTool(row.id);
    }

    function moveSelectedRow(direction: number): void {
      if (artifactRows.length === 0) return;
      if (selectedRow < 0)
        selectedRow = direction > 0 ? 0 : artifactRows.length - 1;
      else
        selectedRow = Math.max(
          0,
          Math.min(artifactRows.length - 1, selectedRow + direction),
        );
      artifactFollowing = false;
      renderArtifactRows(true);
      artifactScroll.scrollChildIntoView(`artifact-row-${selectedRow}`);
      updateChrome();
    }

    function toggleTool(id: string): void {
      if (expandedToolIDs.has(id)) expandedToolIDs.delete(id);
      else expandedToolIDs.add(id);
      renderArtifactRows(true);
      if (selectedRow >= 0)
        artifactScroll.scrollChildIntoView(`artifact-row-${selectedRow}`);
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
        !copied,
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
      detailsPanel.height = detailsExpanded ? 11 : 7;
      detailsPanel.title = detailsExpanded
        ? " Session · i compact "
        : " Session · i details ";
      details.content = renderSessionDetails(
        session,
        detailsExpanded
          ? sessionDetails(session)
          : compactSessionDetails(session),
      );
    }

    function updateChrome(): void {
      const activitySelected = view.artifact === "trace";
      activityTab.fg = activitySelected ? palette.accent : palette.dim;
      activityTab.attributes = activitySelected
        ? TextAttributes.BOLD
        : TextAttributes.NONE;
      outputTab.fg = activitySelected ? palette.dim : palette.accent;
      outputTab.attributes = activitySelected
        ? TextAttributes.NONE
        : TextAttributes.BOLD;
      followIndicator.content = artifactFollowing
        ? " FOLLOWING "
        : ` PAUSED${unseenRows > 0 ? ` · ${unseenRows} new` : ""} · End resume `;
      followIndicator.fg = artifactFollowing
        ? palette.success
        : palette.warning;
      const query = artifactQueries[view.artifact];
      artifactPanel.title = query ? ` Timeline · /${query} ` : " Timeline ";
      sessionsPanel.borderColor =
        view.focus === "sessions" ? palette.accent : palette.border;
      artifactPanel.borderColor =
        view.focus === "artifact" ? palette.accent : palette.border;
      footer.content = contextualHelp(
        view.focus,
        selectedSession(),
        Boolean(query),
      );
    }

    function setStatus(message: string, danger = false): void {
      statusLine.content = message;
      statusLine.fg = danger ? palette.danger : palette.dim;
    }

    let resolveDone: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const refreshTimer = setInterval(() => void refresh(), args.interval);
    const signalNames: NodeJS.Signals[] = [
      "SIGINT",
      "SIGTERM",
      "SIGQUIT",
      "SIGHUP",
    ];
    for (const signal of signalNames) process.once(signal, shutdown);

    function shutdown(): void {
      if (destroyed) return;
      destroyed = true;
      clearInterval(refreshTimer);
      for (const signal of signalNames) process.off(signal, shutdown);
      renderer.destroy();
      resolveDone?.();
    }

    applyTheme(activeThemeName);
    await refresh();
    await done;
  } finally {
    if (!destroyed) renderer.destroy();
  }
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

function renderTraceActivity(
  activity: TraceActivity,
  detail?: ToolEventDetail,
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
    const label = activity.label ?? "tool";
    return t`${fg(color)(glyph)} ${bold(fg(color)(label))} ${fg(palette.text)(activity.text)}${fg(palette.dim)(duration)} ${fg(palette.dim)("›")}`;
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
  if (!detail)
    return t`\n  ${fg(palette.dim)("No additional tool detail was captured.")}`;
  const command = detail.command || detail.query || detail.toolName || activity.text;
  const status = `${detail.status}${detail.exitCode === undefined ? "" : ` · exit ${detail.exitCode}`}${
    detail.durationMs === undefined
      ? ""
      : ` · ${formatDuration(detail.durationMs)}`
  }`;
  const outputLines = (detail.output || "").trimEnd().split("\n");
  const clipped = outputLines.length > TOOL_OUTPUT_LINES;
  const visibleOutput = outputLines.slice(-TOOL_OUTPUT_LINES).join("\n");
  const chunks =
    t`\n  ${fg(palette.dim)("command")}  ${fg(palette.text)(command)}\n  ${fg(palette.dim)("status ")}  ${fg(sessionStatusColor(detail.status))(status)}`
      .chunks;
  if (detail.cwd)
    chunks.push(
      ...t`\n  ${fg(palette.dim)("cwd    ")}  ${fg(palette.accent)(detail.cwd)}`
        .chunks,
    );
  if (detail.input && Object.keys(detail.input).length > 0)
    chunks.push(
      ...t`\n  ${fg(palette.dim)("input  ")}  ${fg(palette.text)(JSON.stringify(detail.input, null, 2))}`
        .chunks,
    );
  if (detail.output)
    chunks.push(
      ...t`\n  ${fg(palette.dim)(clipped ? `output · last ${TOOL_OUTPUT_LINES} lines` : "output")}\n${fg(palette.text)(visibleOutput)}`
        .chunks,
    );
  return new StyledText(chunks);
}

function attachToolDetails(
  activities: TraceActivity[],
  details: ToolEventDetail[],
): Array<ToolEventDetail | undefined> {
  const used = new Set<string>();
  return activities.map((activity) => {
    if (activity.kind !== "tool") return undefined;
    const summary = activity.text.replace(/…$/, "").toLocaleLowerCase();
    const match = details.find((detail) => {
      if (used.has(detail.id)) return false;
      const text =
        `${detail.command || ""} ${detail.query || ""} ${detail.toolName || ""}`.toLocaleLowerCase();
      if (summary && (text.includes(summary) || summary.includes(text.trim())))
        return true;
      if (activity.label === "files") return detail.type === "fileChange";
      if (activity.label?.toLocaleLowerCase().includes("websearch"))
        return detail.type === "webSearch";
      return activity.label === "shell" && detail.type === "commandExecution";
    });
    if (match) used.add(match.id);
    return match;
  });
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
    detail.output || "",
  ]
    .filter(Boolean)
    .join("\n");
}

function contextualHelp(
  focus: ViewState["focus"],
  session: Session | undefined,
  hasQuery: boolean,
): string {
  if (focus === "artifact")
    return `j/k row   wheel/↑↓ scroll   Enter expand   / search${hasQuery ? "   n/N match" : ""}   c copy   End follow   o tab   t theme   Tab sessions   q quit`;
  const action =
    session?.status === "active"
      ? "s steer   x x stop"
      : session
        ? "R continue"
        : "";
  return `j/k select   / filter   i details   c copy thread   ${action}   t theme   Tab timeline   r reload   q quit`;
}

function isLive(session: Session): boolean {
  return session.status === "active" || session.status === "starting";
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
}

function parseArguments(argv: string[]): Arguments {
  const roots: string[] = [];
  const stateDirs: string[] = [];
  let rudder = "";
  let interval = 500;
  let includeAll = false;
  let theme: string | undefined;
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
    else throw new Error(`unknown TUI argument ${argument}`);
  }
  if (!rudder)
    throw new Error("--rudder is required (launch the TUI through rudder tui)");
  if (roots.length === 0 && stateDirs.length === 0)
    roots.push(join(process.cwd(), ".scratch"));
  return { rudder, roots, stateDirs, interval, includeAll, theme };
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

async function runControl(rudder: string, args: string[]): Promise<string> {
  const child = Bun.spawn([rudder, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(stderr.trim() || `rudder ${args[0]} exited ${exitCode}`);
  return stdout.trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

await main().catch((error) => {
  process.stderr.write(`rudder tui: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
