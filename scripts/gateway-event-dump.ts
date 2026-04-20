import { randomUUID } from "node:crypto";
import { connectGatewayClient, disconnectGatewayClient } from "/Users/bytedance/Code/openclaw/src/gateway/test-helpers.e2e.ts";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "/Users/bytedance/Code/openclaw/src/utils/message-channel.ts";

const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || "ws://127.0.0.1:18789";
const token =
  process.env.OPENCLAW_GATEWAY_TOKEN || "407cb29684493b80f941ffe261c375c26e27c14da08421ed";
const message =
  process.argv.slice(2).join(" ").trim() ||
  "用一句话说明：Hermes在OpenClaw harness runtime里应该只是执行器。";

async function main() {
  const events: Array<{ event?: string; payload?: unknown }> = [];
  const client = await connectGatewayClient({
    url: gatewayUrl,
    token,
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    clientDisplayName: "hermes-event-dump",
    clientVersion: "1.0.0",
    platform: "test",
    mode: GATEWAY_CLIENT_MODES.CLI,
    onEvent: (event) => {
      events.push(event);
      console.log(JSON.stringify(event, null, 2));
    },
    timeoutMs: 15_000,
  });

  try {
    const sessionKey = `hermes-event-dump-${Date.now()}-${randomUUID().slice(0, 8)}`;
    await client.request("sessions.messages.subscribe", { key: sessionKey }).catch(() => undefined);
    const send = await client.request("chat.send", {
      sessionKey,
      message,
      idempotencyKey: `hermes-event-dump-${randomUUID()}`,
    });
    console.error(JSON.stringify({ sessionKey, send }, null, 2));
    await new Promise((resolve) => setTimeout(resolve, 90_000));
    console.error(JSON.stringify({ totalEvents: events.length }, null, 2));
  } finally {
    await disconnectGatewayClient(client);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
