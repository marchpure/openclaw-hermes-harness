import type {
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
  NormalizedUsage,
} from "openclaw/plugin-sdk/agent-harness";
import { publishHermesHarnessAgentEvent } from "./agent-event-bridge.js";
import { HermesAcpClient } from "./acp-client.js";
import {
  mirrorWorkspaceFromContainer,
  mirrorWorkspaceToContainer,
} from "./execenv-builder.js";
import { createWebUiEventBridge } from "./webui-event-bridge.js";
import {
  clearSessionBinding,
  prepareProjectedExecutionEnv,
  readSessionBinding,
  resolveStableSessionAnchor,
  writeSessionBinding,
} from "./runtime-client.js";
import type { AcpSessionEvent, HermesPluginConfig } from "./types.js";

type HarnessMessage = NonNullable<AgentHarnessAttemptResult["messagesSnapshot"]>[number];

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

const ZERO_ASSISTANT_USAGE = {
  input: 0,
  output: 0,
  total: 0,
};

const CONTEXT_LEVEL_ORDER = {
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
} as const;

/**
 * Resolve the minimum context level that the Hermes harness must project.
 *
 * Provider routing can send `/model hermes` traffic into this harness even when
 * the configured default context level is low. The runtime floor prevents
 * Hermes from missing USER.md, AGENTS.md, and workspace skills in WebUI flows.
 */
function resolveRuntimeContextLevel(config: HermesPluginConfig): HermesPluginConfig["defaultContextLevel"] {
  return CONTEXT_LEVEL_ORDER[config.defaultContextLevel] >= CONTEXT_LEVEL_ORDER[config.runtimeMinContextLevel]
    ? config.defaultContextLevel
    : config.runtimeMinContextLevel;
}

/**
 * Remove OpenClaw transport metadata that is useful to the gateway but harmful
 * to Hermes task understanding.
 */
function sanitizePromptForHermes(prompt: string): string {
  let sanitized = prompt;

  // WebUI sender metadata is transport noise, not stable workspace context.
  sanitized = sanitized.replace(
    /^Sender \(untrusted metadata\):\s*```json\s*[\s\S]*?```\s*/i,
    "",
  );

  // Bootstrap truncation hints are useful to OpenClaw, but they cause Hermes
  // to overfit on UI/runtime diagnostics instead of the user task.
  sanitized = sanitized.replace(
    /\n*\[Bootstrap truncation warning\][\s\S]*$/i,
    "",
  );

  return sanitized.trim();
}

/**
 * Find host workspace paths explicitly mentioned in the prompt.
 *
 * Only these path parents are mirrored to and from the Hermes container. This
 * keeps file side effects observable without copying the entire workspace.
 */
function extractWorkspacePaths(prompt: string, workspaceDir: string): string[] {
  const matches = prompt.match(new RegExp(`${workspaceDir.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}[^\\s'"]*`, "g")) ?? [];
  return [...new Set(matches)];
}

/**
 * Create the OpenClaw harness-facing runtime client.
 */
export function createHermesRuntimeClient(options: {
  config: HermesPluginConfig;
}): HermesRuntimeClient {
  return {
    runAttempt: (params) => runHermesHarnessAttempt(options.config, params),
  };
}

/**
 * Clear persisted Hermes session binding for OpenClaw harness reset.
 */
export async function clearHermesHarnessBinding(sessionFile: string): Promise<void> {
  await clearSessionBinding(sessionFile);
}

