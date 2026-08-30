#!/usr/bin/env bun

import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin });

input.on("line", (line) => {
  const command = JSON.parse(line) as Record<string, unknown>;
  if (command.type === "get_state") {
    write({ type: "response", id: command.id, success: true, data: { sessionId: "pi_test_session" } });
    write({ type: "extension_ui_request", id: "ui-select", method: "select" });
    write({ type: "extension_ui_request", id: "ui-unknown", method: "futurePrompt" });
    write({ type: "extension_ui_request", id: "ui-notify", method: "notify" });
    return;
  }
  if (command.type === "extension_ui_response") {
    write({ type: "test_ui_response", response: command });
    return;
  }
  if (command.type !== "never_respond") {
    write({ type: "response", id: command.id, success: true });
  }
});

function write(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
