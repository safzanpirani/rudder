import {
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
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactAllowsTextSelection,
  AsyncTaskGate,
  attachToolDetails,
  compactSessionDetails,
  continuationRunArguments,
  contextualHelp,
  dashboardNavigation,
  discoverSessions,
  emptyPromptHint,
  filterSessions,
  formatTokenUsage,
  initialViewState,
  latestAgentUpdate,
  modelPickerOptions,
  newSessionRunArguments,
  nextArtifact,
  parseArguments,
  parseChatTranscript,
  parseDejaHits,
  parseModelCatalog,
  parseToolEventDetails,
  parseTraceActivities,
  promptModeForSession,
  readTail,
  reduceView,
  sessionDescription,
  sessionDetails,
  sessionLabel,
  sessionsPanelTitle,
  statusGlyph,
  visibleArtifactTail,
  visibleSessions,
  FALLBACK_MODELS,
  type Artifact,
  type ChatEntry,
  type DejaHit,
  type ModelInfo,
  type Session,
  type ToolEventDetail,
  type TraceActivity,
  type TUILayout,
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

interface ActivityRow {
  id: string;
  activity?: TraceActivity;
  detail?: ToolEventDetail;
  chat?: ChatEntry;
  text: string;
  copyText: string;
}

// The TUI resolves "auto" once when the input opens. A status change can then
// reject the captured command, but it can never convert prompt into steer.
type PromptMode = "steer" | "prompt" | "continue" | "new";
type SearchMode = "sessions" | "artifact" | "deja";

async function main(): Promise<void> {
  const args = parseArguments(Bun.argv.slice(2));
  const layout: TUILayout = args.beta ? "beta" : "classic";
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
    const refreshGate = new AsyncTaskGate();
    let actionRunning = false;
    let detailsExpanded = false;
    let sessionQuery = "";
    const artifactQueries: Record<Artifact, string> = {
      chat: "",
      trace: "",
      output: "",
    };
    let searchMode: SearchMode | undefined;
    let promptMode: PromptMode | undefined;
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
        const selectedIndex = this.getSelectedIndex();
        const scrollOffset = Math.max(
          0,
          Math.min(
            selectedIndex - Math.floor(visibleItems / 2),
            Math.max(0, sessions.length - visibleItems),
          ),
        );
        const accent = parseColor(palette.accent);
        const success = parseColor(palette.success);
        const warning = parseColor(palette.warning);
        const danger = parseColor(palette.danger);
        const labelX = 3;

        for (const [visibleIndex, session] of sessions
          .slice(scrollOffset, scrollOffset + visibleItems)
          .entries()) {
          const group = isLive(session) ? "LIVE" : "RECENT";
          const statusColor =
            session.status === "active" || session.status === "completed"
              ? success
              : session.status === "starting"
                ? warning
                : danger;
          const rowY = visibleIndex * linesPerItem;
          const provider = session.provider ?? "codex";

          buffer.drawText(
            group,
            labelX,
            rowY,
            isLive(session) ? success : accent,
          );
          buffer.drawText(
            statusGlyph(session.status),
            labelX + group.length + 2,
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
      attributes: TextAttributes.BOLD,
    });
    const activityTab = new TextRenderable(renderer, {
      content: "activity",
      fg: palette.dim,
    });
    const outputTab = new TextRenderable(renderer, {
      content: "output",
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
    // Only speaks up when live-follow is paused; silence is the default.
    const followIndicator = new TextRenderable(renderer, {
      content: "",
      fg: palette.warning,
    });
    const tabsBar = new BoxRenderable(renderer, {
      width: "100%",
      height: 1,
      flexDirection: "row",
      justifyContent: "space-between",
      paddingLeft: 1,
      paddingRight: 1,
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
    artifactPanel.add(artifactScroll);

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

    const promptInput = new InputRenderable(renderer, {
      id: "prompt-input",
      width: "100%",
      placeholder: "Message for the selected provider…",
      backgroundColor: palette.panel,
      focusedBackgroundColor: palette.selected,
      textColor: palette.text,
      focusedTextColor: palette.text,
      placeholderColor: palette.dim,
    });
    const promptPanel = new BoxRenderable(renderer, {
      width: "100%",
      height: 3,
      border: true,
      borderStyle: "rounded",
      borderColor: palette.border,
      focusedBorderColor: palette.accent,
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: palette.background,
    });
    promptPanel.add(promptInput);

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
    root.add(themePanel);
    root.add(modelPanel);
    root.add(dejaPanel);
    renderer.root.add(root);
    artifactScroll.focus();
    view = { ...view, focus: "artifact" };

    chatTab.onMouseDown = () => setArtifact("chat");
    activityTab.onMouseDown = () => setArtifact("trace");
    outputTab.onMouseDown = () => setArtifact("output");
    followIndicator.onMouseDown = () => resumeFollowing();
    promptPanel.onMouseDown = () => openPrompt("auto");
    sessionsPanel.onMouseDown = () => focusSessions();
    modelPanel.onMouseDown = () => modelPicker.focus();
    dejaPanel.onMouseDown = () => dejaPicker.focus();
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
    renderer.on("resize", () => updateChrome());
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
          pendingModel = undefined;
          pendingResume = undefined;
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
      if (key.name === "t") openThemePicker();
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
      for (const input of [searchInput, promptInput]) {
        input.backgroundColor = palette.panel;
        input.focusedBackgroundColor = palette.selected;
        input.textColor = palette.text;
        input.focusedTextColor = palette.text;
        input.placeholderColor = palette.dim;
      }
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
      setStatus(`${dejaHits.length} resumable sessions found`);
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
      openPromptInput();
      setStatus(
        `Resuming ${hit.provider} session ${hit.sessionId.slice(0, 12)}… — type the next prompt`,
      );
    }

    function openPrompt(mode: "auto" | "continue"): void {
      const session = selectedSession();
    const route = promptModeForSession(session);
    if (mode === "auto" && !route) {
        setStatus(
          session
            ? `Session is ${session.status}; press n for a new session`
            : "No session selected; press n for a new session",
          true,
        );
        return;
      }
      if (
        mode === "continue" &&
    promptModeForSession(session) !== "continue"
      ) {
        setStatus(
          "Select a finished session with a thread and working directory to continue",
          true,
        );
        return;
      }
    promptMode = mode === "auto" ? route : mode;
    if (promptMode === "steer" || promptMode === "prompt") {
    pendingModel = undefined;
    }
      openPromptInput();
    }

    function openPromptInput(): void {
      view = reduceView(view, { type: "open-steer" });
      promptInput.value = "";
      updatePromptChrome();
      promptInput.focus();
      updateChrome();
    }

    function updatePromptChrome(): void {
      const session = selectedSession();
      const modelLabel =
        pendingModel && (promptMode === "new" || promptMode === "continue")
          ? (pendingModel.label ?? pendingModel.id)
          : (session?.model ?? "");
      const effort = session?.effort ? ` · ${session.effort}` : "";
      promptMetaRight.content = sessionUsageSummary(session);
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
      view = reduceView(view, { type: "close-steer" });
      view = { ...view, focus: "artifact" };
      artifactScroll.focus();
      updatePromptChrome();
      updateChrome();
    }

    async function submitPrompt(): Promise<void> {
      if (actionRunning || !promptMode) return;
      const mode = promptMode;
      const message = promptInput.value.trim();
      if (!message) return;
      if (mode === "new") {
        await startNewSession(message);
        return;
      }
      const session = selectedSession();
    const route = mode;
      if (route === "steer") await submitSteer(message);
      else if (route === "prompt") await submitIdlePrompt(message);
      else if (route === "continue") await continueThread(message);
      else setStatus("Session can no longer accept a prompt", true);
    }

    async function submitIdlePrompt(message: string): Promise<void> {
      const session = selectedSession();
    if (!session || session.status !== "idle") {
    setStatus("Session is no longer idle; the prompt was not sent", true);
    return;
    }
      actionRunning = true;
      closePrompt();
      setStatus("Sending prompt…");
      let scratchDirectory = "";
      try {
        scratchDirectory = await mkdtemp(join(tmpdir(), "rudder-tui-prompt-"));
        await chmod(scratchDirectory, 0o700);
        const messageFile = join(scratchDirectory, "message.md");
        await writeFile(messageFile, `${message}\n`, { mode: 0o600 });
        const result = await runControl(args.rudder, [
          "prompt",
          "--state-dir",
          session.stateDir,
          "--message-file",
          messageFile,
        ]);
        setStatus(result || "Prompt accepted");
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
        const baseDirectory = join(cwd, ".scratch", "rudder-tui");
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
        const child = Bun.spawn([args.rudder, ...runArgs], {
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

    async function submitSteer(message: string): Promise<void> {
      const session = selectedSession();
    if (!session || session.status !== "active") {
    setStatus("Turn is no longer active; the steer was not sent", true);
    return;
    }
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
      const modelOverride = pendingModel;
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
        setStatus(
          idle
            ? "Press x again within 2 seconds to end the idle session"
            : "Press x again within 2 seconds to interrupt the selected turn",
          true,
        );
        return;
      }
      view = reduceView(view, { type: "clear-interrupt" });
      actionRunning = true;
      setStatus(idle ? "Ending idle session…" : "Interrupting selected turn…", true);
      try {
        const result = await runControl(args.rudder, [
          idle ? "stop" : "interrupt",
          "--state-dir",
          session.stateDir,
        ]);
        setStatus(result || (idle ? "Shutdown requested" : "Interrupt requested"));
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
        }
      });
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
      sessionsPanel.title = sessionsPanelTitle({
        layout,
        liveCount,
        recentCount: historyCount,
        query: sessionQuery,
      });
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
        view.artifact === "chat"
          ? ""
          : readTail(artifactPath, ARTIFACT_TAIL_BYTES),
        view.artifact === "output"
          ? ""
          : readTail(session.eventsPath, ARTIFACT_TAIL_BYTES),
      ]);
      if (session.stateDir !== view.selectedStateDir) return;
      if (view.artifact === "chat") {
        const entries = parseChatTranscript(eventContent, session.threadId);
        const rows: ActivityRow[] = [];
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
        setArtifactRows(
          rows.length > 0
            ? rows
            : [
                {
                  id: "empty",
                  text: session.status === "starting"
                    ? "Session is starting…"
                    : "No conversation yet — type below to send a prompt.",
                  copyText: "",
                },
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
          wrapMode: "word",
          content: renderArtifactRow(row, match, index === selectedRow),
          fg: palette.text,
          // Activity is a structured list: mouse gestures select/expand rows.
          // Letting OpenTUI begin a text selection first also activates its
          // drag auto-scroll, which makes an ordinary click feel erratic.
          selectable: artifactAllowsTextSelection(view.artifact),
        });
        renderable.onMouseDown = () => {
          focusArtifact();
          const previousRow = selectedRow;
          selectedRow = index;
          refreshArtifactRow(previousRow);
          if (row.activity?.kind === "tool") toggleTool(row.id);
          else refreshArtifactRow(index);
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
      if (row.chat)
        return new StyledText([
          ...selection.chunks,
          ...marker.chunks,
          ...renderChatEntry(row.chat).chunks,
        ]);
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

    function refreshArtifactRow(index: number): void {
      const row = artifactRows[index];
      const renderable = rowRenderables[index];
      if (!row || !renderable) return;
      renderable.content = renderArtifactRow(
        row,
        rowMatchesQuery(row),
        index === selectedRow,
      );
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
      ];
      for (const [tab, artifact] of tabs) {
        const selected = view.artifact === artifact;
        tab.fg = selected ? palette.accent : palette.dim;
        tab.attributes = selected ? TextAttributes.BOLD : TextAttributes.NONE;
      }
      followIndicator.content = artifactFollowing
        ? ""
        : `paused${unseenRows > 0 ? ` · ${unseenRows} new` : ""} · End resumes`;
      const session = selectedSession();
      const query = artifactQueries[view.artifact];
      sessionsPanel.borderColor =
        view.focus === "sessions" ? palette.accent : palette.border;
      footerLeft.content = sessionLocationSummary(session);
      footerRight.content = ` ${contextualHelp({
        layout,
        focus: view.focus,
        session,
        hasQuery: Boolean(query),
        dejaAvailable,
        compact: renderer.width < 120,
      })}`;
      updatePromptChrome();
    }

    // "~/dev/rudder:main" for the footer's left corner, opencode style.
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

    function sessionUsageSummary(session: Session | undefined): string {
      if (!session) return "";
      const parts: string[] = [];
      const usage = formatTokenUsage(session.tokenUsage);
      if (usage) parts.push(usage);
      parts.push(session.status);
      return parts.join(" · ");
    }

    function setStatus(message: string, danger = false): void {
      statusLine.content = message;
      statusLine.fg = danger ? palette.danger : palette.dim;
    }

    let resolveDone: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    let shutdownPromise: Promise<void> | undefined;
    const refreshTimer = setInterval(() => void refresh(), args.interval);
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
          await runControl(args.rudder, ["models", "--json"]),
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

function renderChatEntry(entry: ChatEntry): StyledText {
  if (entry.kind === "user")
    return t`${bold(fg(palette.accent)("❯ "))}${bold(fg(palette.text)(entry.text))}`;
  if (entry.kind === "agent") return t`${fg(palette.text)(entry.text)}`;
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
    const subAgent = detail?.type === "subAgentActivity";
    const label = subAgent ? "agent" : (activity.label ?? "tool");
    const text = subAgent
      ? `${detail.activityKind ?? "activity"} ${detail.agentPath ?? detail.agentThreadId ?? "sub-agent"}`
      : activity.text;
    return t`${fg(color)(glyph)} ${bold(fg(color)(label))} ${fg(palette.text)(text)}${fg(palette.dim)(duration)} ${fg(palette.dim)("›")}`;
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
  if (detail.agentThreadId)
    chunks.push(
      ...t`\n  ${fg(palette.dim)("thread ")}  ${fg(palette.accent)(detail.agentThreadId)}`
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
