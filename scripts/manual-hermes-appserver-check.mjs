import { createHermesAgentHarness } from "../src/harness.ts";

const partials = [];
const reasons = [];
const toolResults = [];
const events = [];

const harness = createHermesAgentHarness({
  pluginConfig: {
    hermesContainerName: "hermes-agent",
    timeout: 120,
  },
});

const result = await harness.runAttempt({
  provider: "hermes",
  modelId: "doubao-seed-2-0-pro-260215",
  model: {
    id: "doubao-seed-2-0-pro-260215",
    provider: "hermes",
    api: "hermes",
    input: ["text"],
    contextWindow: 128000,
  },
  authStorage: {},
  modelRegistry: {},
  thinkLevel: "medium",
  prompt:
    "请使用可用工具读取飞书文档 token=demo-doc，然后总结成一句话。如果没有飞书文档工具，就直接说明。",
  workspaceDir: process.cwd(),
  sessionId: `manual-hermes-${Date.now()}`,
  timeoutMs: 120000,
  config: {},
  images: [],
  skillsSnapshot: { prompt: "", skills: [], resolvedSkills: [] },
  toolsAllow: ["feishu_doc"],
  disableTools: false,
  execOverrides: {},
  bootstrapPromptWarningSignaturesSeen: [],
  onAssistantMessageStart: async () => {
    events.push("assistant_start");
  },
  onPartialReply: async ({ text }) => {
    partials.push(text);
  },
  onReasoningStream: async ({ text }) => {
    reasons.push(text);
  },
  onReasoningEnd: async () => {
    events.push("reasoning_end");
  },
  onToolResult: async ({ text }) => {
    toolResults.push(text);
  },
  onAgentEvent: async (event) => {
    events.push(event);
  },
});

console.log(
  JSON.stringify(
    {
      assistantTexts: result.assistantTexts,
      toolMetas: result.toolMetas,
      partialsCount: partials.length,
      reasoningCount: reasons.length,
      toolResultsCount: toolResults.length,
      eventsCount: events.length,
      replayMetadata: result.replayMetadata,
    },
    null,
    2,
  ),
);
