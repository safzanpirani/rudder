import type {
  ChatEntry,
  GitDiffLine,
  ToolEventDetail,
  TraceActivity,
} from "./core";

export interface ActivityRow {
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

export const LIVE_ROW_ID = "live";
