import { describe, expect, it } from "vitest";
import { HermesAcpClient } from "./acp-client.js";
import { DEFAULT_CONFIG } from "./types.js";

describe("Hermes ACP client", () => {
  function parseSessionEvent(data: Record<string, unknown>) {
    const client = new HermesAcpClient(DEFAULT_CONFIG);
    return (client as unknown as {
      parseSessionEvent(data: Record<string, unknown>): unknown;
    }).parseSessionEvent(data);
  }

  it("parses ACP content chunks with array content blocks", () => {
    expect(
      parseSessionEvent({
        sessionUpdate: "agent_message_chunk",
        content: [
          { type: "text", text: "hello " },
          { type: "text", text: "world" },
        ],
      }),
    ).toEqual({
      type: "text",
      text: "hello world",
    });
  });

  it("maps official ACP tool call updates to harness tool events", () => {
    expect(
      parseSessionEvent({
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Read file",
      }),
    ).toEqual({
      type: "tool_progress",
      toolName: "Read file",
      toolCallId: "tool-1",
    });

    expect(
      parseSessionEvent({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        title: "Read file",
        status: "completed",
        rawOutput: { ok: true },
      }),
    ).toEqual({
      type: "tool_result",
      toolName: "Read file",
      toolCallId: "tool-1",
      text: "{\"ok\":true}",
    });
  });
});
