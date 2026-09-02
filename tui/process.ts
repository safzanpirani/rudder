// Child-process helpers for the control CLI.

export async function runControl(ruddr: string, args: string[]): Promise<string> {
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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
