import { randomUUID } from "node:crypto";
import { connectGatewayClient, disconnectGatewayClient } from "/Users/bytedance/Code/openclaw/src/gateway/test-helpers.e2e.ts";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "/Users/bytedance/Code/openclaw/src/utils/message-channel.ts";

type EventFrame = { event?: string; payload?: unknown };

type CaseResult = {
  name: string;
  sessionKey: string;
  runId?: string;
  status: "passed" | "failed";
  durationMs: number;
  finalText: string;
  chatEvents: number;
  sessionToolEvents: number;
  sessionMessageEvents: number;
  toolMentions: string[];
  reasoningSeen: boolean;
  error?: string;
};

const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || "ws://127.0.0.1:18789";
const token =
  process.env.OPENCLAW_GATEWAY_TOKEN || "407cb29684493b80f941ffe261c375c26e27c14da08421ed";

const cases = [
  {
    name: "skills-no-hermes-image-leak",
    message:
      "你有哪些skills？只回答当前OpenClaw会话可用的skills名称，不要列出Hermes镜像内置skills。",
    timeoutMs: 180_000,
    expect: (text: string, events: EventFrame[]) => {
      const lower = text.toLowerCase();
      return !lower.includes("browser_use") && !lower.includes("/opt/hermes") && events.length > 0;
    },
  },
  {
    name: "simple-no-tool",
    message: "用一句话说明：Hermes在OpenClaw harness runtime里应该只是执行器。",
    timeoutMs: 120_000,
    expect: (text: string) => text.includes("执行") || text.toLowerCase().includes("runtime"),
  },
  {
    name: "dynamic-tool-weather",
    message: "查询上海明天的天气，并说明是否需要带伞。请使用可用工具查询，不要凭空回答。",
    timeoutMs: 240_000,
    expect: (text: string, events: EventFrame[]) =>
      /天气|温度|雨|伞/.test(text) && collectToolNames(events).length > 0,
  },
  {
    name: "dynamic-tool-web-stock",
    message: "查询中芯国际最新股价，说明你用了什么查询动作。请使用可用工具查询。",
    timeoutMs: 300_000,
    expect: (text: string, events: EventFrame[]) =>
      /中芯国际|688981|00981|股价/.test(text) && collectToolNames(events).length > 0,
  },
  {
    name: "workspace-file-tool",
    message:
      "在当前workspace创建一个hermes-runtime-validation.txt文件，内容写入OpenClaw Hermes appserver validation，然后读回确认。",
    timeoutMs: 240_000,
    expect: (text: string, events: EventFrame[]) =>
      /hermes-runtime-validation|validation|确认|完成/.test(text) &&
      collectToolNames(events).some((name) => /exec|file|edit|shell|bash/i.test(name)),
  },
  {
    name: "feishu-skill-availability",
    message:
      "不要创建文档。请只判断当前OpenClaw会话是否有飞书文档相关能力，列出你看到的飞书相关skill/tool名称。",
    timeoutMs: 180_000,
    expect: (text: string) => /feishu|飞书|lark/i.test(text),
  },
] as const;

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
    clientDisplayName: "hermes-regression",
    clientVersion: "1.0.0",
    platform: "test",
    mode: GATEWAY_CLIENT_MODES.CLI,
    onEvent: (event) => events.push(event),
    timeoutMs: 15_000,
  });

  try {
    const catalog = await client.request("tools.effective", {
      sessionKey: "main",
    });
    console.log(JSON.stringify({ type: "tools.effective", catalog }, null, 2));

    const results: CaseResult[] = [];
    for (const testCase of cases) {
      const sessionKey = `hermes-validation-${testCase.name}-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const before = events.length;
      const startedAt = Date.now();
      try {
        await client.request("sessions.messages.subscribe", { key: sessionKey }).catch(() => undefined);
        const send = await client.request("chat.send", {
          sessionKey,
          message: testCase.message,
          idempotencyKey: `hermes-regression-${randomUUID()}`,
        });
        const runId = String((send as { runId?: unknown }).runId || "");
        if (!runId) {
          throw new Error(`chat.send did not return runId: ${JSON.stringify(send)}`);
        }
        const final = await waitForFinal(events, runId, sessionKey, testCase.timeoutMs);
        const finalText = readTextFromMessage(final.message);
        const caseEvents = events.slice(before);
        const passed = testCase.expect(finalText, caseEvents);
        results.push({
          name: testCase.name,
          sessionKey,
          runId,
          status: passed ? "passed" : "failed",
          durationMs: Date.now() - startedAt,
          finalText,
          chatEvents: caseEvents.filter((event) => event.event === "chat").length,
          sessionToolEvents: caseEvents.filter((event) => event.event === "session.tool").length,
          sessionMessageEvents: caseEvents.filter((event) => event.event === "session.message").length,
          toolMentions: collectToolNames(caseEvents),
          reasoningSeen: caseEvents.some((event) => JSON.stringify(event).includes("thinking")),
        });
      } catch (error) {
        results.push({
          name: testCase.name,
          sessionKey,
          status: "failed",
          durationMs: Date.now() - startedAt,
          finalText: "",
          chatEvents: events.slice(before).filter((event) => event.event === "chat").length,
          sessionToolEvents: events.slice(before).filter((event) => event.event === "session.tool").length,
          sessionMessageEvents: events.slice(before).filter((event) => event.event === "session.message").length,
          toolMentions: collectToolNames(events.slice(before)),
          reasoningSeen: events.slice(before).some((event) => JSON.stringify(event).includes("thinking")),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    console.log(JSON.stringify({ type: "case-results", results }, null, 2));
    const failed = results.filter((result) => result.status !== "passed");
    if (failed.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await disconnectGatewayClient(client);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
