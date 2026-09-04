import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffCache, readWorkspaceDiff } from "./git";

const directories: string[] = [];
const originalPath = process.env.PATH;
afterEach(async () => {
  process.env.PATH = originalPath;
  diffCache.clear();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fakeGit(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ruddr-git-test-"));
  directories.push(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "git"), `#!${process.execPath}\n${source}`, { mode: 0o755 });
  process.env.PATH = `${bin}:${originalPath}`;
  return root;
}

test("concurrent workspace reads share one Git process and disable text conversion", async () => {
  const root = await fakeGit(`
    const cwd = process.argv[3];
    const fs = await import("node:fs");
    fs.appendFileSync(cwd + "/calls", "1");
    if (!process.argv.includes("--no-textconv")) process.exit(2);
    await Bun.sleep(50);
    console.log("shared patch");
  `);
  const results = await Promise.all(Array.from({ length: 10 }, () => readWorkspaceDiff(root, true)));
  expect(await readFile(join(root, "calls"), "utf8")).toBe("1");
  expect(results.every((result) => result.content === "shared patch\n" && !result.error)).toBe(true);
  await readWorkspaceDiff(root);
  expect(await readFile(join(root, "calls"), "utf8")).toBe("1");
});

test("hung Git exits within the deadline and a later read can recover", async () => {
  const root = await fakeGit(`
    const fs = await import("node:fs");
    fs.writeFileSync(process.argv[3] + "/pid", String(process.pid));
    setInterval(() => {}, 1000);
  `);
  const result = await readWorkspaceDiff(root);
  expect(result.error).toBe("Git diff timed out after 3 seconds.");
  const pid = Number(await readFile(join(root, "pid"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
  await writeFile(join(root, "bin", "git"), `#!${process.execPath}\nconsole.log("recovered");`);
  expect(await readWorkspaceDiff(root, true)).toEqual({ content: "recovered\n" });
}, 10_000);

test("Git error output stays bounded", async () => {
  const root = await fakeGit(`process.stderr.write("x".repeat(128 * 1024), () => process.exit(1));`);
  const result = await readWorkspaceDiff(root);
  expect(result.content).toBe("");
  expect(result.error?.length).toBe(64 * 1024);
});
