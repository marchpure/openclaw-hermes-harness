import { describe, expect, it, vi } from "vitest";
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

  it("initializes with ACP camelCase fields by default", async () => {
    const client = new HermesAcpClient(DEFAULT_CONFIG);
    const sendRequest = vi.fn().mockResolvedValue({});
    (client as unknown as { startTcp: () => Promise<void>; sendRequest: typeof sendRequest }).startTcp =
      async () => undefined;
    (client as unknown as { sendRequest: typeof sendRequest }).sendRequest = sendRequest;

    await client.start();

    expect(sendRequest).toHaveBeenCalledWith("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "openclaw-plugin-hermes", version: "1.0.0" },
      clientCapabilities: {},
    }, undefined);
  });

  it("falls back to snake_case ACP fields when primary params are rejected", async () => {
    const client = new HermesAcpClient(DEFAULT_CONFIG);
    const sendRequest = vi
      .fn()
      .mockRejectedValueOnce(new Error("ACP error [-32602]: invalid params: missing protocol_version"))
      .mockResolvedValueOnce({});
    (client as unknown as { startTcp: () => Promise<void>; sendRequest: typeof sendRequest }).startTcp =
      async () => undefined;
    (client as unknown as { sendRequest: typeof sendRequest }).sendRequest = sendRequest;

    await client.start();

    expect(sendRequest).toHaveBeenNthCalledWith(1, "initialize", {
      protocolVersion: 1,
      clientInfo: { name: "openclaw-plugin-hermes", version: "1.0.0" },
      clientCapabilities: {},
    }, undefined);
    expect(sendRequest).toHaveBeenNthCalledWith(2, "initialize", {
      protocol_version: 1,
      client_info: { name: "openclaw-plugin-hermes", version: "1.0.0" },
      client_capabilities: {},
    }, undefined);
  });

  it("resumes sessions using ACP camelCase ids by default", async () => {
    const client = new HermesAcpClient(DEFAULT_CONFIG);
    const sendRequest = vi.fn().mockResolvedValue({});
    (client as unknown as { sendRequest: typeof sendRequest }).sendRequest = sendRequest;

    await client.resumeSession("session-123", "/tmp/workspace");

    expect(sendRequest).toHaveBeenCalledWith("session/resume", {
      cwd: "/tmp/workspace",
      sessionId: "session-123",
    }, undefined);
    expect(client.currentSessionId).toBe("session-123");
  });
});
