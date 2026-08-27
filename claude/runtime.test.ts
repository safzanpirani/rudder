import { describe, expect, test } from "bun:test";
import type { Query, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  AsyncMessageQueue,
  buildQueryOptions,
  ClaudeRudderAdapter,
  resultStatus,
  userMessage,
  type ProtocolMessage,
  type QueryFactory,
} from "./runtime";

class FakeSDKStream implements AsyncIterable<SDKMessage> {
  private values: SDKMessage[] = [];
  private waiters: Array<(result: IteratorResult<SDKMessage>) => void> = [];
  private closed = false;

  push(value: SDKMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  query(): Query {
    const iterator = this[Symbol.asyncIterator]();
    const fake = Object.assign(iterator, {
      close: () => this.close(),
      interrupt: async () => undefined,
      setPermissionMode: async () => undefined,
      setMcpPermissionModeOverride: async () => ({}),
      setModel: async () => undefined,
    }) as AsyncIterator<SDKMessage> & { [Symbol.asyncIterator]?: () => Query };
    const typed = fake as unknown as Query;
    fake[Symbol.asyncIterator] = () => typed;
    return typed;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value) return { value, done: false };
        if (this.closed) return { value: undefined, done: true };
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

describe("AsyncMessageQueue", () => {
  test("preserves queued steering order and closes", async () => {
    const queue = new AsyncMessageQueue();
    const iterator = queue[Symbol.asyncIterator]();
    queue.push(userMessage("first"));
    queue.push(userMessage("second"));
    expect(textOf((await iterator.next()).value)).toBe("first");
    expect(textOf((await iterator.next()).value)).toBe("second");
    queue.close();
    expect((await iterator.next()).done).toBe(true);
    expect(() => queue.push(userMessage("late"))).toThrow("closed");
  });
});

describe("query options", () => {
  test("maps danger-full-access and read-only with fresh/resume identity", () => {
    const fresh = buildQueryOptions({
      id: "fresh-id",
      cwd: "/tmp/project",
      sandbox: "danger-full-access",
      persistSession: true,
      resumed: false,
    });
    expect(fresh.permissionMode).toBe("bypassPermissions");
    expect(fresh.allowDangerouslySkipPermissions).toBe(true);
    expect(fresh.sessionId).toBe("fresh-id");
    expect(fresh.resume).toBeUndefined();

    const resumed = buildQueryOptions({
      id: "resume-id",
      cwd: "/tmp/project",
      sandbox: "read-only",
      persistSession: false,
      resumed: true,
    });
    expect(resumed.permissionMode).toBe("plan");
    expect(resumed.resume).toBe("resume-id");
    expect(resumed.persistSession).toBe(false);
  });

  test("runs workspace Bash inside Claude's command sandbox", async () => {
    const workspace = buildQueryOptions({
      id: "workspace-id",
      cwd: "/tmp/project",
      sandbox: "workspace-write",
      persistSession: true,
      resumed: false,
    });

    expect(workspace.permissionMode).toBe("acceptEdits");
    expect(workspace.sandbox).toEqual({
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: { allowWrite: ["/tmp/project"] },
    });

    const escalated = await workspace.canUseTool?.(
      "Bash",
      { command: "pwd" },
      {
        signal: new AbortController().signal,
        toolUseID: "tool-id",
        requestId: "request-id",
      },
    );
    expect(escalated?.behavior).toBe("deny");
    // The Bash denial has to tell the model that other commands still work,
    // otherwise it concludes the whole shell is unavailable and stops trying.
    if (escalated?.behavior !== "deny") throw new Error("expected a denial");
    expect(escalated.message).toContain("Other shell commands still work");
  });
});

describe("ClaudeRudderAdapter", () => {
  test("returns JSON-RPC method-not-found for unsupported methods", async () => {
    const emitted: ProtocolMessage[] = [];
    const adapter = new ClaudeRudderAdapter((message) => {
      emitted.push(message);
    });
    await adapter.handle({ id: "unknown", method: "thread/archive", params: {} });
    expect(emitted).toEqual([
      {
        id: "unknown",
        error: {
          code: -32601,
          message: "method thread/archive is not supported by the Claude adapter",
        },
      },
    ]);
  });

  test("normalizes thinking, tools, commentary, final output, and completion", async () => {
    const emitted: ProtocolMessage[] = [];
    const stream = new FakeSDKStream();
    let prompt: AsyncIterable<ReturnType<typeof userMessage>> | undefined;
    const factory: QueryFactory = (input) => {
      prompt = input.prompt;
      return stream.query();
    };
    const adapter = new ClaudeRudderAdapter((message) => {
      emitted.push(message);
    }, factory);

    await adapter.handle({ id: "init", method: "initialize", params: {} });
    await adapter.handle({
      id: "thread",
      method: "thread/start",
      params: { cwd: "/tmp/project", sandbox: "workspace-write", provider: "claude" },
    });
    const threadID = responseResult(emitted, "thread", "thread.id");
    await adapter.handle({
      id: "turn",
      method: "turn/start",
      params: { threadId: threadID, input: [{ type: "text", text: "initial" }] },
    });
    const turnID = responseResult(emitted, "turn", "turn.id");
    const promptIterator = prompt![Symbol.asyncIterator]();
    expect(textOf((await promptIterator.next()).value)).toBe("initial");

    stream.push(sdk({ type: "stream_event", parent_tool_use_id: null, uuid: "a", session_id: threadID, event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } } }));
    stream.push(sdk({ type: "stream_event", parent_tool_use_id: null, uuid: "b", session_id: threadID, event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Inspecting the failure" } } }));
    stream.push(sdk({ type: "stream_event", parent_tool_use_id: null, uuid: "c", session_id: threadID, event: { type: "content_block_stop", index: 0 } }));
    stream.push(sdk({ type: "stream_event", parent_tool_use_id: null, uuid: "d", session_id: threadID, event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } }));
    stream.push(sdk({ type: "stream_event", parent_tool_use_id: null, uuid: "e", session_id: threadID, event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "I found the issue." } } }));
    stream.push(sdk({ type: "stream_event", parent_tool_use_id: null, uuid: "f", session_id: threadID, event: { type: "content_block_stop", index: 1 } }));
    stream.push(sdk({ type: "stream_event", parent_tool_use_id: null, uuid: "g", session_id: threadID, event: { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tool-1", name: "Bash", input: {} } } }));
    stream.push(sdk({ type: "stream_event", parent_tool_use_id: null, uuid: "h", session_id: threadID, event: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"command":"bun test"}' } } }));
    stream.push(sdk({ type: "stream_event", parent_tool_use_id: null, uuid: "i", session_id: threadID, event: { type: "content_block_stop", index: 2 } }));
    stream.push(sdk({ type: "user", parent_tool_use_id: null, session_id: threadID, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "pass" }] } }));
    stream.push(sdk({ type: "result", subtype: "success", is_error: false, result: "Done.", queued_turn_count: 0, session_id: threadID, uuid: "r", duration_ms: 1, duration_api_ms: 1, num_turns: 1, stop_reason: "end_turn", total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [] }));

    await waitFor(() => emitted.some((message) => notification(message, "turn/completed")));
    const notifications = emitted.filter((message): message is Extract<ProtocolMessage, { method: string }> => "method" in message);
    expect(notifications.some((message) => message.method === "item/completed" && JSON.stringify(message).includes("Inspecting the failure"))).toBe(true);
    expect(notifications.some((message) => message.method === "item/started" && JSON.stringify(message).includes("tool-1"))).toBe(true);
    expect(notifications.some((message) => message.method === "item/completed" && JSON.stringify(message).includes("I found the issue") && JSON.stringify(message).includes("commentary"))).toBe(true);
    expect(notifications.some((message) => message.method === "item/completed" && JSON.stringify(message).includes("Done.") && JSON.stringify(message).includes("final_answer"))).toBe(true);
    expect(JSON.stringify(notifications.find((message) => message.method === "turn/completed"))).toContain(turnID);
    await adapter.close();
  });

  test("queues steer text on the same turn", async () => {
    const emitted: ProtocolMessage[] = [];
    const stream = new FakeSDKStream();
    let prompt: AsyncIterable<ReturnType<typeof userMessage>> | undefined;
    const adapter = new ClaudeRudderAdapter(
      (message) => {
        emitted.push(message);
      },
      (input) => {
        prompt = input.prompt;
        return stream.query();
      },
    );
    await adapter.handle({ id: 1, method: "initialize", params: {} });
    await adapter.handle({ id: 2, method: "thread/start", params: { cwd: "/tmp", sandbox: "workspace-write" } });
    const threadID = responseResult(emitted, 2, "thread.id");
    await adapter.handle({ id: 3, method: "turn/start", params: { threadId: threadID, input: [{ type: "text", text: "first" }] } });
    const turnID = responseResult(emitted, 3, "turn.id");
    await adapter.handle({ id: 4, method: "turn/steer", params: { threadId: threadID, expectedTurnId: turnID, input: [{ type: "text", text: "steer" }] } });
    const iterator = prompt![Symbol.asyncIterator]();
    expect(textOf((await iterator.next()).value)).toBe("first");
    expect(textOf((await iterator.next()).value)).toBe("steer");
    expect(responseResult(emitted, 4, "turnId")).toBe(turnID);
    await adapter.close();
  });
});

test("result status recognizes Claude abort terminal reasons", () => {
  expect(resultStatus({ subtype: "success", is_error: false } as SDKResultMessage)).toBe("completed");
  expect(resultStatus({ subtype: "error_during_execution", terminal_reason: "aborted_tools", errors: [] } as unknown as SDKResultMessage)).toBe("interrupted");
  expect(resultStatus({ subtype: "error_during_execution", terminal_reason: "model_error", errors: ["boom"] } as unknown as SDKResultMessage)).toBe("failed");
});

function sdk(value: unknown): SDKMessage {
  return value as SDKMessage;
}

function textOf(message: ReturnType<typeof userMessage> | undefined): string {
  if (!message || !Array.isArray(message.message.content)) return "";
  const block = message.message.content[0];
  return typeof block === "object" && block !== null && "text" in block ? String(block.text) : "";
}

function responseResult(messages: ProtocolMessage[], id: string | number, path: string): string {
  const response = messages.find((message) => "id" in message && message.id === id);
  let value: unknown = response && "result" in response ? response.result : undefined;
  for (const key of path.split(".")) {
    value = typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
  }
  if (typeof value !== "string")
    throw new Error(`missing ${path} for response ${id}: ${JSON.stringify(messages)}`);
  return value;
}

function notification(message: ProtocolMessage, method: string): boolean {
  return "method" in message && message.method === method;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for adapter event");
    await Bun.sleep(1);
  }
}
