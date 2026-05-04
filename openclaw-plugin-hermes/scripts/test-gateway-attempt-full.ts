import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HermesAcpClient } from "../src/acp-client.js";
import { DEFAULT_CONFIG, type AcpSessionEvent, type HermesPluginConfig } from "../src/types.js";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

type PromptCall = {
  prompt: string;
  sessionId: string;
  timeout?: number;
  signal?: AbortSignal;
};

type StartCall = {
  called: boolean;
};

type MockState = {
  startCalls: StartCall[];
  newSessionCwds: string[];
  resumeCalls: Array<{ sessionId: string; cwd: string }>;
  promptCalls: PromptCall[];
  closeCount: number;
};

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "hermes-gateway-attempt-workspace-"));
  await writeFile(join(workspace, "SOUL.md"), "You are the gateway-attempt test agent.", "utf8");
  await writeFile(join(workspace, "USER.md"), "The user prefers exact routing assertions.", "utf8");
  await writeFile(join(workspace, "AGENTS.md"), "Preserve gateway attempt metadata.", "utf8");
  await mkdir(join(workspace, "skills", "attempt-audit"), { recursive: true });
  await writeFile(
    join(workspace, "skills", "attempt-audit", "SKILL.md"),
    "# Attempt Audit\n\nVerify gateway attempt metadata end to end.",
    "utf8",
  );
  await mkdir(join(workspace, "skills", "browser"), { recursive: true });
  await writeFile(
    join(workspace, "skills", "browser", "SKILL.md"),
    "# Browser\n\nHost-backed browser skill that should not be projected as local.",
    "utf8",
  );
  return workspace;
}

function installMockAcpClient(state: MockState): void {
  HermesAcpClient.prototype.start = async function start(): Promise<void> {
    state.startCalls.push({ called: true });
  };

  HermesAcpClient.prototype.newSession = async function newSession(options: {
    cwd: string;
  }): Promise<string> {
    state.newSessionCwds.push(options.cwd);
    return "mock-hermes-session-1";
  };

  HermesAcpClient.prototype.resumeSession = async function resumeSession(
    sessionId: string,
    options: { cwd: string },
  ): Promise<string> {
    state.resumeCalls.push({ sessionId, cwd: options.cwd });
    return sessionId;
  };

  HermesAcpClient.prototype.prompt = async function prompt(
    promptText: string,
    sessionId?: string,
    options?: {
      timeout?: number;
      signal?: AbortSignal;
      onEvent?: (event: AcpSessionEvent) => void | Promise<void>;
    },
  ): Promise<{
    text: string;
    events: AcpSessionEvent[];
    usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
  }> {
    assert(sessionId === "mock-hermes-session-1", "prompt should use the newly created Hermes session");
    state.promptCalls.push({
      prompt: promptText,
      sessionId: sessionId ?? "",
      timeout: options?.timeout,
      signal: options?.signal,
    });

    const events: AcpSessionEvent[] = [
      { type: "thinking", text: "reasoning: inspect gateway attempt" },
      { type: "tool_progress", toolName: "attempt_audit", toolCallId: "tool-1" },
      { type: "tool_result", toolName: "attempt_audit", toolCallId: "tool-1", text: "attempt metadata accepted" },
      { type: "text", text: "Gateway attempt received. " },
      { type: "text", text: "All routing fields preserved." },
      { type: "done" },
    ];

    for (const event of events) {
      await options?.onEvent?.(event);
    }

    return {
      text: "Gateway attempt received. All routing fields preserved.",
      events,
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        total_tokens: 18,
      },
    };
  };

  HermesAcpClient.prototype.close = async function close(): Promise<void> {
    state.closeCount += 1;
  };
}

