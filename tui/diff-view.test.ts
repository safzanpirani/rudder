import { expect, test } from "bun:test";
import { BoxRenderable, ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createDiffView, type DiffHost } from "./diff-view";
import { LatestRead, type Session } from "./core";

const patch = (name: string) => `diff --git a/${name} b/${name}
--- a/${name}
+++ b/${name}
@@ -1 +1 @@
-old
+${name}
`;

for (const width of [40, 120]) {
  test(`diff keeps the newest session after overlapping loads at ${width} columns`, async () => {
    const setup = await createTestRenderer({ width, height: 20 });
    const { renderer } = setup;
    const scroll = new ScrollBoxRenderable(renderer, { id: "scroll", width: "100%", height: "100%" });
    const body = new BoxRenderable(renderer, { id: "body", width: "100%", flexDirection: "column" });
    renderer.root.add(scroll);
    scroll.add(body);
    const noop = () => {};
    const host: DiffHost = {
      renderer, artifactScroll: scroll, artifactBody: body,
      isActive: () => true, rows: () => [], selectedRow: () => -1,
      setSelectedRow: noop, setRows: noop, renderRows: noop, refreshRow: noop,
      stopFollowing: noop, invalidateRows: noop, reloadSelected: noop,
      activateSelectedRow: noop, selectedSession: () => undefined,
      setStatus: noop, updateChrome: noop, copyText: noop, persistSidebar: noop,
      initialTreeWidth: 24, initialTreeRatio: undefined,
    };
    const diff = createDiffView(host);
    renderer.root.add(diff.sidebar);
    renderer.root.add(diff.divider);
    const reads = new LatestRead();
    const session: Session = {
      version: 1, pid: 1, status: "completed", stateDir: "/old", stateFile: "/old/state.json",
      cwd: process.cwd(), startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    try {
      const oldCurrent = reads.begin();
      const old = diff.load(session, { content: patch("old.ts") }, oldCurrent);
      const newest = reads.begin();
      expect(await diff.load({ ...session, stateDir: "/new", cwd: undefined }, { content: patch("new.ts") }, newest)).toBe(true);
      expect(await old).toBe(false);
      expect(await diff.load({ ...session, cwd: undefined }, { content: patch("stale.ts") }, oldCurrent)).toBe(false);
      const rows = diff.buildRows();
      expect(rows.some((row) => row.copyText.includes("new.ts"))).toBe(true);
      expect(rows.some((row) => row.copyText.includes("old.ts"))).toBe(false);
      rows.forEach((row, i) => body.add(new TextRenderable(renderer, {
        id: `line-${i}`, content: row.diff ? diff.renderRow(row, false, false) : row.text,
        height: 1, width: "100%", wrapMode: "none",
      })));
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("new.ts");
      expect(frame).not.toContain("old.ts");
    } finally {
      diff.dispose();
      renderer.destroy();
    }
  });
}
