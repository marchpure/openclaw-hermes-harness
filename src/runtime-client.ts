import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
  NormalizedUsage,
} from "openclaw/plugin-sdk/agent-harness";
import { HermesAcpClient, type AcpPromptBlock } from "./acp-client.js";
import type { AcpSessionEvent, HermesPluginConfig } from "./types.js";

const ZERO_ASSISTANT_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

type HarnessMessage = AgentHarnessAttemptResult["messagesSnapshot"][number];

export type HermesRunResponse = {
  assistantText?: string;
  assistantTexts?: string[];
  sessionId?: string;
  usage?: NormalizedUsage;
  hadPotentialSideEffects?: boolean;
  replaySafe?: boolean;
  aborted?: boolean;
  externalAbort?: boolean;
  timedOut?: boolean;
  promptError?: unknown;
  promptErrorSource?: "prompt" | "compaction" | "precheck" | null;
  finalPromptText?: string;
  messagesSnapshot?: AgentHarnessAttemptResult["messagesSnapshot"];
  toolMetas?: Array<{ toolName: string; meta?: string }>;
  lastAssistant?: HarnessMessage | undefined;
  currentAttemptAssistant?: HarnessMessage | undefined;
  itemLifecycle?: {
    startedCount: number;
    completedCount: number;
    activeCount: number;
  };
};

export type HermesRuntimeClient = {
  runAttempt(params: AgentHarnessAttemptParams): Promise<HermesRunResponse>;
};

type HermesHarnessBinding = {
  schemaVersion: 1;
  sessionFile: string;
  sessionId: string;
  cwd: string;
  contextHash: string;
  model?: string;
  agentId?: string;
  transport: HermesPluginConfig["transport"];
  createdAt: string;
  updatedAt: string;
};

export function createHermesRuntimeClient(options: {
  config: HermesPluginConfig;
}): HermesRuntimeClient {
  return {
    runAttempt: (params) => runHermesHarnessAttempt(options.config, params),
  };
}

export async function clearHermesHarnessBinding(sessionFile: string): Promise<void> {
  await rm(resolveHermesHarnessBindingPath(sessionFile), { force: true });
}

