#!/usr/bin/env bun

import { ClaudeRuddrAdapter, type ProtocolMessage, type RPCRequest } from "./runtime";

const MAX_LINE_BYTES = 64 * 1024 * 1024;
const stdout = Bun.stdout.writer();
let writeChain = Promise.resolve();

function emit(message: ProtocolMessage): Promise<void> {
  const line = `${JSON.stringify(message)}\n`;
  writeChain = writeChain.then(async () => {
    stdout.write(line);
    await stdout.flush();
  });
  return writeChain;
}

const adapter = new ClaudeRuddrAdapter(emit);
let closing = false;

async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await adapter.close();
  await writeChain;
  stdout.end();
}

try {
  for await (const line of readLines(Bun.stdin.stream())) {
    if (!line.trim()) continue;
    let request: RPCRequest;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRPCRequest(parsed)) throw new Error("JSON-RPC message must contain a method");
      request = parsed;
    } catch (error) {
      await emit({
        id: null,
        error: { code: -32700, message: error instanceof Error ? error.message : String(error) },
      });
      continue;
    }
    await adapter.handle(request);
  }
} finally {
  await close();
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      if (Buffer.byteLength(buffered) > MAX_LINE_BYTES) throw new Error("JSON-RPC line exceeds 64 MiB");
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        yield buffered.slice(0, newline).replace(/\r$/, "");
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
      }
    }
    buffered += decoder.decode();
    if (buffered) yield buffered.replace(/\r$/, "");
  } finally {
    reader.releaseLock();
  }
}

function isRPCRequest(value: unknown): value is RPCRequest {
  return typeof value === "object" && value !== null && "method" in value && typeof value.method === "string";
}
