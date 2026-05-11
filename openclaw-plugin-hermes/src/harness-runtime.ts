import type {
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
  NormalizedUsage,
} from "openclaw/plugin-sdk/agent-harness";
import { SpanStatusCode } from "@opentelemetry/api";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { appendFile, mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { publishHermesHarnessAgentEvent } from "./agent-event-bridge.js";
import { HermesAcpClient } from "./acp-client.js";
import { mergeHermesSessionEnv } from "./session-env.js";
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
import {
  traceWithSpan,
  traceStep,
  recordEventSpans,
} from "./observability/index.js";
import {
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_TOTAL_TOKENS,
  GEN_AI_SPAN_KIND,
  GenAiSpanKind,
} from "./observability/genaiConst.js";

type HarnessMessage = NonNullable<AgentHarnessAttemptResult["messagesSnapshot"]>[number];
type AgentHarnessMcpBridge = {
  mcpServers?: Record<string, unknown>;
  env?: Record<string, string>;
  mcpConfigHash?: string;
  mcpResumeHash?: string;
  credentialScopeHash?: string;
};
type AgentHarnessRuntimeModule = {
  prepareAgentHarnessMcpBridge?: (params: Record<string, unknown>) => Promise<AgentHarnessMcpBridge>;
  appendSessionTranscriptMessage?: (params: {
    transcriptPath: string;
    message: AgentMessageForTranscript;
    config?: unknown;
  }) => Promise<unknown>;
  emitSessionTranscriptUpdate?: (update: string | { sessionFile: string; sessionKey?: string }) => void;
  acquireSessionWriteLock?: (params: {
    sessionFile: string;
    timeoutMs?: number;
    allowReentrant?: boolean;
  }) => Promise<{ release: () => Promise<void> | void }>;
  resolveSessionWriteLockAcquireTimeoutMs?: (config?: unknown) => number;
  runAgentHarnessBeforeMessageWriteHook?: (params: {
    message: AgentMessageForTranscript;
    agentId?: string;
    sessionKey?: string;
  }) => AgentMessageForTranscript | null;
};
type OpenClawTranscriptAppendResult =
  | { ok: true; sessionFile: string; messageId: string }
  | { ok: false; reason: string };
type OpenClawTranscriptRuntimeModule = {
  appendExactAssistantMessageToSessionTranscript?: (params: {
    agentId?: string;
    sessionKey: string;
    message: AgentMessageForTranscript & { role: "assistant" };
    idempotencyKey?: string;
    updateMode?: "inline" | "file-only" | "none";
  }) => Promise<OpenClawTranscriptAppendResult>;
};
type OpenClawTranscriptEventsModule = {
  emitSessionTranscriptUpdate?: (update: string | { sessionFile: string; sessionKey?: string }) => void;
  t?: (update: string | { sessionFile: string; sessionKey?: string }) => void;
};
type OpenClawSessionStoreEntry = {
  sessionId?: string;
  sessionFile?: string;
};
type McpLoopbackRuntime = {
  port: number;
  token?: string;
  ownerToken?: string;
  nonOwnerToken?: string;
};
type McpHttpModule = {
  ensureMcpLoopbackServer?: () => Promise<{ port: number; close?: () => Promise<void> }>;
  getActiveMcpLoopbackRuntime?: () => McpLoopbackRuntime | undefined;
  resolveMcpLoopbackBearerToken?: (runtime: McpLoopbackRuntime, senderIsOwner: boolean) => string;
  createMcpLoopbackServerConfig?: (port: number) => {
    mcpServers?: Record<string, unknown>;
  };
  n?: () => Promise<{ port: number; close?: () => Promise<void> }>;
  i?: () => McpLoopbackRuntime | undefined;
  r?: (port: number) => {
    mcpServers?: Record<string, unknown>;
  };
};

type AgentMessageForTranscript = Record<string, unknown>;

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

function extractDisplayPromptForOpenClawTranscript(prompt: string): string {
  const sanitized = sanitizePromptForHermes(prompt);
  const marker = "仅本次任务派发给 Hermes 执行：";
  const markerIndex = sanitized.lastIndexOf(marker);
  if (markerIndex >= 0) {
    const extracted = sanitized.slice(markerIndex + marker.length).trim();
    if (extracted) {
      return extracted;
    }
  }
  return sanitized;
}

function normalizeUserTranscriptContent(content: unknown): Array<{ type: "text"; text: string }> | unknown {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return content;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find host workspace paths explicitly mentioned in the prompt.
 *
 * Only these path parents are mirrored to and from the Hermes container. This
 * keeps file side effects observable without copying the entire workspace.
 */
function extractWorkspacePaths(prompt: string, workspaceDir: string): string[] {
  const normalizedWorkspace = workspaceDir.replace(/\/+$/, "");
  if (!normalizedWorkspace) return [];
  const pathTerminator = "\\s'\"`<>，。；：、！？（）【】《》";
  const pathPattern = new RegExp(`${escapeRegExp(normalizedWorkspace)}(?:/[^${pathTerminator}]*)?(?=$|[${pathTerminator}])`, "g");
  const matches = prompt.match(pathPattern) ?? [];
  return [
    ...new Set(
      matches.filter((value) => value === normalizedWorkspace || value.startsWith(`${normalizedWorkspace}/`)),
    ),
  ];
}

export const __testing = {
  extractWorkspacePaths,
};

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

async function prepareHermesMcpBridge(params: {
  config: HermesPluginConfig;
  openClawConfig?: unknown;
  workspaceDir?: string;
  sessionKey?: string;
  agentId?: string;
  agentAccountId?: string;
  messageChannel?: string;
  messageProvider?: string;
  messageTo?: string;
  messageThreadId?: string | number;
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  senderId?: string;
  senderIsOwner?: boolean;
}): Promise<AgentHarnessMcpBridge> {
  if (!params.config.mcpBridge.enabled) return {};

  try {
    const module = await loadAgentHarnessRuntimeModule();
    const prepare = module.prepareAgentHarnessMcpBridge;
    if (!prepare) {
      console.warn("[hermes-acp] OpenClaw MCP bridge helper unavailable");
      return {
        mcpServers: params.config.mcpBridge.servers,
        env: params.config.mcpBridge.env,
      };
    }
    return await prepare({
      runtime: "container",
      enabled: true,
      config: params.openClawConfig,
      workspaceDir: params.workspaceDir,
      configuredServers: params.config.mcpBridge.servers,
      configuredEnv: params.config.mcpBridge.env,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      accountId: params.agentAccountId,
      messageChannel: params.messageChannel,
      messageProvider: params.messageProvider,
      messageTo: params.messageTo,
      messageThreadId: params.messageThreadId,
      currentChannelId: params.currentChannelId,
      currentThreadTs: params.currentThreadTs,
      currentMessageId: params.currentMessageId,
      requesterSenderId: params.senderId,
      senderIsOwner: params.senderIsOwner,
    }).then((bridge) =>
      normalizeContainerReachableMcpBridge({
        bridge,
        params,
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[hermes-acp] OpenClaw MCP bridge unavailable: ${message}`);
    return {
      mcpServers: params.config.mcpBridge.servers,
      env: params.config.mcpBridge.env,
    };
  }
}

async function normalizeContainerReachableMcpBridge(args: {
  bridge: AgentHarnessMcpBridge;
  params: Parameters<typeof prepareHermesMcpBridge>[0];
}): Promise<AgentHarnessMcpBridge> {
  const bridge = args.bridge;
  const servers = bridge.mcpServers ?? {};
  const pluginTools = servers["openclaw-plugin-tools"];
  if (!isHostOpenClawPluginToolsServer(pluginTools)) {
    return bridge;
  }

  const loopback = await resolveMcpLoopbackBridge(args.params.senderIsOwner);
  if (!loopback) {
    console.warn("[hermes-acp] OpenClaw MCP loopback unavailable; disabling unreachable stdio plugin tools bridge");
    return {
      ...bridge,
      mcpServers: omitUnreachablePluginToolsServer(servers),
    };
  }

  const openclawServer = loopback.mcpServers?.openclaw;
  if (!openclawServer) {
    return bridge;
  }

  const env = {
    ...(bridge.env ?? {}),
    OPENCLAW_MCP_TOKEN: loopback.token,
    OPENCLAW_MCP_SESSION_KEY: args.params.sessionKey ?? "main",
    ...(args.params.agentId ? { OPENCLAW_MCP_AGENT_ID: args.params.agentId } : {}),
    ...(args.params.agentAccountId ? { OPENCLAW_MCP_ACCOUNT_ID: args.params.agentAccountId } : {}),
    ...(args.params.messageChannel || args.params.messageProvider
      ? { OPENCLAW_MCP_MESSAGE_CHANNEL: args.params.messageChannel ?? args.params.messageProvider ?? "" }
      : {}),
    ...(typeof args.params.senderIsOwner === "boolean"
      ? { OPENCLAW_MCP_SENDER_IS_OWNER: String(args.params.senderIsOwner) }
      : {}),
  };

  return {
    ...bridge,
    mcpServers: {
      ...omitUnreachablePluginToolsServer(servers),
      openclaw: materializeMcpServerEnvPlaceholders(withOpenClawMcpMeta(openclawServer), env),
    },
    env,
  };
}

function omitUnreachablePluginToolsServer(servers: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(servers).filter(([name]) => name !== "openclaw-plugin-tools"),
  );
}

function isHostOpenClawPluginToolsServer(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const server = value as Record<string, unknown>;
  return (
    server.command === process.execPath &&
    Array.isArray(server.args) &&
    server.args.some(
      (arg) =>
        typeof arg === "string" &&
        arg.endsWith("/dist/mcp/plugin-tools-serve.js") &&
        arg.includes("/node_modules/openclaw/"),
    )
  );
}

function withOpenClawMcpMeta(server: unknown): unknown {
  if (!server || typeof server !== "object" || Array.isArray(server)) return server;
  return {
    ...(server as Record<string, unknown>),
    _meta: {
      ...(((server as Record<string, unknown>)._meta as Record<string, unknown> | undefined) ?? {}),
      openclaw: {
        timeout: 600,
        connectTimeout: 60,
      },
    },
  };
}

function materializeMcpServerEnvPlaceholders(server: unknown, env: Record<string, string>): unknown {
  if (!server || typeof server !== "object" || Array.isArray(server)) return server;
  const record = server as Record<string, unknown>;
  return {
    ...record,
    ...(record.headers && typeof record.headers === "object" && !Array.isArray(record.headers)
      ? { headers: materializeStringRecord(record.headers as Record<string, unknown>, env) }
      : {}),
    ...(record.env && typeof record.env === "object" && !Array.isArray(record.env)
      ? { env: materializeStringRecord(record.env as Record<string, unknown>, env) }
      : {}),
  };
}

function materializeStringRecord(record: Record<string, unknown>, env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).flatMap(([key, value]) => {
      if (typeof value !== "string") return [];
      return [[key, value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => env[name] ?? "")]];
    }),
  );
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveMcpLoopbackBearerToken(args: {
  module: McpHttpModule;
  runtime: McpLoopbackRuntime;
  senderIsOwner?: boolean;
}): string | undefined {
  const legacyToken = readNonEmptyString(args.runtime.token);
  if (legacyToken) return legacyToken;

  const senderIsOwner = args.senderIsOwner === true;
  const exportedResolver = args.module.resolveMcpLoopbackBearerToken;
  if (typeof exportedResolver === "function") {
    try {
      const resolved = readNonEmptyString(exportedResolver(args.runtime, senderIsOwner));
      if (resolved) return resolved;
    } catch {}
  }

  const ownerToken = readNonEmptyString(args.runtime.ownerToken);
  const nonOwnerToken = readNonEmptyString(args.runtime.nonOwnerToken);
  if (senderIsOwner && ownerToken) return ownerToken;
  return nonOwnerToken;
}

async function resolveMcpLoopbackBridge(senderIsOwner?: boolean): Promise<
  { runtime: McpLoopbackRuntime; token: string; mcpServers?: Record<string, unknown> } | undefined
> {
  const module = await loadMcpHttpModule();
  const ensureMcpLoopbackServer = module.ensureMcpLoopbackServer ?? module.n;
  const getActiveMcpLoopbackRuntime = module.getActiveMcpLoopbackRuntime ?? module.i;
  const createMcpLoopbackServerConfig = module.createMcpLoopbackServerConfig ?? module.r;
  await ensureMcpLoopbackServer?.();
  const runtime = getActiveMcpLoopbackRuntime?.();
  if (!runtime) return undefined;
  const token = resolveMcpLoopbackBearerToken({ module, runtime, senderIsOwner });
  if (!token) {
    console.warn("[hermes-acp] OpenClaw MCP loopback runtime did not expose a usable bearer token");
    return undefined;
  }
  const config = createMcpLoopbackServerConfig?.(runtime.port);
  return { runtime, token, mcpServers: config?.mcpServers };
}

async function loadMcpHttpModule(): Promise<McpHttpModule> {
  const require = createRequire(import.meta.url);
  const candidates: string[] = [];
  try {
    candidates.push(require.resolve("openclaw/plugin-sdk/gateway/mcp-http"));
  } catch {}
  for (const root of await resolveOpenClawDistDirs(require)) {
    try {
      const entries = await readdir(root);
      for (const entry of entries) {
        if (entry.startsWith("mcp-http-") && entry.endsWith(".js")) {
          candidates.push(join(root, entry));
        }
      }
    } catch {}
  }

  for (const candidate of candidates) {
    try {
      return (await import(pathToFileURL(candidate).href)) as McpHttpModule;
    } catch {}
  }
  throw new Error("OpenClaw MCP loopback SDK entry not found");
}

async function resolveOpenClawDistDirs(require: NodeRequire): Promise<string[]> {
  const dirs: string[] = [];
  try {
    const sdkEntry = require.resolve("openclaw/plugin-sdk/agent-harness");
    dirs.push(dirname(dirname(sdkEntry)));
  } catch {}
  dirs.push(...(await resolveOpenClawDistDirsFromCli()));
  dirs.push("/usr/lib/node_modules/openclaw/dist");
  dirs.push("/usr/local/lib/node_modules/openclaw/dist");
  return [...new Set(dirs)];
}

async function resolveOpenClawDistDirsFromCli(): Promise<string[]> {
  const openclawBin = (await execFileText("sh", ["-lc", "command -v openclaw || true"]))
    .trim()
    .split(/\r?\n/)[0];
  if (!openclawBin) return [];

  const resolvedBin = await safeRealpath(openclawBin);
  if (!resolvedBin) return [];

  const candidates = [
    join(dirname(resolvedBin), "..", "lib", "node_modules", "openclaw", "dist"),
    join(dirname(resolvedBin), "..", "node_modules", "openclaw", "dist"),
    join(dirname(dirname(resolvedBin)), "lib", "node_modules", "openclaw", "dist"),
  ];
  const result: string[] = [];
  for (const candidate of candidates) {
    const resolved = await safeRealpath(candidate);
    if (resolved) result.push(resolved);
  }
  return result;
}

async function safeRealpath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

async function execFileText(file: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolve) => {
    execFile(file, args, (error, stdout) => {
      resolve(error ? "" : stdout.toString());
    });
  });
}

async function loadAgentHarnessRuntimeModule(): Promise<AgentHarnessRuntimeModule> {
  const require = createRequire(import.meta.url);
  const candidates: string[] = [];
  try {
    candidates.push(require.resolve("openclaw/plugin-sdk/agent-harness-runtime"));
  } catch {}
  try {
    const sdkEntry = require.resolve("openclaw/plugin-sdk/agent-harness");
    const pkgRoot = dirname(dirname(sdkEntry));
    candidates.push(join(pkgRoot, "plugin-sdk", "agent-harness-runtime.js"));
  } catch {}
  for (const root of await resolveOpenClawDistDirs(require)) {
    candidates.push(join(root, "plugin-sdk", "agent-harness-runtime.js"));
  }
  candidates.push("/usr/lib/node_modules/openclaw/dist/plugin-sdk/agent-harness-runtime.js");
  candidates.push("/usr/local/lib/node_modules/openclaw/dist/plugin-sdk/agent-harness-runtime.js");

  for (const candidate of candidates) {
    try {
      return (await import(pathToFileURL(candidate).href)) as AgentHarnessRuntimeModule;
    } catch {
      // Try the next real installed OpenClaw location.
    }
  }
  throw new Error("OpenClaw agent-harness-runtime SDK entry not found");
}

async function loadOpenClawTranscriptRuntimeModule(): Promise<OpenClawTranscriptRuntimeModule> {
  const require = createRequire(import.meta.url);
  const candidates: string[] = [];
  try {
    candidates.push(require.resolve("openclaw/plugin-sdk/src/config/sessions/transcript.runtime"));
  } catch {}
  for (const root of await resolveOpenClawDistDirs(require)) {
    candidates.push(join(root, "transcript.runtime.js"));
    try {
      const entries = await readdir(root);
      for (const entry of entries) {
        if (/^transcript\.runtime-[\w-]+\.js$/.test(entry)) {
          candidates.push(join(root, entry));
        }
      }
    } catch {}
  }

  for (const candidate of [...new Set(candidates)]) {
    try {
      return (await import(pathToFileURL(candidate).href)) as OpenClawTranscriptRuntimeModule;
    } catch {
      // Try the next installed OpenClaw runtime shard.
    }
  }
  throw new Error("OpenClaw transcript runtime SDK entry not found");
}

async function loadOpenClawTranscriptEventsModule(): Promise<OpenClawTranscriptEventsModule> {
  const require = createRequire(import.meta.url);
  const candidates: string[] = [];
  try {
    candidates.push(require.resolve("openclaw/plugin-sdk/src/sessions/transcript-events"));
  } catch {}
  for (const root of await resolveOpenClawDistDirs(require)) {
    candidates.push(join(root, "transcript-events.js"));
    try {
      const entries = await readdir(root);
      for (const entry of entries) {
        if (/^transcript-events-[\w-]+\.js$/.test(entry)) {
          candidates.push(join(root, entry));
        }
      }
    } catch {}
  }

  for (const candidate of [...new Set(candidates)]) {
    try {
      return (await import(pathToFileURL(candidate).href)) as OpenClawTranscriptEventsModule;
    } catch {
      // Try the next installed OpenClaw runtime shard.
    }
  }
  return {};
}

function buildHermesSessionOptions(params: {
  cwd: string;
  mcpBridge: AgentHarnessMcpBridge;
  config: HermesPluginConfig;
}): HermesAcpSessionOptions {
  const mcpServers = params.mcpBridge.mcpServers ?? {};
  const env = mergeHermesSessionEnv(params.config, params.mcpBridge.env);
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
  const explicitSessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
  if (explicitSessionId) {
    const fileName = basename(sessionFile);
    const sessionFileId = fileName.slice(0, fileName.length - extname(fileName).length);
    if (sessionFileId && sessionFileId !== explicitSessionId) {
      console.warn(
        `[hermes-acp] conversation history skipped: sessionId=${explicitSessionId} does not match sessionFile=${sessionFile}`,
      );
      return { messages: [] };
    }
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
    runAttempt: async (params) => {
      const startedAt = Date.now();
      return await traceWithSpan(
        {
          endpoint: options.config.otel?.endpoint,
          spanName: "hermes_agent_call",
          serviceName: options.config.otel?.serviceName,
          attributes: {
            [GEN_AI_SPAN_KIND]: GenAiSpanKind.Agent,
            "hermes_entrypoint": "agent_harness",
            "hermes_provider": params.provider ?? "",
            "hermes_model": params.modelId ?? options.config.defaultModel ?? "",
            "hermes_session_key": params.sessionKey ?? "",
            "hermes_session_id": params.sessionId ?? "",
            "hermes_agent_id": params.agentId ?? "",
          },
        },
        async (span) => {
          const response = await runHermesHarnessAttempt(options.config, params);
          span.setAttributes({
            "hermes_status": response.promptError
              ? "error"
              : response.aborted || response.externalAbort
                ? "cancelled"
                : response.timedOut
                  ? "timeout"
                  : "success",
            "hermes_duration_ms": Date.now() - startedAt,
            "hermes_tokens_used": response.usage?.total ?? 0,
            "hermes_tool_count": response.toolMetas?.length ?? 0,
            [GEN_AI_USAGE_INPUT_TOKENS]: response.usage?.input ?? 0,
            [GEN_AI_USAGE_OUTPUT_TOKENS]: response.usage?.output ?? 0,
            [GEN_AI_USAGE_TOTAL_TOKENS]: response.usage?.total ?? 0,
          });
          if (response.promptError || response.timedOut) {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: response.timedOut ? "Hermes timeout" : "Hermes prompt error",
            });
          }
          return response;
        },
      );
    },
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
  const mcpBridge = await prepareHermesMcpBridge({
    config,
    openClawConfig: params.config,
    workspaceDir: params.workspaceDir,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    agentAccountId: params.agentAccountId,
    messageChannel: params.messageChannel,
    messageProvider: params.messageProvider,
    messageTo: params.messageTo,
    messageThreadId: params.messageThreadId,
    currentChannelId: params.currentChannelId,
    currentThreadTs: params.currentThreadTs,
    currentMessageId: params.currentMessageId,
    senderId:
      params.senderId ??
      resolveFeishuSenderIdFromPrompt(sanitizedPrompt) ??
      resolveFeishuSenderIdFromPrompt(params.prompt),
    senderIsOwner: params.senderIsOwner,
  });

  const execution = await traceStep("hermes_context_assembly", async (span) => {
    span.setAttributes({
      "hermes_context_level": contextLevel,
      "hermes_context_history_messages": conversationHistory.messages.length,
      "hermes_model": params.modelId ?? config.defaultModel ?? "",
    });
    return await prepareProjectedExecutionEnv({
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
      mcpConfigHash: mcpBridge.mcpResumeHash ?? mcpBridge.mcpConfigHash,
      credentialScopeHash: mcpBridge.credentialScopeHash,
    });
  });
  const sessionOptions = buildHermesSessionOptions({
    cwd: execution.execEnv.runtimeExecEnvPath,
    mcpBridge,
    config,
  });

  try {
    // Mirror prompt-referenced host paths before ACP starts so Hermes file
    // writes can later be pulled back to the OpenClaw host.
    await traceStep("hermes_workspace_mirror_to_container", async (span) => {
      span.setAttribute("hermes_workspace_path_count", referencedWorkspacePaths.length);
      await mirrorWorkspaceToContainer(config, params.workspaceDir, referencedWorkspacePaths);
    });
    await traceStep("hermes_acp_connect", async (span) => {
      span.setAttribute("hermes_acp_transport", config.transport);
      await client.start();
    });
    webui.lifecycleStart({ startedAt: Date.now() });
    publishHermesHarnessAgentEvent(params, {
      stream: "lifecycle",
      data: { phase: "start", startedAt: Date.now() },
    });
    const sessionId = await traceStep("hermes_session_create", async (span) => {
      const id = await resumeOrCreateSession({
        client,
        sessionOptions,
        bindingHash: execution.sessionBindingHash,
      });
      span.setAttribute("hermes.session.id", id);
      return id;
    });

    const acpPrompt = clampAcpPrompt(execution.bootstrapPrompt);
    if (acpPrompt.length !== execution.bootstrapPrompt.length) {
      console.warn(
        `[hermes-acp] bootstrap prompt clamped from ${execution.bootstrapPrompt.length} to ${acpPrompt.length} chars`,
      );
    }

    const result = await traceStep("hermes_llm_loop", async (span) => {
      span.setAttributes({
        [GEN_AI_SPAN_KIND]: GenAiSpanKind.LLMLoop,
        "hermes.session.id": sessionId,
        "hermes_llm_timeout_ms": timeoutMs,
      });
      const response = await client.prompt(acpPrompt, sessionId, {
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
      span.setAttributes({
        [GEN_AI_USAGE_INPUT_TOKENS]: response.usage?.input_tokens ?? 0,
        [GEN_AI_USAGE_OUTPUT_TOKENS]: response.usage?.output_tokens ?? 0,
        [GEN_AI_USAGE_TOTAL_TOKENS]: response.usage?.total_tokens ?? 0,
        "hermes_llm_event_count": response.events.length,
      });
      recordEventSpans(response.events, { hermesSessionId: sessionId });
      return response;
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
    await traceStep("hermes_workspace_mirror_from_container", async (span) => {
      span.setAttributes({
        "hermes_workspace_path_count": referencedWorkspacePaths.length,
        "hermes_touched_skill_count": touchedSkillNames.length,
      });
      await mirrorWorkspaceFromContainer(
        config,
        params.workspaceDir,
        referencedWorkspacePaths,
        execution.execEnv.runtimeExecEnvPath,
        touchedSkillNames,
      );
    });
    const assistantText = result.text;
    const lastAssistant = buildAssistantMessage(params, assistantText, usage, {
      aborted: false,
      errorMessage: null,
    });
    const currentTurnMessages: HarnessMessage[] = [
      buildUserMessage(params),
      ...(lastAssistant ? [lastAssistant] : []),
    ];
    const messagesSnapshot = [
      ...(conversationHistory.messages ?? []),
      ...currentTurnMessages,
    ] as AgentHarnessAttemptResult["messagesSnapshot"];
    await traceStep("hermes_transcript_mirror", async (span) => {
      span.setAttribute("hermes_transcript_message_count", currentTurnMessages.length);
      await mirrorHermesTranscriptBestEffort({
        sessionFile: params.sessionFile,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        idempotencyScope: buildHermesMirrorIdempotencyScope(params),
        config: params.config,
        messages: currentTurnMessages,
      });
    });

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
    const currentTurnMessages: HarnessMessage[] = [
      buildUserMessage(params),
      ...(lastAssistant ? [lastAssistant] : []),
    ];
    await traceStep("hermes_transcript_mirror", async (span) => {
      span.setAttribute("hermes_transcript_message_count", currentTurnMessages.length);
      await mirrorHermesTranscriptBestEffort({
        sessionFile: params.sessionFile,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        idempotencyScope: buildHermesMirrorIdempotencyScope(params),
        config: params.config,
        messages: currentTurnMessages,
      });
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
      messagesSnapshot: [
        ...(conversationHistory.messages ?? []),
        ...currentTurnMessages,
      ] as AgentHarnessAttemptResult["messagesSnapshot"],
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
    await traceStep("hermes_session_close", async (span) => {
      span.setAttribute("hermes.session.id", client.currentSessionId ?? "");
      await client.close().catch(() => {});
    });
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
    content: [{ type: "text", text: extractDisplayPromptForOpenClawTranscript(params.prompt) }],
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

async function readTranscriptIdempotencyKeys(sessionFile: string): Promise<Set<string>> {
  const keys = new Set<string>();
  let raw: string;
  try {
    raw = await readFile(sessionFile, "utf8");
  } catch {
    return keys;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { message?: { idempotencyKey?: unknown } };
      if (typeof parsed.message?.idempotencyKey === "string") {
        keys.add(parsed.message.idempotencyKey);
      }
    } catch {
      continue;
    }
  }
  return keys;
}

function fingerprintMirrorMessageContent(message: AgentMessageForTranscript): string {
  const payload = JSON.stringify({
    role: message.role,
    content: message.content,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function buildHermesMirrorIdempotencyScope(params: AgentHarnessAttemptParams): string | undefined {
  const explicit = [
    (params as { runId?: unknown }).runId,
    params.currentMessageId,
    params.messageThreadId,
  ].find((value) => typeof value === "string" || typeof value === "number");
  if (explicit !== undefined) {
    return `hermes:${String(explicit)}`;
  }
  return undefined;
}

function buildHermesMirrorDedupeIdentity(message: AgentMessageForTranscript): string {
  const role = typeof message.role === "string" ? message.role : "message";
  return `${role}:${fingerprintMirrorMessageContent(message)}`;
}

function normalizeOpenClawStoreSessionKey(sessionKey: string): string {
  return sessionKey.trim().toLowerCase();
}

function resolveDefaultOpenClawSessionStorePath(agentId?: string): string {
  const normalizedAgentId =
    typeof agentId === "string" && agentId.trim() ? agentId.trim().toLowerCase() : "main";
  return join("/root/.openclaw/agents", normalizedAgentId, "sessions", "sessions.json");
}

async function resolveOpenClawSessionEntryFromStore(params: {
  sessionKey?: string;
  agentId?: string;
}): Promise<{ sessionKey: string; storePath: string; entry: OpenClawSessionStoreEntry } | undefined> {
  const sessionKey =
    typeof params.sessionKey === "string" && params.sessionKey.trim()
      ? params.sessionKey.trim()
      : "";
  if (!sessionKey) {
    return undefined;
  }

  const storePath = resolveDefaultOpenClawSessionStorePath(params.agentId);
  let store: Record<string, OpenClawSessionStoreEntry>;
  try {
    store = JSON.parse(await readFile(storePath, "utf8")) as Record<string, OpenClawSessionStoreEntry>;
  } catch {
    return undefined;
  }

  const exact = store[sessionKey];
  if (exact?.sessionId || exact?.sessionFile) {
    return { sessionKey, storePath, entry: exact };
  }

  const normalized = normalizeOpenClawStoreSessionKey(sessionKey);
  for (const [key, entry] of Object.entries(store)) {
    if (normalizeOpenClawStoreSessionKey(key) === normalized && (entry?.sessionId || entry?.sessionFile)) {
      return { sessionKey: key, storePath, entry };
    }
  }
  return undefined;
}

function resolveTranscriptPathFromStoreEntry(params: {
  storePath: string;
  entry: OpenClawSessionStoreEntry;
}): string | undefined {
  const sessionFile =
    typeof params.entry.sessionFile === "string" && params.entry.sessionFile.trim()
      ? params.entry.sessionFile.trim()
      : "";
  if (sessionFile) {
    return sessionFile;
  }
  const sessionId =
    typeof params.entry.sessionId === "string" && params.entry.sessionId.trim()
      ? params.entry.sessionId.trim()
      : "";
  if (!sessionId) {
    return undefined;
  }
  return join(dirname(params.storePath), `${sessionId}.jsonl`);
}

function createTranscriptRecordId(): string {
  return randomBytes(4).toString("hex");
}

async function appendMessagesToTranscriptFileBestEffort(params: {
  sessionFile: string;
  sessionKey?: string;
  idempotencyScope?: string;
  messages: AgentHarnessAttemptResult["messagesSnapshot"];
}): Promise<boolean> {
  if (!params.messages?.length) {
    return false;
  }

  const existingIdempotencyKeys = await readTranscriptIdempotencyKeys(params.sessionFile);
  const records: string[] = [];
  let appended = false;
  let parentId = await readLatestTranscriptMessageId(params.sessionFile);
  for (const message of params.messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const role = (message as { role?: unknown }).role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const idempotencyKey = params.idempotencyScope
      ? `${params.idempotencyScope}:${buildHermesMirrorDedupeIdentity(message as AgentMessageForTranscript)}`
      : undefined;
    if (idempotencyKey && existingIdempotencyKeys.has(idempotencyKey)) {
      continue;
    }
    const transcriptMessage = {
      ...(message as AgentMessageForTranscript),
      ...(role === "user"
        ? { content: normalizeUserTranscriptContent((message as AgentMessageForTranscript).content) }
        : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
    const recordId = createTranscriptRecordId();
    records.push(
      JSON.stringify({
        type: "message",
        id: recordId,
        parentId,
        timestamp: new Date().toISOString(),
        message: transcriptMessage,
      }),
    );
    parentId = recordId;
    if (idempotencyKey) {
      existingIdempotencyKeys.add(idempotencyKey);
    }
    appended = true;
  }

  if (!records.length) {
    return false;
  }
  await mkdir(dirname(params.sessionFile), { recursive: true });
  await appendFile(params.sessionFile, `${records.join("\n")}\n`, "utf8");
  await emitOpenClawTranscriptUpdateBestEffort({
    sessionFile: params.sessionFile,
    sessionKey: params.sessionKey,
  });
  return appended;
}

async function readLatestTranscriptMessageId(sessionFile: string): Promise<string | null> {
  try {
    const lines = (await readFile(sessionFile, "utf8")).split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as { type?: unknown; id?: unknown; message?: unknown };
        if (parsed.type === "message" && typeof parsed.id === "string" && parsed.id) {
          return parsed.id;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function emitOpenClawTranscriptUpdateBestEffort(params: {
  sessionFile: string;
  sessionKey?: string;
}): Promise<void> {
  try {
    const module = await loadOpenClawTranscriptEventsModule();
    const emit = module.emitSessionTranscriptUpdate ?? module.t;
    if (typeof emit !== "function") {
      return;
    }
    const sessionKey =
      typeof params.sessionKey === "string" && params.sessionKey.trim()
        ? params.sessionKey.trim()
        : undefined;
    emit(sessionKey ? { sessionFile: params.sessionFile, sessionKey } : params.sessionFile);
  } catch {
    // File append succeeded; live update is best effort.
  }
}

async function appendAssistantTranscriptViaOpenClawRuntimeBestEffort(params: {
  sessionKey?: string;
  agentId?: string;
  idempotencyScope?: string;
  message: AgentMessageForTranscript;
}): Promise<boolean> {
  const sessionKey =
    typeof params.sessionKey === "string" && params.sessionKey.trim()
      ? params.sessionKey.trim()
      : "";
  if (!sessionKey || params.message.role !== "assistant") {
    return false;
  }

  const idempotencyKey = params.idempotencyScope
    ? `${params.idempotencyScope}:${buildHermesMirrorDedupeIdentity(params.message)}`
    : undefined;

  try {
    const module = await loadOpenClawTranscriptRuntimeModule();
    const append = module.appendExactAssistantMessageToSessionTranscript;
    if (typeof append !== "function") {
      return false;
    }
    const result = await append({
      agentId: params.agentId,
      sessionKey,
      message: {
        ...(params.message as AgentMessageForTranscript & { role: "assistant" }),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      },
      ...(idempotencyKey ? { idempotencyKey } : {}),
      updateMode: "inline",
    });
    if (result.ok) {
      return true;
    }
    console.warn(`[hermes-acp] OpenClaw transcript runtime append skipped: ${result.reason}`);
  } catch (error) {
    console.warn(
      `[hermes-acp] OpenClaw transcript runtime append failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return false;
}

async function mirrorHermesTranscriptBestEffort(params: {
  sessionFile?: string;
  sessionKey?: string;
  agentId?: string;
  idempotencyScope?: string;
  config?: unknown;
  messages: AgentHarnessAttemptResult["messagesSnapshot"];
}): Promise<void> {
  const sessionFile =
    typeof params.sessionFile === "string" && params.sessionFile.trim()
      ? params.sessionFile.trim()
      : "";
  if (!params.messages?.length) {
    return;
  }

  try {
    if (sessionFile) {
      const module = await loadAgentHarnessRuntimeModule();
      const append = module.appendSessionTranscriptMessage;
      const emitUpdate = module.emitSessionTranscriptUpdate;
      const runBeforeWriteHook = module.runAgentHarnessBeforeMessageWriteHook;
      if (typeof append === "function") {
        const release = await module.acquireSessionWriteLock?.({
          sessionFile,
          timeoutMs: module.resolveSessionWriteLockAcquireTimeoutMs?.(params.config),
        });
        try {
          const existingIdempotencyKeys = await readTranscriptIdempotencyKeys(sessionFile);
          for (const message of params.messages) {
            if (!message || typeof message !== "object") {
              continue;
            }
            const role = (message as { role?: unknown }).role;
            if (role !== "user" && role !== "assistant") {
              continue;
            }
            const idempotencyKey = params.idempotencyScope
              ? `${params.idempotencyScope}:${buildHermesMirrorDedupeIdentity(message as AgentMessageForTranscript)}`
              : undefined;
            if (idempotencyKey && existingIdempotencyKeys.has(idempotencyKey)) {
              continue;
            }
            const transcriptMessage = {
              ...(message as AgentMessageForTranscript),
              ...(idempotencyKey ? { idempotencyKey } : {}),
            };
            const nextMessage =
              typeof runBeforeWriteHook === "function"
                ? runBeforeWriteHook({
                    message: transcriptMessage,
                    agentId: params.agentId,
                    sessionKey: params.sessionKey,
                  })
                : transcriptMessage;
            if (!nextMessage) {
              continue;
            }
            await append({
              transcriptPath: sessionFile,
              message: idempotencyKey ? { ...nextMessage, idempotencyKey } : nextMessage,
              config: params.config,
            });
            if (idempotencyKey) {
              existingIdempotencyKeys.add(idempotencyKey);
            }
          }
        } finally {
          await release?.release();
        }

        if (typeof emitUpdate === "function") {
          const sessionKey =
            typeof params.sessionKey === "string" && params.sessionKey.trim()
              ? params.sessionKey.trim()
              : undefined;
          emitUpdate(sessionKey ? { sessionFile, sessionKey } : sessionFile);
        }
        return;
      }
    }

    const resolvedSession = await resolveOpenClawSessionEntryFromStore({
      sessionKey: params.sessionKey,
      agentId: params.agentId,
    });
    const resolvedSessionFile = resolvedSession
      ? resolveTranscriptPathFromStoreEntry({
          storePath: resolvedSession.storePath,
          entry: resolvedSession.entry,
        })
      : undefined;
    if (resolvedSessionFile) {
      const appended = await appendMessagesToTranscriptFileBestEffort({
        sessionFile: resolvedSessionFile,
        sessionKey: resolvedSession?.sessionKey ?? params.sessionKey,
        idempotencyScope: params.idempotencyScope,
        messages: params.messages,
      });
      if (appended) {
        return;
      }
    }

    for (const message of params.messages) {
      if (!message || typeof message !== "object") {
        continue;
      }
      await appendAssistantTranscriptViaOpenClawRuntimeBestEffort({
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        idempotencyScope: params.idempotencyScope,
        message: message as AgentMessageForTranscript,
      });
    }
  } catch (error) {
    console.warn(
      `[hermes-acp] failed to mirror current turn into OpenClaw transcript: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