export async function runHermesHarnessAttempt(
  config: HermesPluginConfig,
  params: AgentHarnessAttemptParams,
): Promise<HermesRunResponse> {
  const logger = {
    info: (msg: string, ...args: unknown[]) => console.log(`[hermes] ${msg}`, ...args),
    warn: (msg: string, ...args: unknown[]) => console.warn(`[hermes] ${msg}`, ...args),
    error: (msg: string, ...args: unknown[]) => console.error(`[hermes] ${msg}`, ...args),
  };
  const client = new HermesAcpClient(config, logger);
  const timeoutMs = Math.max(1, params.timeoutMs);
  const promptBlocks = await buildHermesHarnessPromptBlocks(params);
  const finalPromptText = readTextPrompt(promptBlocks);
  const contextHash = buildHermesHarnessContextHash(promptBlocks);
  const toolMetas = new Map<string, { toolName: string; meta?: string }>();
  let assistantStarted = false;
  let reasoningStarted = false;
  let reasoningEnded = false;
  let timedOut = false;
  let aborted = false;
  let promptError: unknown = null;

  const timeoutController = new AbortController();
  const upstreamAbort = () => {
    aborted = true;
    timeoutController.abort(params.abortSignal?.reason ?? "upstream_abort");
  };
  if (params.abortSignal?.aborted) {
    upstreamAbort();
  } else {
    params.abortSignal?.addEventListener("abort", upstreamAbort, { once: true });
  }

  const timeout = setTimeout(() => {
    timedOut = true;
    aborted = true;
    timeoutController.abort("timeout");
  }, timeoutMs);

  try {
    await client.start({}, params.workspaceDir);
    let session = await resolveHermesHarnessSession(client, config, params, contextHash);
    let result;
    try {
      result = await promptHermesHarness(client, promptBlocks, session.sessionId, params, timeoutMs, timeoutController.signal, {
        get assistantStarted() {
          return assistantStarted;
        },
        set assistantStarted(value: boolean) {
          assistantStarted = value;
        },
        get reasoningStarted() {
          return reasoningStarted;
        },
        set reasoningStarted(value: boolean) {
          reasoningStarted = value;
        },
        get reasoningEnded() {
          return reasoningEnded;
        },
        set reasoningEnded(value: boolean) {
          reasoningEnded = value;
        },
        toolMetas,
      });
    } catch (err) {
      if (!session.reused || config.transport !== "tcp" || timeoutController.signal.aborted) {
        throw err;
      }
      await clearHermesHarnessBinding(params.sessionFile);
      session = await createHermesHarnessSession(client, config, params, contextHash);
      result = await promptHermesHarness(client, promptBlocks, session.sessionId, params, timeoutMs, timeoutController.signal, {
        get assistantStarted() {
          return assistantStarted;
        },
        set assistantStarted(value: boolean) {
          assistantStarted = value;
        },
        get reasoningStarted() {
          return reasoningStarted;
        },
        set reasoningStarted(value: boolean) {
          reasoningStarted = value;
        },
        get reasoningEnded() {
          return reasoningEnded;
        },
        set reasoningEnded(value: boolean) {
          reasoningEnded = value;
        },
        toolMetas,
      });
    }

    if (reasoningStarted && !reasoningEnded) {
      await params.onReasoningEnd?.();
      reasoningEnded = true;
    }

    const usage = normalizeAcpUsage(result.usage);
    const assistantText = result.text;
    const lastAssistant = buildAssistantMessage(params, assistantText, usage, {
      aborted,
      errorMessage: null,
    });
    const messagesSnapshot = [
      buildUserMessage(params),
      ...(lastAssistant ? [lastAssistant] : []),
    ] as AgentHarnessAttemptResult["messagesSnapshot"];

    return {
      assistantText,
      assistantTexts: assistantText ? [assistantText] : [],
      sessionId: session.sessionId,
      ...(usage ? { usage } : {}),
      hadPotentialSideEffects: toolMetas.size > 0,
      replaySafe: toolMetas.size === 0,
      aborted,
      externalAbort: aborted && !timedOut,
      timedOut,
      promptError: null,
      promptErrorSource: null,
      finalPromptText,
      messagesSnapshot,
      toolMetas: [...toolMetas.values()],
      lastAssistant,
      currentAttemptAssistant: lastAssistant,
      itemLifecycle: {
        startedCount: Math.max(assistantStarted ? 1 : 0, toolMetas.size),
        completedCount: Math.max(assistantText ? 1 : 0, toolMetas.size),
        activeCount: 0,
      },
    };
  } catch (err) {
    promptError = err;
    aborted ||= timeoutController.signal.aborted;
    const message = err instanceof Error ? err.message : String(err);
    const usage = undefined;
    const lastAssistant = buildAssistantMessage(params, "", usage, {
      aborted,
      errorMessage: message,
    });
    return {
      assistantText: "",
      assistantTexts: [],
      sessionId: params.sessionId,
      aborted,
      externalAbort: aborted && !timedOut,
      timedOut,
      promptError,
      promptErrorSource: "prompt",
      finalPromptText,
      messagesSnapshot: [buildUserMessage(params), lastAssistant] as AgentHarnessAttemptResult["messagesSnapshot"],
      toolMetas: [...toolMetas.values()],
      lastAssistant,
      currentAttemptAssistant: lastAssistant,
      hadPotentialSideEffects: toolMetas.size > 0,
      replaySafe: toolMetas.size === 0,
      itemLifecycle: {
        startedCount: toolMetas.size,
        completedCount: toolMetas.size,
        activeCount: 0,
      },
    };
  } finally {
    clearTimeout(timeout);
    params.abortSignal?.removeEventListener("abort", upstreamAbort);
    await client.close({ closeSession: config.transport !== "tcp" }).catch(() => {});
  }
}

export async function buildHermesHarnessPromptBlocks(params: AgentHarnessAttemptParams): Promise<AcpPromptBlock[]> {
  const workspaceContext = await buildWorkspaceContextPrompt(params.workspaceDir);
  const sections = [
    "# OpenClaw Runtime",
    [
      "You are executing as the current OpenClaw agent through the Hermes ACP runtime.",
      "Preserve the active OpenClaw agent identity, workspace, session, and channel context.",
      "If Hermes has its own default assistant identity, treat it only as the execution backend; do not replace the OpenClaw agent identity with it.",
      "Use Hermes tools for execution. If OpenClaw dynamic tools are unavailable through ACP, explain the limitation instead of pretending to call them.",
    ].join("\n"),
    params.agentId ? `# Agent\nagentId: ${params.agentId}` : undefined,
    workspaceContext ? `# Workspace Context\n${workspaceContext}` : undefined,
    params.extraSystemPrompt ? `# Developer Instructions\n${params.extraSystemPrompt}` : undefined,
    params.skillsSnapshot?.prompt ? `# Available Skills\n${params.skillsSnapshot.prompt}` : undefined,
    params.toolsAllow?.length ? `# OpenClaw Tool Allowlist\n${params.toolsAllow.map((tool) => `- ${tool}`).join("\n")}` : undefined,
    `# User Prompt\n${params.prompt}`,
  ].filter((section): section is string => Boolean(section && section.trim()));

  const blocks: AcpPromptBlock[] = [{ type: "text", text: sections.join("\n\n---\n\n") }];
  for (const image of params.images ?? []) {
    blocks.push({
      type: "image",
      data: image.data,
      mimeType: image.mimeType,
      mime_type: image.mimeType,
      url: `data:${image.mimeType};base64,${image.data}`,
    });
  }
  return blocks;
}