async function main(): Promise<void> {
  const workspace = await createWorkspace();
  const openclawStateDir = await mkdtemp(join(tmpdir(), "hermes-gateway-attempt-state-"));
  process.env.OPENCLAW_STATE_DIR = openclawStateDir;

  const [{ runHermesHarnessAttempt, __testing }, { setHermesHarnessAgentEventEmitterForTest }, { resolveStableSessionAnchor }] =
    await Promise.all([
      import("../src/harness-runtime.js"),
      import("../src/agent-event-bridge.js"),
      import("../src/runtime-client.js"),
    ]);

  const mockState: MockState = {
    startCalls: [],
    newSessionCwds: [],
    resumeCalls: [],
    promptCalls: [],
    closeCount: 0,
  };
  installMockAcpClient(mockState);

  const callbackEvents: string[] = [];
  const partialReplies: string[] = [];
  const reasoningChunks: string[] = [];
  const toolResults: string[] = [];
  const agentEvents: Array<{ stream: string; data: Record<string, unknown> }> = [];
  const emittedGatewayEvents: Array<{
    runId: string;
    stream: string;
    data: Record<string, unknown>;
    sessionKey?: string;
  }> = [];

  setHermesHarnessAgentEventEmitterForTest((event) => {
    emittedGatewayEvents.push(event);
  });

  const abortController = new AbortController();
  const sessionFile = join(openclawStateDir, "agents", "main", "sessions", "session.jsonl");
  const attemptParams = {
    sessionId: "gateway-session-id",
    sessionKey: "agent:main:web-full-attempt",
    agentId: "main",
    messageChannel: "webchat",
    messageProvider: "openclaw-web",
    agentAccountId: "account-main",
    trigger: "user",
    messageTo: "webchat:user:42",
    messageThreadId: "thread-7",
    groupId: "group-1",
    groupChannel: "general",
    groupSpace: "space-1",
    spawnedBy: null,
    senderId: "sender-1",
    senderName: "Gateway User",
    senderUsername: "gateway_user",
    senderE164: "+15550001111",
    senderIsOwner: true,
    currentChannelId: "channel-1",
    currentThreadTs: "1710000000.0001",
    currentMessageId: "message-1",
    replyToMode: "first",
    hasRepliedRef: { value: false },
    requireExplicitMessageTarget: true,
    disableMessageTool: false,
    allowGatewaySubagentBinding: true,
    sessionFile,
    workspaceDir: workspace,
    agentDir: join(workspace, ".openclaw", "agents", "main"),
    config: { gateway: { port: 18789 } },
    prompt: `请确认 gateway attempt 中的字段都被 Hermes harness 保留。参考真实路径 ${workspace}/fixtures/input.txt，但不要同步旁路路径 ${workspace}2/leak.txt。`,
    images: [],
    imageOrder: [],
    clientTools: [{ type: "function", function: { name: "hosted_search" } }],
    disableTools: false,
    provider: "hermes",
    modelId: "minimax-m2.5",
    model: { api: "responses", id: "minimax-m2.5" } as never,
    authStorage: {} as never,
    modelRegistry: {} as never,
    thinkLevel: "medium",
    fastMode: false,
    verboseLevel: "normal",
    reasoningLevel: "medium",
    toolResultFormat: "auto",
    suppressToolErrorWarnings: false,
    bootstrapContextMode: "full",
    bootstrapContextRunKind: "default",
    toolsAllow: ["attempt_audit"],
    bootstrapPromptWarningSignaturesSeen: ["seen-warning"],
    bootstrapPromptWarningSignature: "current-warning",
    execOverrides: {
      host: "local",
      security: "workspace-write",
      ask: "never",
      node: "auto",
    },
    bashElevated: {
      security: "workspace-write",
      ask: "never",
    },
    timeoutMs: 12_345,
    runId: "run-full-attempt",
    abortSignal: abortController.signal,
    shouldEmitToolResult: () => true,
    shouldEmitToolOutput: () => true,
    onPartialReply: (payload: { text?: string }) => {
      partialReplies.push(payload.text ?? "");
    },
    onAssistantMessageStart: () => {
      callbackEvents.push("assistant-start");
    },
    onReasoningStart: () => {
      callbackEvents.push("reasoning-start");
    },
    onReasoningStream: (payload: { text?: string }) => {
      reasoningChunks.push(payload.text ?? "");
    },
    onReasoningEnd: () => {
      callbackEvents.push("reasoning-end");
    },
    onToolResult: (payload: { text?: string }) => {
      toolResults.push(payload.text ?? "");
    },
    onAgentEvent: (event: { stream: string; data: Record<string, unknown> }) => {
      agentEvents.push(event);
    },
    lane: "interactive",
    extraSystemPrompt: "extra gateway system prompt",
    internalEvents: [{ type: "test", data: { ok: true } }] as never,
    inputProvenance: { source: "webchat" } as never,
    streamParams: { mode: "webchat" } as never,
    ownerNumbers: ["+15550001111"],
    enforceFinalTag: false,
    silentExpected: false,
    allowTransientCooldownProbe: true,
    cleanupBundleMcpOnRunEnd: true,
  } as any;

  const config: HermesPluginConfig = {
    ...DEFAULT_CONFIG,
    hermesDataDir: join(openclawStateDir, "hermes-data"),
    runtimeExecEnvRootDir: join(openclawStateDir, "execenv"),
    mirrorExecEnvToContainer: false,
    defaultContextLevel: "L3",
    runtimeMinContextLevel: "L3",
    timeout: 60,
  };

  const result = await runHermesHarnessAttempt(config, attemptParams);
  setHermesHarnessAgentEventEmitterForTest(undefined);

  const expectedAnchor = resolveStableSessionAnchor({
    workspaceDir: attemptParams.workspaceDir,
    sessionKey: attemptParams.sessionKey,
    sessionFile: attemptParams.sessionFile,
    sessionId: attemptParams.sessionId,
    agentId: attemptParams.agentId,
  });

  assert(mockState.startCalls.length === 1, "ACP client should be started once");
  assert(mockState.closeCount === 1, "ACP client should be closed once");
  assert(mockState.resumeCalls.length === 0, "first attempt should not resume a missing binding");
  assert(mockState.newSessionCwds.length === 1, "first attempt should create one Hermes session");
  assert(
    mockState.newSessionCwds[0]?.endsWith(expectedAnchor),
    "projected execenv path should be anchored by the gateway sessionKey-derived stable anchor",
  );
  assert(mockState.promptCalls.length === 1, "prompt should be sent exactly once");
  assert(mockState.promptCalls[0]?.timeout === attemptParams.timeoutMs, "gateway timeoutMs should be passed to ACP prompt");
  assert(mockState.promptCalls[0]?.signal === abortController.signal, "gateway abortSignal should be passed to ACP prompt");
  assert(
    mockState.promptCalls[0]?.prompt.includes(attemptParams.prompt),
    "bootstrap prompt should contain the original gateway prompt",
  );
  const extractedWorkspacePaths = __testing.extractWorkspacePaths(attemptParams.prompt, workspace);
  assert(
    extractedWorkspacePaths.includes(`${workspace}/fixtures/input.txt`),
    "workspace path extraction should include exact in-workspace paths mentioned in the prompt",
  );
  assert(
    !extractedWorkspacePaths.some((path) => path.includes(`${workspace}2/leak.txt`)),
    "workspace path extraction must not treat workspace-prefix siblings as in-workspace paths",
  );
  assert(
    mockState.promptCalls[0]?.prompt.includes("attempt-audit"),
    "projected prompt should include projectable workspace skills",
  );
  assert(
    mockState.promptCalls[0]?.prompt.includes("**browser**") &&
      mockState.promptCalls[0]?.prompt.includes("browser"),
    "host-backed browser skill should be exposed through the MCP invocation contract",
  );

  const bindingStore = JSON.parse(
    await readFile(join(openclawStateDir, "hermes", "session-bindings.json"), "utf8"),
  ) as Record<string, { sessionId: string; runtimeExecEnvPath: string }>;
  const bindingRecords = Object.values(bindingStore);
  assert(bindingRecords.length === 1, "session binding should be persisted once");
  assert(bindingRecords[0]?.sessionId === "mock-hermes-session-1", "persisted binding should store Hermes session id");

  assert(result.sessionId === "mock-hermes-session-1", "result should expose the Hermes session id used");
  assert(result.assistantText === "Gateway attempt received. All routing fields preserved.", "assistant text should come from ACP result");
  assert(result.assistantTexts?.[0] === result.assistantText, "assistantTexts should mirror final assistant text");
  assert(result.finalPromptText === attemptParams.prompt, "finalPromptText should preserve raw gateway prompt");
  assert(result.usage?.input === 11 && result.usage.output === 7 && result.usage.total === 18, "usage should be normalized from ACP token usage");
  assert(result.hadPotentialSideEffects === true, "tool events should mark potential side effects");
  assert(result.replaySafe === false, "tool events should make replay unsafe");
  assert(result.toolMetas?.[0]?.toolName === "attempt_audit", "tool metadata should preserve tool name");
  assert(result.toolMetas?.[0]?.meta === "attempt metadata accepted", "tool metadata should preserve tool result summary");
  assert(result.itemLifecycle?.startedCount === 1, "item lifecycle should account for assistant/tool activity");
  assert(result.itemLifecycle?.completedCount === 1, "item lifecycle should complete assistant/tool activity");
  assert(result.itemLifecycle?.activeCount === 0, "item lifecycle should not leave active items");

  const userMessage = result.messagesSnapshot?.[0] as { role?: string; content?: unknown };
  const assistantMessage = result.lastAssistant as
    | {
        role?: string;
        api?: string;
        provider?: string;
        model?: string;
        content?: Array<{ type: string; text: string }>;
        usage?: { input: number; output: number; total: number };
      };
  assert(userMessage?.role === "user", "messagesSnapshot should start with the gateway user prompt");
  assert(userMessage.content === attemptParams.prompt, "user message should preserve raw gateway prompt text");
  assert(assistantMessage?.role === "assistant", "lastAssistant should be an assistant message");
  assert(assistantMessage.api === "responses", "assistant message should preserve params.model.api");
  assert(assistantMessage.provider === "hermes", "assistant message should preserve gateway provider");
  assert(assistantMessage.model === "minimax-m2.5", "assistant message should preserve gateway modelId");
  assert(assistantMessage.content?.[0]?.text === result.assistantText, "assistant message should preserve final text");
  assert(assistantMessage.usage?.total === 18, "assistant message should preserve normalized usage");

  assert(callbackEvents.filter((event) => event === "assistant-start").length === 1, "onAssistantMessageStart should fire once");
  assert(callbackEvents.includes("reasoning-start"), "onReasoningStart should fire");
  assert(callbackEvents.includes("reasoning-end"), "onReasoningEnd should fire");
  assert(reasoningChunks.join("").includes("inspect gateway attempt"), "onReasoningStream should receive ACP thinking text");
  assert(partialReplies.join("") === result.assistantText, "onPartialReply should receive assistant deltas");
  assert(toolResults.length === 0, "onToolResult should not surface raw ACP tool result text");
  assert(agentEvents.some((event) => event.stream === "assistant"), "onAgentEvent should receive assistant stream events");
  assert(agentEvents.some((event) => event.stream === "thinking"), "onAgentEvent should receive thinking stream events");
  assert(agentEvents.some((event) => event.stream === "tool"), "onAgentEvent should receive tool stream events");
  assert(
    emittedGatewayEvents.every((event) => event.runId === attemptParams.runId),
    "published gateway events should preserve runId",
  );
  assert(
    emittedGatewayEvents.every((event) => event.sessionKey === attemptParams.sessionKey),
    "published gateway events should preserve sessionKey",
  );

  console.log("gateway attempt full test: ok");
  console.log(
    JSON.stringify(
      {
        sessionAnchor: expectedAnchor,
        execEnvPath: mockState.newSessionCwds[0],
        promptSessionId: mockState.promptCalls[0]?.sessionId,
        callbackEvents,
        partialReplies,
        reasoningChunks,
        toolResults,
        publishedStreams: emittedGatewayEvents.map((event) => event.stream),
        assistantText: result.assistantText,
        usage: result.usage,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
