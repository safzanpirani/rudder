// Workspace diff reads with adaptive polling, plus the mtime probe that marks
// files a session has edited since it started.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { nextDiffPollDelay } from "./core";
import { errorMessage } from "./process";

const DIFF_MAX_BYTES = 2 * 1024 * 1024;
const DIFF_REFRESH_MS = 1_000;
const DIFF_TIMEOUT_MS = 3_000;
type DiffResult = { content: string; error?: string };
const pendingDiffs = new Map<string, Promise<DiffResult>>();
export const diffCache = new Map<
  string,
  { readAt: number; delay: number; result: DiffResult }
>();

export async function readWorkspaceDiff(
  cwd: string,
  force = false,
): Promise<DiffResult> {
  const pending = pendingDiffs.get(cwd);
  if (pending) return pending;
  const read = readWorkspaceDiffUncached(cwd, force).finally(() => {
    pendingDiffs.delete(cwd);
  });
  pendingDiffs.set(cwd, read);
  return read;
}

async function readWorkspaceDiffUncached(cwd: string, force: boolean): Promise<DiffResult> {
  const cached = diffCache.get(cwd);
  if (cached && !force && Date.now() - cached.readAt < cached.delay)
    return cached.result;
  const remember = (result: DiffResult) => {
    const changed =
      !cached ||
      cached.result.content !== result.content ||
      cached.result.error !== result.error;
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
        "--no-textconv",
        "--no-color",
        "--unified=3",
        ...arguments_,
      ],
      { stdout: "pipe", stderr: "pipe", env: process.env },
    );
    let truncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, DIFF_TIMEOUT_MS);
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
          child.kill("SIGKILL");
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
      readBoundedStderr(child.stderr),
      child.exited,
    ]).finally(() => clearTimeout(timer));
    if (timedOut) throw new Error("Git diff timed out after 3 seconds.");
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

// Drain stderr without retaining unbounded diagnostics in the dashboard.
async function readBoundedStderr(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let remaining = 64 * 1024;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const kept = value.subarray(0, remaining);
      remaining -= kept.byteLength;
      text += decoder.decode(kept, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/** Files whose mtime is at or after the session start: the session's edits. */
export async function touchedSince(
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
