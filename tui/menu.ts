// Right-click context menu. Items are plain closures; a destructive item
// swaps the menu for a confirm/cancel pair instead of acting at once.
import {
  BoxRenderable,
  SelectRenderable,
  type CliRenderer,
} from "@opentui/core";
import { palette } from "./palette";

export interface MenuItem {
  label: string;
  hint?: string;
  danger?: boolean;
  run: () => void | Promise<void>;
}

export interface ContextMenu {
  panel: BoxRenderable;
  readonly open: boolean;
  /** Position of the last opened menu, for chained confirm dialogs. */
  readonly left: number;
  readonly top: number;
  show(items: MenuItem[], x: number, y: number, title?: string): void;
  close(): void;
  run(index?: number): void;
  moveUp(): void;
  moveDown(): void;
  /** True when the click at (x, y) landed inside the open menu. */
  contains(x: number, y: number): boolean;
  /** Milliseconds since the menu opened; the opening click bubbles too. */
  ageMs(): number;
  applyTheme(): void;
}

export function createContextMenu(
  renderer: CliRenderer,
  onClose: () => void,
): ContextMenu {
  const list = new SelectRenderable(renderer, {
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
  const panel = new BoxRenderable(renderer, {
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
  panel.add(list);
  let items: MenuItem[] = [];
  let open = false;
  let openedAt = 0;
  let left = 0;
  let top = 0;

  const menu: ContextMenu = {
    panel,
    get open() {
      return open;
    },
    get left() {
      return left;
    },
    get top() {
      return top;
    },
    show(nextItems, x, y, title = "") {
      if (nextItems.length === 0) return;
      items = nextItems;
      const width = Math.min(
        renderer.width - 2,
        Math.max(
          28,
          ...items.map(
            (item) => Math.max(item.label.length, (item.hint ?? "").length) + 6,
          ),
        ),
      );
      const height = Math.min(renderer.height - 2, items.length * 2 + 2);
      left = Math.max(0, Math.min(x, renderer.width - width - 1));
      top = Math.max(0, Math.min(y, renderer.height - height - 1));
      panel.width = width;
      panel.height = height;
      panel.left = left;
      panel.top = top;
      panel.title = title ? ` ${title} ` : "";
      list.options = items.map((item, index) => ({
        name: item.danger ? `⚠ ${item.label}` : item.label,
        description: item.hint ?? "",
        value: String(index),
      }));
      list.setSelectedIndex(0);
      open = true;
      openedAt = Date.now();
      panel.visible = true;
      list.focus();
    },
    close() {
      if (!open) return;
      open = false;
      panel.visible = false;
      onClose();
    },
    run(index = list.getSelectedIndex()) {
      const item = items[index];
      menu.close();
      if (item) void item.run();
    },
    moveUp() {
      list.moveUp(1);
    },
    moveDown() {
      list.moveDown(1);
    },
    contains(x, y) {
      return (
        x >= panel.x &&
        x < panel.x + panel.width &&
        y >= panel.y &&
        y < panel.y + panel.height
      );
    },
    ageMs() {
      return Date.now() - openedAt;
    },
    applyTheme() {
      panel.backgroundColor = palette.panel;
      panel.borderColor = palette.accent;
      panel.titleColor = palette.accent;
      list.backgroundColor = palette.panel;
      list.focusedBackgroundColor = palette.panel;
      list.textColor = palette.text;
      list.focusedTextColor = palette.text;
      list.descriptionColor = palette.dim;
      list.selectedDescriptionColor = palette.text;
      list.selectedBackgroundColor = palette.selected;
      list.selectedTextColor = palette.accent;
    },
  };
  panel.onMouseDown = (event) => {
    const clicked = Math.floor((event.y - panel.y - 1) / 2);
    if (clicked >= 0 && clicked < items.length) menu.run(clicked);
    event.preventDefault();
  };
  return menu;
}
