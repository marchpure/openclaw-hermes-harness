import { randomUUID } from "node:crypto";
import { connectGatewayClient, disconnectGatewayClient } from "/Users/bytedance/Code/openclaw/src/gateway/test-helpers.e2e.ts";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "/Users/bytedance/Code/openclaw/src/utils/message-channel.ts";

type EventFrame = { event?: string; payload?: unknown };

const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || "ws://127.0.0.1:18789";
const token =
  process.env.OPENCLAW_GATEWAY_TOKEN || "407cb29684493b80f941ffe261c375c26e27c14da08421ed";
const message =
  process.argv.slice(2).join(" ").trim() ||
  "你有哪些skills？只回答当前OpenClaw会话可用的skills名称，不要列出Hermes镜像内置skills。";

function getObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readTextFromMessage(message: unknown): string {
  const obj = getObject(message);
  const content = obj?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        const entry = getObject(item);
        return typeof entry?.text === "string" ? entry.text : "";
      })
      .join("");
  }
  return "";
}

function collectToolNames(events: EventFrame[]): string[] {
  const names = new Set<string>();
  for (const event of events) {
    const payload = getObject(event.payload);
    const data = getObject(payload?.data) ?? payload;
    for (const key of ["name", "tool", "toolName", "title"]) {
      const value = data?.[key];
      if (typeof value === "string" && value.trim()) {
        names.add(value.trim());
      }
    }
  }
  return [...names];
}

async function waitForFinal(events: EventFrame[], runId: string, sessionKey: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const event of events) {
      if (event.event !== "chat") {
        continue;
      }
      const payload = getObject(event.payload);
      if (
        payload?.runId === runId &&
        payload?.sessionKey === sessionKey &&
        payload?.state === "final"
      ) {
        return payload;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for final event: ${runId}`);
}

async function main() {
  const events: EventFrame[] = [];
  const client = await connectGatewayClient({
    url: gatewayUrl,
    token,
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    clientDisplayName: "hermes-single-case",
    clientVersion: "1.0.0",
    platform: "test",
    mode: GATEWAY_CLIENT_MODES.CLI,
    onEvent: (event) => events.push(event),
    timeoutMs: 15_000,
  });

  try {
    const sessionKey = `hermes-single-${Date.now()}-${randomUUID().slice(0, 8)}`;
    await client.request("sessions.messages.subscribe", { key: sessionKey }).catch(() => undefined);
    const send = await client.request("chat.send", {
      sessionKey,
      message,
      idempotencyKey: `hermes-single-${randomUUID()}`,
    });
    const runId = String((send as { runId?: unknown }).runId || "");
    const final = await waitForFinal(events, runId, sessionKey, 300_000);
    const finalText = readTextFromMessage(final.message);
    console.log(
      JSON.stringify(
        {
          sessionKey,
          runId,
          message,
          finalText,
          toolMentions: collectToolNames(events),
          chatEvents: events.filter((event) => event.event === "chat").length,
          sessionToolEvents: events.filter((event) => event.event === "session.tool").length,
          sessionMessageEvents: events.filter((event) => event.event === "session.message").length,
          reasoningSeen: events.some((event) => JSON.stringify(event).includes("thinking")),
        },
        null,
        2,
      ),
    );
  } finally {
    await disconnectGatewayClient(client);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
