import type {
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
  NormalizedUsage,
} from "openclaw/plugin-sdk/agent-harness";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
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
import { extractTouchedSkillNames } from "./result-processor.js";
import type { AcpSessionEvent, HermesAcpSessionOptions, HermesPluginConfig } from "./types.js";

type HarnessMessage = NonNullable<AgentHarnessAttemptResult["messagesSnapshot"]>[number];
type McpLoopbackRuntime = { port: number; token: string };
type McpHttpModule = {
  i?: () => McpLoopbackRuntime | undefined;
  n?: (port?: number) => Promise<unknown>;
  r?: (port: number) => { mcpServers?: Record<string, unknown> };
};

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

const MAX_HISTORY_MESSAGES = 12;
const MAX_HISTORY_CHARS = 12000;
const MAX_ACP_PROMPT_CHARS = 48000;
const OPENCLAW_MCP_HTTP_MODULE = "/usr/lib/node_modules/openclaw/dist/mcp-http-DkuYmsG-.js";

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

function clampAcpPrompt(prompt: string): string {
  if (prompt.length <= MAX_ACP_PROMPT_CHARS) {
    return prompt;
  }
  const marker = [
    "",
    "---",
    "",
    `[Hermes ACP prompt truncated: original ${prompt.length} chars, kept start/end to stay within TCP line limits.]`,
    "",
    "---",
    "",
  ].join("\n");
  const keep = MAX_ACP_PROMPT_CHARS - marker.length;
  const headChars = Math.floor(keep * 0.65);
  const tailChars = keep - headChars;
  return `${prompt.slice(0, headChars)}${marker}${prompt.slice(-tailChars)}`;
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

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function substituteEnvPlaceholders(value: unknown, env: Record<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => env[name] ?? "");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => substituteEnvPlaceholders(entry, env));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      substituteEnvPlaceholders(entry, env),
    ]),
  );
}

function resolveFeishuSenderIdFromPrompt(prompt: string): string | undefined {
  const systemLineMatch = /^System:\s*\[[^\n]*\]\s*Feishu\[[^\]]+\]\s+(?:DM|message in group)[^\n|]*(?:\|\s*)?(ou_[A-Za-z0-9_-]+)/m.exec(
    prompt,
  );
  if (systemLineMatch?.[1]) {
    return systemLineMatch[1];
  }
  const senderLineMatch = /(?:SenderId|sender_id|Your Feishu user id):\s*(ou_[A-Za-z0-9_-]+)/i.exec(prompt);
  return senderLineMatch?.[1];
}

function addOpenClawLoopbackHeaders(
  server: unknown,
  headers: Record<string, string>,
): Record<string, unknown> | undefined {
  if (!server || typeof server !== "object" || Array.isArray(server)) {
    return undefined;
  }
  const record = server as Record<string, unknown>;
  const existingHeaders =
    record.headers && typeof record.headers === "object" && !Array.isArray(record.headers)
      ? (record.headers as Record<string, unknown>)
      : {};
  return {
    ...record,
    headers: {
      ...existingHeaders,
      ...headers,
    },
  };
}

function resolveHermesSessionHashes(config: HermesPluginConfig): {
  mcpConfigHash?: string;
  credentialScopeHash?: string;
} {
  if (!config.mcpBridge.enabled) {
    return {};
  }
  return {
    mcpConfigHash: hashJson({
      servers: config.mcpBridge.servers,
      openclawLoopback: config.mcpBridge.servers.openclaw ? "configured" : "auto",
    }),
    credentialScopeHash: hashJson(Object.keys(config.mcpBridge.env).sort()),
  };
}

