import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultThemeName,
  findTheme,
  persistTheme,
  persistTUIConfig,
  readPersistedTheme,
  readTUIConfig,
  resolveThemeName,
  themes,
} from "./themes";

describe("TUI themes", () => {
  test("ships the Rudder theme and every built-in OpenCode theme", () => {
    expect(themes).toHaveLength(34);
    expect(themes[0]?.name).toBe(defaultThemeName);
    expect(findTheme("opencode")?.source).toBe("OpenCode");
    expect(findTheme("tokyonight")?.label).toBe("Tokyo Night");
  });

  test("contains complete terminal color palettes", () => {
    const color = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
    for (const theme of themes) {
      expect(Object.keys(theme.palette)).toHaveLength(10);
      for (const value of Object.values(theme.palette)) expect(value).toMatch(color);
    }
  });

  test("prefers an invocation override, then a valid saved theme", () => {
    expect(resolveThemeName("nord", "dracula")).toBe("nord");
    expect(resolveThemeName(undefined, "dracula")).toBe("dracula");
    expect(resolveThemeName(undefined, "missing")).toBe(defaultThemeName);
    expect(() => resolveThemeName("missing", "nord")).toThrow(
      "unknown TUI theme missing",
    );
  });

  test("persists a private global preference and tolerates invalid JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "rudder-tui-theme-"));
    const configFile = join(root, "nested", "tui.json");
    await persistTUIConfig({ theme: "nord", diffTreeWidth: 42 }, configFile);
    expect(await readPersistedTheme(configFile)).toBe("nord");
    expect(await readTUIConfig(configFile)).toEqual({
      theme: "nord",
      diffTreeWidth: 42,
    });
    await persistTheme("dracula", configFile);
    expect(await readTUIConfig(configFile)).toEqual({
      theme: "dracula",
      diffTreeWidth: 42,
    });
    expect((await stat(join(root, "nested"))).mode & 0o777).toBe(0o700);
    expect((await stat(configFile)).mode & 0o777).toBe(0o600);

    const invalidFile = join(root, "invalid", "tui.json");
    await mkdir(join(root, "invalid"));
    await writeFile(invalidFile, "not json");
    expect(await readPersistedTheme(invalidFile)).toBeUndefined();
  });
});