async function resolveHermesHarnessSession(
  client: HermesAcpClient,
  config: HermesPluginConfig,
  params: AgentHarnessAttemptParams,
  contextHash: string,
): Promise<{ sessionId: string; reused: boolean }> {
  if (config.transport === "tcp") {
    const binding = await readHermesHarnessBinding(params.sessionFile);
    if (
      binding?.sessionId &&
      binding.cwd === params.workspaceDir &&
      binding.contextHash === contextHash &&
      binding.agentId === params.agentId &&
      binding.model === params.modelId
    ) {
      return { sessionId: binding.sessionId, reused: true };
    }
  }

  return createHermesHarnessSession(client, config, params, contextHash);
}

async function createHermesHarnessSession(
  client: HermesAcpClient,
  config: HermesPluginConfig,
  params: AgentHarnessAttemptParams,
  contextHash: string,
): Promise<{ sessionId: string; reused: boolean }> {
  const sessionId = await client.newSession(params.workspaceDir);
  if (config.transport === "tcp") {
    await writeHermesHarnessBinding(params.sessionFile, {
      schemaVersion: 1,
      sessionFile: params.sessionFile,
      sessionId,
      cwd: params.workspaceDir,
      contextHash,
      model: params.modelId,
      agentId: params.agentId,
      transport: config.transport,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  return { sessionId, reused: false };
}

async function promptHermesHarness(
  client: HermesAcpClient,
  promptBlocks: AcpPromptBlock[],
  sessionId: string,
  params: AgentHarnessAttemptParams,
  timeoutMs: number,
  signal: AbortSignal,
  state: {
    assistantStarted: boolean;
    reasoningStarted: boolean;
    reasoningEnded: boolean;
    toolMetas: Map<string, { toolName: string; meta?: string }>;
  },
): ReturnType<HermesAcpClient["prompt"]> {
  return client.prompt(promptBlocks, sessionId, {
    timeout: timeoutMs,
    signal,
    onEvent: async (event) => {
      await handleHarnessEvent(event, params, {
        markAssistantStarted: async () => {
          if (state.assistantStarted) return;
          state.assistantStarted = true;
          await params.onAssistantMessageStart?.();
        },
        markReasoningStarted: () => {
          state.reasoningStarted = true;
        },
        markReasoningEnded: async () => {
          if (!state.reasoningStarted || state.reasoningEnded) return;
          state.reasoningEnded = true;
          await params.onReasoningEnd?.();
        },
        toolMetas: state.toolMetas,
      });
    },
  });
}

async function handleHarnessEvent(
  event: AcpSessionEvent,
  params: AgentHarnessAttemptParams,
  state: {
    markAssistantStarted: () => Promise<void>;
    markReasoningStarted: () => void;
    markReasoningEnded: () => Promise<void>;
    toolMetas: Map<string, { toolName: string; meta?: string }>;
  },
): Promise<void> {
  if (event.type === "text" && event.text) {
    await state.markAssistantStarted();
    await params.onPartialReply?.({ text: event.text });
    return;
  }

  if (event.type === "thinking" && event.text) {
    state.markReasoningStarted();
    await params.onReasoningStream?.({ text: event.text });
    return;
  }

  if (event.type === "tool_progress") {
    const id = event.toolCallId || `${event.toolName || "tool"}:${state.toolMetas.size}`;
    const toolName = event.toolName || "hermes_tool";
    state.toolMetas.set(id, { toolName });
    params.onAgentEvent?.({
      stream: "item",
      data: {
        itemId: id,
        phase: "start",
        kind: "tool",
        title: toolName,
        status: "running",
        name: toolName,
      },
    });
    return;
  }

  if (event.type === "tool_result") {
    const id = event.toolCallId || `tool:${state.toolMetas.size}`;
    const existing = state.toolMetas.get(id);
    state.toolMetas.set(id, {
      toolName: existing?.toolName ?? "hermes_tool",
      ...(event.text ? { meta: event.text.slice(0, 200) } : {}),
    });
    params.onAgentEvent?.({
      stream: "item",
      data: {
        itemId: id,
        phase: "completed",
        kind: "tool",
        title: existing?.toolName ?? "Hermes tool",
        status: "completed",
        ...(event.text ? { meta: event.text.slice(0, 200) } : {}),
      },
    });
    await params.onToolResult?.({ text: event.text ?? "" } as never);
    return;
  }

  if (event.type === "done") {
    await state.markReasoningEnded();
  }
}

function buildUserMessage(params: AgentHarnessAttemptParams): HarnessMessage {
  return {
    role: "user",
    content: params.images?.length
      ? [
          { type: "text", text: params.prompt },
          ...params.images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
        ]
      : params.prompt,
    timestamp: Date.now(),
  } as HarnessMessage;
}

function buildAssistantMessage(
  params: AgentHarnessAttemptParams,
  text: string,
  usage: NormalizedUsage | undefined,
  options: { aborted: boolean; errorMessage: string | null },
): HarnessMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: params.model?.api ?? "hermes-acp",
    provider: params.provider,
    model: params.modelId,
    usage: usage
      ? {
          input: usage.input ?? 0,
          output: usage.output ?? 0,
          cacheRead: usage.cacheRead ?? 0,
          cacheWrite: usage.cacheWrite ?? 0,
          totalTokens: usage.total ?? (usage.input ?? 0) + (usage.output ?? 0),
          cost: ZERO_ASSISTANT_USAGE.cost,
        }
      : ZERO_ASSISTANT_USAGE,
    stopReason: options.aborted ? "aborted" : options.errorMessage ? "error" : "stop",
    ...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
    timestamp: Date.now(),
  } as HarnessMessage;
}

function normalizeAcpUsage(
  usage: { input_tokens: number; output_tokens: number; total_tokens: number } | undefined,
): NormalizedUsage | undefined {
  if (!usage) return undefined;
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    total: usage.total_tokens,
  };
}