async function resolveOpenClawMcpLoopback(params: {
  config: HermesPluginConfig;
  sessionKey?: string;
  agentId?: string;
  agentAccountId?: string;
  messageProvider?: string;
  messageTo?: string;
  messageThreadId?: string | number;
  currentMessageId?: string | number;
  senderId?: string;
  senderIsOwner?: boolean;
}): Promise<{ mcpServers?: Record<string, unknown>; env?: Record<string, string> }> {
  if (!params.config.mcpBridge.enabled) return {};
  if (params.config.mcpBridge.servers.openclaw) return {};

  try {
    const module = (await import(pathToFileURL(OPENCLAW_MCP_HTTP_MODULE).href)) as McpHttpModule;
    let runtime = module.i?.();
    if (!runtime) {
      await module.n?.();
      runtime = module.i?.();
    }
    if (!runtime) return {};
    const generated = module.r?.(runtime.port);
    const openclawServer = generated?.mcpServers?.openclaw;
    if (!openclawServer) return {};
    const env = {
      OPENCLAW_MCP_TOKEN: runtime.token,
      OPENCLAW_MCP_AGENT_ID: params.agentId ?? "",
      OPENCLAW_MCP_ACCOUNT_ID: params.agentAccountId ?? "",
      OPENCLAW_MCP_SESSION_KEY: params.sessionKey ?? "",
      OPENCLAW_MCP_MESSAGE_CHANNEL: params.messageProvider ?? "",
      OPENCLAW_MCP_MESSAGE_TO: params.messageTo != null ? String(params.messageTo) : "",
      OPENCLAW_MCP_THREAD_ID: params.messageThreadId != null ? String(params.messageThreadId) : "",
      OPENCLAW_MCP_CURRENT_MESSAGE_ID: params.currentMessageId != null ? String(params.currentMessageId) : "",
      OPENCLAW_MCP_SENDER_ID: params.senderId ?? "",
      OPENCLAW_MCP_SENDER_IS_OWNER: params.senderIsOwner === true ? "true" : "false",
    };
    const serverWithHeaders = addOpenClawLoopbackHeaders(openclawServer, {
      "x-openclaw-sender-id": "${OPENCLAW_MCP_SENDER_ID}",
      "x-openclaw-message-to": "${OPENCLAW_MCP_MESSAGE_TO}",
      "x-openclaw-thread-id": "${OPENCLAW_MCP_THREAD_ID}",
      "x-openclaw-current-message-id": "${OPENCLAW_MCP_CURRENT_MESSAGE_ID}",
    });
    return {
      mcpServers: serverWithHeaders ? { openclaw: substituteEnvPlaceholders(serverWithHeaders, env) } : undefined,
      env,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[hermes-acp] OpenClaw MCP loopback unavailable: ${message}`);
    return {};
  }
}

async function buildHermesSessionOptions(params: {
  config: HermesPluginConfig;
  cwd: string;
  sessionKey?: string;
  agentId?: string;
  agentAccountId?: string;
  messageProvider?: string;
  messageTo?: string;
  messageThreadId?: string | number;
  currentMessageId?: string | number;
  senderId?: string;
  senderIsOwner?: boolean;
}): Promise<HermesAcpSessionOptions> {
  const loopback = await resolveOpenClawMcpLoopback(params);
  const configuredServers = params.config.mcpBridge.enabled ? params.config.mcpBridge.servers : undefined;
  const configuredEnv = params.config.mcpBridge.enabled ? params.config.mcpBridge.env : undefined;
  const mcpServers = {
    ...(configuredServers ?? {}),
    ...(loopback.mcpServers ?? {}),
  };
  const env = {
    ...(configuredEnv ?? {}),
    ...(loopback.env ?? {}),
  };
  return {
    cwd: params.cwd,
    ...(mcpServers && Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    ...(env && Object.keys(env).length > 0 ? { env } : {}),
  };
}

function flattenMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    if (type === "text" && typeof record.text === "string" && record.text.trim()) {
      parts.push(record.text.trim());
      continue;
    }
    if (type === "thinking") continue;
    if (type === "toolCall" && typeof record.name === "string") {
      parts.push(`[tool call: ${record.name}]`);
    }
  }
  return parts.join("\n").trim();
}

async function loadConversationHistory(
  params: AgentHarnessAttemptParams,
): Promise<{ promptText?: string; messages: HarnessMessage[] }> {
  const sessionFile = typeof params.sessionFile === "string" ? params.sessionFile.trim() : "";
  if (!sessionFile) {
    return { messages: [] };
  }

  try {
    const raw = await readFile(sessionFile, "utf8");
    const parsedMessages: HarnessMessage[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (entry.type !== "message") continue;
      const message = (entry.message ?? {}) as Record<string, unknown>;
      const role = typeof message.role === "string" ? message.role : "";
      if (role !== "user" && role !== "assistant") continue;
      const text = flattenMessageContent(message.content);
      if (!text) continue;
      parsedMessages.push({
        role,
        content: text,
        timestamp:
          typeof message.timestamp === "number"
            ? message.timestamp
            : typeof entry.timestamp === "number"
              ? entry.timestamp
              : Date.now(),
      } as HarnessMessage);
    }

    const currentPrompt = sanitizePromptForHermes(params.prompt);
    const history = parsedMessages
      .filter((msg) => !(msg.role === "user" && msg.content === currentPrompt))
      .slice(-MAX_HISTORY_MESSAGES);

    if (history.length === 0) {
      return { messages: [] };
    }

    const blocks = history.map((msg) => `## ${msg.role === "user" ? "User" : "Assistant"}\n${msg.content}`);
    let promptText = blocks.join("\n\n");
    if (promptText.length > MAX_HISTORY_CHARS) {
      promptText = promptText.slice(-MAX_HISTORY_CHARS);
    }
    return {
      promptText,
      messages: history,
    };
  } catch {
    return { messages: [] };
  }
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
  const conversationHistory = await loadConversationHistory(params);
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
  const sessionHashes = resolveHermesSessionHashes(config);

  const execution = await prepareProjectedExecutionEnv({
    task: sanitizedPrompt,
    taskId: sessionAnchor,
    workspaceDir: params.workspaceDir,
    contextLevel,
    includeWorkspaceSkills: config.runtimeProjectWorkspaceSkills,
    model: params.modelId,
    config,
    sessionAnchor,
    conversationHistory: conversationHistory.promptText,
    openClawContext: {
      agentId: params.agentId,
      skillsSnapshot: params.skillsSnapshot,
      extraSystemPrompt: params.extraSystemPrompt,
    },
    mcpConfigHash: sessionHashes.mcpConfigHash,
    credentialScopeHash: sessionHashes.credentialScopeHash,
  });
  const sessionOptions = await buildHermesSessionOptions({
    config,
    cwd: execution.execEnv.runtimeExecEnvPath,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    agentAccountId: (params as { agentAccountId?: string }).agentAccountId,
    messageProvider: (params as { messageProvider?: string }).messageProvider,
    messageTo: (params as { messageTo?: string }).messageTo,
    messageThreadId: (params as { messageThreadId?: string | number }).messageThreadId,
    currentMessageId: (params as { currentMessageId?: string | number }).currentMessageId,
    senderId:
      (params as { senderId?: string }).senderId ??
      resolveFeishuSenderIdFromPrompt(sanitizedPrompt) ??
      resolveFeishuSenderIdFromPrompt(params.prompt),
    senderIsOwner: (params as { senderIsOwner?: boolean }).senderIsOwner,
  });

  try {
    // Mirror prompt-referenced host paths before ACP starts so Hermes file
    // writes can later be pulled back to the OpenClaw host.
    await mirrorWorkspaceToContainer(config, params.workspaceDir, referencedWorkspacePaths);
    await client.start();
    webui.lifecycleStart({ startedAt: Date.now() });
    publishHermesHarnessAgentEvent(params, {
      stream: "lifecycle",
      data: { phase: "start", startedAt: Date.now() },
    });
    const sessionId = await resumeOrCreateSession({
      client,
      sessionOptions,
      bindingHash: execution.sessionBindingHash,
    });

    const acpPrompt = clampAcpPrompt(execution.bootstrapPrompt);
    if (acpPrompt.length !== execution.bootstrapPrompt.length) {
      console.warn(
        `[hermes-acp] bootstrap prompt clamped from ${execution.bootstrapPrompt.length} to ${acpPrompt.length} chars`,
      );
    }

    const result = await client.prompt(acpPrompt, sessionId, {
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
    const touchedSkillNames = extractTouchedSkillNames(result.events);
    // Pull back only prompt-referenced directories. This preserves observable
    // side effects without tarring large workspace caches.
    await mirrorWorkspaceFromContainer(
      config,
      params.workspaceDir,
      referencedWorkspacePaths,
      execution.execEnv.runtimeExecEnvPath,
      touchedSkillNames,
    );
    const assistantText = result.text;
    const lastAssistant = buildAssistantMessage(params, assistantText, usage, {
      aborted: false,
      errorMessage: null,
    });
    const messagesSnapshot = [
      ...conversationHistory.messages,
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
      messagesSnapshot: [...conversationHistory.messages, buildUserMessage(params), lastAssistant] as AgentHarnessAttemptResult["messagesSnapshot"],
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
  sessionOptions: HermesAcpSessionOptions;
  bindingHash: string;
}): Promise<string> {
  // The binding hash encodes whether the projected context and workdir remain
  // semantically equivalent. Equivalent bindings can safely resume; otherwise
  // create a fresh ACP session to avoid stale context bleed-through.
  const existing = readSessionBinding(params.bindingHash);
  if (existing && existing.runtimeExecEnvPath === params.sessionOptions.cwd) {
    try {
      const loaded = await params.client.loadSession(existing.sessionId, params.sessionOptions);
      writeSessionBinding(params.bindingHash, {
        sessionId: loaded,
        runtimeExecEnvPath: params.sessionOptions.cwd,
        bindingHash: params.bindingHash,
      });
      return loaded;
    } catch {
      clearSessionBinding(params.bindingHash);
    }
  }

  const created = await params.client.newSession(params.sessionOptions);
  writeSessionBinding(params.bindingHash, {
    sessionId: created,
    runtimeExecEnvPath: params.sessionOptions.cwd,
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