/**
 * Execute one OpenClaw agent attempt through the Hermes ACP runtime.
 *
 * This function owns the end-to-end bridge:
 * prompt cleanup, projected execenv preparation, selective workspace mirroring,
 * ACP session reuse, streaming event fan-out, and final harness result assembly.
 */
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
  const toolMetas = new Map<string, { toolName: string; meta?: string }>();
  const webui = createWebUiEventBridge(params);
  let assistantTextSoFar = "";
  let assistantStarted = false;
  let reasoningStarted = false;
  let reasoningEnded = false;
  let lifecycleEnded = false;
  const sanitizedPrompt = sanitizePromptForHermes(params.prompt);
  const referencedWorkspacePaths = extractWorkspacePaths(sanitizedPrompt, params.workspaceDir);
  const contextLevel = resolveRuntimeContextLevel(config);
  // The session anchor names the stable Hermes workdir. Prefer OpenClaw's
  // explicit session id so broad session keys do not merge unrelated turns.
  const sessionAnchor = resolveStableSessionAnchor({
    workspaceDir: params.workspaceDir,
    sessionKey: params.sessionKey,
    sessionFile: params.sessionFile,
    sessionId: params.sessionId,
    agentId: params.agentId,
  });
  console.log(
    `[hermes-acp] anchor sessionKey=${params.sessionKey ?? ""} sessionId=${params.sessionId ?? ""} sessionFile=${params.sessionFile ?? ""} agentId=${params.agentId ?? ""} -> ${sessionAnchor}`,
  );

  const execution = await prepareProjectedExecutionEnv({
    task: sanitizedPrompt,
    taskId: sessionAnchor,
    workspaceDir: params.workspaceDir,
    contextLevel,
    includeWorkspaceSkills: config.runtimeProjectWorkspaceSkills,
    model: params.modelId,
    config,
    sessionAnchor,
  });

  try {
    // Mirror prompt-referenced host paths before ACP starts so Hermes file
    // writes can later be pulled back to the OpenClaw host.
    await mirrorWorkspaceToContainer(config, params.workspaceDir, referencedWorkspacePaths);
    await client.start({}, execution.execEnv.runtimeExecEnvPath);
    webui.lifecycleStart({ startedAt: Date.now() });
    publishHermesHarnessAgentEvent(params, {
      stream: "lifecycle",
      data: { phase: "start", startedAt: Date.now() },
    });
    const sessionId = await resumeOrCreateSession({
      client,
      runtimeExecEnvPath: execution.execEnv.runtimeExecEnvPath,
      bindingHash: execution.sessionBindingHash,
      modelId: params.modelId,
    });

    const result = await client.prompt(execution.bootstrapPrompt, sessionId, {
      timeout: timeoutMs,
      signal: params.abortSignal,
      onEvent: async (event) => {
        // Normalize every ACP streaming event into harness callbacks, WebUI
        // gateway events, and local assistant/tool metadata.
        await handleHarnessEvent(event, params, {
          markAssistantStarted: async () => {
            if (assistantStarted) return;
            assistantStarted = true;
            void params.onAssistantMessageStart?.();
          },
          markReasoningStarted: async () => {
            if (reasoningStarted) return;
            reasoningStarted = true;
            void params.onReasoningStart?.();
          },
          markReasoningEnded: async () => {
            if (!reasoningStarted || reasoningEnded) return;
            reasoningEnded = true;
            void params.onReasoningEnd?.();
          },
          toolMetas,
          webui,
          appendAssistantText: (delta) => {
            assistantTextSoFar += delta;
            return assistantTextSoFar;
          },
        });
      },
    });

    if (reasoningStarted && !reasoningEnded) {
      reasoningEnded = true;
      void params.onReasoningEnd?.();
      webui.thinkingEnd();
    }

    const usage = normalizeAcpUsage(result.usage);
    // Pull back only prompt-referenced directories. This preserves observable
    // side effects without tarring large workspace caches.
    await mirrorWorkspaceFromContainer(
      config,
      params.workspaceDir,
      referencedWorkspacePaths,
      execution.execEnv.runtimeExecEnvPath,
    );
    const assistantText = result.text;
    const lastAssistant = buildAssistantMessage(params, assistantText, usage, {
      aborted: false,
      errorMessage: null,
    });
    const messagesSnapshot = [
      buildUserMessage(params),
      ...(lastAssistant ? [lastAssistant] : []),
    ] as AgentHarnessAttemptResult["messagesSnapshot"];

    return {
      assistantText,
      assistantTexts: assistantText ? [assistantText] : [],
      sessionId,
      ...(usage ? { usage } : {}),
      hadPotentialSideEffects: toolMetas.size > 0,
      replaySafe: toolMetas.size === 0,
      aborted: false,
      externalAbort: false,
      timedOut: false,
      promptError: null,
      promptErrorSource: null,
      finalPromptText: sanitizedPrompt,
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
    webui.lifecycleError(err instanceof Error ? err.message : String(err));
    publishHermesHarnessAgentEvent(params, {
      stream: "lifecycle",
      data: {
        phase: "error",
        error: err instanceof Error ? err.message : String(err),
        endedAt: Date.now(),
      },
    });
    clearSessionBinding(execution.sessionBindingHash);
    const lastAssistant = buildAssistantMessage(params, "", undefined, {
      aborted: Boolean(params.abortSignal?.aborted),
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return {
      assistantText: "",
      assistantTexts: [],
      sessionId: params.sessionId,
      aborted: Boolean(params.abortSignal?.aborted),
      externalAbort: Boolean(params.abortSignal?.aborted),
      timedOut: false,
      promptError: err,
      promptErrorSource: "prompt",
      finalPromptText: sanitizedPrompt,
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
    if (reasoningStarted && !reasoningEnded) {
      webui.thinkingEnd();
    }
    if (!lifecycleEnded) {
      lifecycleEnded = true;
      webui.lifecycleEnd({ endedAt: Date.now() });
      publishHermesHarnessAgentEvent(params, {
        stream: "lifecycle",
        data: { phase: "end", endedAt: Date.now() },
      });
    }
    await client.close().catch(() => {});
  }
}

/**
 * Resume the ACP session bound to this projected execenv, or create a new one.
 */
async function resumeOrCreateSession(params: {
  client: HermesAcpClient;
  runtimeExecEnvPath: string;
  bindingHash: string;
  modelId?: string;
}): Promise<string> {
  // The binding hash encodes whether the projected context and workdir remain
  // semantically equivalent. Equivalent bindings can safely resume; otherwise
  // create a fresh ACP session to avoid stale context bleed-through.
  const existing = readSessionBinding(params.bindingHash);
  if (existing && existing.runtimeExecEnvPath === params.runtimeExecEnvPath) {
    try {
      const loaded = await params.client.loadSession(existing.sessionId, params.runtimeExecEnvPath, params.modelId);
      writeSessionBinding(params.bindingHash, {
        sessionId: loaded,
        runtimeExecEnvPath: params.runtimeExecEnvPath,
        bindingHash: params.bindingHash,
      });
      return loaded;
    } catch {
      clearSessionBinding(params.bindingHash);
    }
  }

  const created = await params.client.newSession(params.runtimeExecEnvPath, params.modelId);
  writeSessionBinding(params.bindingHash, {
    sessionId: created,
    runtimeExecEnvPath: params.runtimeExecEnvPath,
    bindingHash: params.bindingHash,
  });
  return created;
}

/**
 * Translate Hermes ACP stream events into OpenClaw harness and WebUI surfaces.
 */
async function handleHarnessEvent(
  event: AcpSessionEvent,
  params: AgentHarnessAttemptParams,
  state: {
    markAssistantStarted: () => Promise<void>;
    markReasoningStarted: () => Promise<void>;
    markReasoningEnded: () => Promise<void>;
    toolMetas: Map<string, { toolName: string; meta?: string }>;
    webui: ReturnType<typeof createWebUiEventBridge>;
    appendAssistantText: (delta: string) => string;
  },
): Promise<void> {
  if (event.type === "text" && event.text) {
    // Assistant text is the primary chat stream: update both WebUI chat state
    // and OpenClaw's partial-reply callback.
    await state.markAssistantStarted();
    const text = state.appendAssistantText(event.text);
    state.webui.assistantDelta(event.text);
    publishHermesHarnessAgentEvent(params, {
      stream: "assistant",
      data: { text, delta: event.text },
    });
    void params.onPartialReply?.({ text: event.text });
    return;
  }

  if (event.type === "thinking" && event.text) {
    // Reasoning is exposed as agent events and harness reasoning callbacks, but
    // intentionally not appended to the final assistant chat message.
    await state.markReasoningStarted();
    state.webui.thinkingStart();
    publishHermesHarnessAgentEvent(params, {
      stream: "thinking",
      data: { text: event.text, delta: event.text },
    });
    state.webui.thinkingDelta(event.text);
    void params.onReasoningStream?.({ text: event.text });
    return;
  }

  if (event.type === "tool_progress") {
    // Tool events become replay metadata and are also used to mark attempts as
    // potentially side-effecting.
    const id = event.toolCallId || `${event.toolName || "tool"}:${state.toolMetas.size}`;
    const toolName = event.toolName || "hermes_tool";
    state.toolMetas.set(id, { toolName });
    state.webui.toolStart(toolName, id);
    publishHermesHarnessAgentEvent(params, {
      stream: "tool",
      data: { phase: "start", name: toolName, toolCallId: id },
    });
    return;
  }

  if (event.type === "tool_result") {
    const id = event.toolCallId || `tool:${state.toolMetas.size}`;
    const toolName = event.toolName || state.toolMetas.get(id)?.toolName || "hermes_tool";
    const outputText = (event.text ?? "").trim();
    state.toolMetas.set(id, {
      toolName,
      ...(outputText ? { meta: outputText.slice(0, 200) } : {}),
    });
    state.webui.toolResult(toolName, id, outputText || undefined, false);
    publishHermesHarnessAgentEvent(params, {
      stream: "tool",
      data: {
        phase: "result",
        name: toolName,
        toolCallId: id,
        ...(outputText
          ? {
              result: {
                content: [{ type: "text", text: outputText }],
              },
              summary: outputText,
            }
          : {}),
      },
    });
    return;
  }

  if (event.type === "done") {
    // `done` only closes reasoning. Final assistant text is assembled from the
    // prompt result so ACP implementations with both deltas and final payloads
    // stay compatible.
    state.webui.thinkingEnd();
    await state.markReasoningEnded();
  }
}

/**
 * Build the user message snapshot stored in OpenClaw attempt results.
 */
function buildUserMessage(params: AgentHarnessAttemptParams): HarnessMessage {
  return {
    role: "user",
    content: sanitizePromptForHermes(params.prompt),
    timestamp: Date.now(),
  } as HarnessMessage;
}

/**
 * Build the assistant message snapshot stored in OpenClaw attempt results.
 */
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
    usage: usage ?? ZERO_ASSISTANT_USAGE,
    stopReason: options.aborted ? "aborted" : options.errorMessage ? "error" : "stop",
    ...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
    timestamp: Date.now(),
  } as HarnessMessage;
}

/**
 * Convert ACP token usage into OpenClaw's normalized usage shape.
 */
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