function readTextPrompt(blocks: AcpPromptBlock[]): string {
  return blocks
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n\n");
}

async function buildWorkspaceContextPrompt(workspaceDir: string): Promise<string> {
  const files = [
    { path: "SOUL.md", title: "SOUL.md" },
    { path: "AGENTS.md", title: "AGENTS.md" },
    { path: "USER.md", title: "USER.md" },
    { path: "MEMORY.md", title: "MEMORY.md" },
  ];
  const sections: string[] = [];
  for (const file of files) {
    const text = await readWorkspaceTextFile(join(workspaceDir, file.path));
    if (!text) continue;
    sections.push(`## ${file.title}\n${text}`);
  }
  return sections.join("\n\n");
}

async function readWorkspaceTextFile(path: string): Promise<string | undefined> {
  try {
    const text = await readFile(path, "utf8");
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    return truncateForHarnessPrompt(trimmed, 24_000);
  } catch {
    return undefined;
  }
}

function truncateForHarnessPrompt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const keepHead = Math.floor(maxChars * 0.35);
  const keepTail = maxChars - keepHead;
  return [
    text.slice(0, keepHead),
    `\n\n[OpenClaw note: workspace file truncated; omitted ${text.length - maxChars} chars]\n\n`,
    text.slice(-keepTail),
  ].join("");
}

export function buildHermesHarnessContextHash(blocks: AcpPromptBlock[]): string {
  const hash = createHash("sha256");
  for (const block of blocks) {
    hash.update(JSON.stringify(block));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function resolveHermesHarnessBindingPath(sessionFile: string): string {
  return `${sessionFile}.hermes-acp.json`;
}

async function readHermesHarnessBinding(sessionFile: string): Promise<HermesHarnessBinding | undefined> {
  try {
    const parsed = JSON.parse(await readFile(resolveHermesHarnessBindingPath(sessionFile), "utf8"));
    if (parsed?.schemaVersion !== 1 || typeof parsed.sessionId !== "string") return undefined;
    return parsed as HermesHarnessBinding;
  } catch {
    return undefined;
  }
}

async function writeHermesHarnessBinding(sessionFile: string, binding: HermesHarnessBinding): Promise<void> {
  const path = resolveHermesHarnessBindingPath(sessionFile);
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(binding, null, 2)}\n`, "utf8");
  await rename(tmpPath, path);
}
