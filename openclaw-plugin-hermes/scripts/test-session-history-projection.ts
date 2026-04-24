import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type AcpSessionEvent, type HermesPluginConfig } from "../src/types.js";
import { HermesAcpClient } from "../src/acp-client.js";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

type PromptPlan = {
  text: string;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
  events: AcpSessionEvent[];
};

type MockState = {
  promptCalls: Array<{ prompt: string; sessionId?: string }>;
  nextSessionId: number;
  plan: PromptPlan;
};

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "hermes-session-history-"));
  await writeFile(join(workspace, "SOUL.md"), "You are a continuity-sensitive assistant.", "utf8");
  await writeFile(join(workspace, "USER.md"), "The user expects you to remember prior turns.", "utf8");
  await writeFile(join(workspace, "AGENTS.md"), "Preserve conversation continuity.", "utf8");
  await mkdir(join(workspace, "skills", "local-helper"), { recursive: true });
  await writeFile(
    join(workspace, "skills", "local-helper", "SKILL.md"),
    "# Local Helper\n\nProjectable local helper.",
    "utf8",
  );
  return workspace;
}

function installMockAcpClient(state: MockState): void {
  HermesAcpClient.prototype.start = async function start(): Promise<void> {};
  HermesAcpClient.prototype.newSession = async function newSession(): Promise<string> {
    return `mock-session-${state.nextSessionId++}`;
  };
  HermesAcpClient.prototype.loadSession = async function loadSession(sessionId: string): Promise<string> {
    return sessionId;
  };
  HermesAcpClient.prototype.prompt = async function prompt(
    promptText: string,
    sessionId?: string,
  ): Promise<{
    text: string;
    events: AcpSessionEvent[];
    usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
  }> {
    state.promptCalls.push({ prompt: promptText, sessionId });
    return {
      text: state.plan.text,
      events: state.plan.events,
      usage: state.plan.usage,
    };
  };
  HermesAcpClient.prototype.close = async function close(): Promise<void> {};
}

async function main(): Promise<void> {
  const workspace = await createWorkspace();
  const sessionFile = join(workspace, "session.jsonl");
  await writeFile(
    sessionFile,
    [
      JSON.stringify({ type: "session", version: 3, id: "session-history-test" }),
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "我入市一年，偏好科技类股票" }],
          timestamp: Date.now() - 2_000,
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "我记住了，你偏好科技类股票。" }],
          timestamp: Date.now() - 1_000,
        },
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const state: MockState = {
    promptCalls: [],
    nextSessionId: 1,
    plan: {
      text: "你偏好科技类股票。",
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      events: [{ type: "text", text: "你偏好科技类股票。" }, { type: "done" }],
    },
  };
  installMockAcpClient(state);

  const openclawStateDir = await mkdtemp(join(tmpdir(), "hermes-session-history-state-"));
  process.env.OPENCLAW_STATE_DIR = openclawStateDir;

  const { runHermesHarnessAttempt } = await import("../src/harness-runtime.js");

  const config: HermesPluginConfig = {
    ...DEFAULT_CONFIG,
    hermesDataDir: join(openclawStateDir, "hermes-data"),
    runtimeExecEnvRootDir: join(openclawStateDir, "execenv"),
    mirrorExecEnvToContainer: false,
    defaultContextLevel: "L3",
    runtimeMinContextLevel: "L3",
    timeout: 60,
  };

  const result = await runHermesHarnessAttempt(config, {
    sessionId: "session-history-test",
    sessionKey: "agent:main:session-history-test",
    sessionFile,
    agentId: "main",
    workspaceDir: workspace,
    provider: "hermes",
    modelId: "default",
    model: { api: "responses", id: "default" } as never,
    prompt: "我偏好什么类型的股票？",
    timeoutMs: 5000,
  } as any);

  const prompt = state.promptCalls[0]?.prompt ?? "";
  assert(prompt.includes("# Conversation History"), "bootstrap prompt should include conversation history");
  assert(prompt.includes("我入市一年，偏好科技类股票"), "history should include prior user preference");
  assert(prompt.includes("我记住了，你偏好科技类股票。"), "history should include prior assistant acknowledgment");
  assert(result.assistantText === "你偏好科技类股票。", "mock assistant response should flow through");

  console.log("session history projection test: ok");
}

void main();
