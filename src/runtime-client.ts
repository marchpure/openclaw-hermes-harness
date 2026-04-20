import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
  NormalizedUsage,
} from "openclaw/plugin-sdk/agent-harness";
import { publishHermesHarnessAgentEvent } from "./agent-event-bridge.js";
import { HermesAcpClient, type AcpPromptBlock } from "./acp-client.js";
import { buildHermesHostCapabilityPrompt } from "./host-capabilities.js";
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

const HARNESS_CALLBACK_TIMEOUT_MS = 1000;

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
  tcpHost?: string;
  tcpPort?: number;
  containerName?: string;
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
  const contextHash = await buildHermesHarnessBootstrapHash(params);
  const runtimeCwd = resolveHermesRuntimeCwd(config, params.workspaceDir);
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
    await client.start({}, runtimeCwd);
    let session = await resolveHermesHarnessSession(client, config, params, contextHash, runtimeCwd);
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
      session = await createHermesHarnessSession(client, config, params, contextHash, runtimeCwd);
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
      notifyHarnessCallback("onReasoningEnd", () => params.onReasoningEnd?.());
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
    if (config.transport === "tcp" && timeoutController.signal.aborted) {
      await clearHermesHarnessBinding(params.sessionFile);
    }
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
  const sections = await buildHermesHarnessPromptSections(params, { includeUserPrompt: true });

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

export async function buildHermesHarnessBootstrapHash(params: AgentHarnessAttemptParams): Promise<string> {
  const sections = await buildHermesHarnessPromptSections(params, { includeUserPrompt: false });
  return hashHermesHarnessSections(sections);
}

async function buildHermesHarnessPromptSections(
  params: AgentHarnessAttemptParams,
  options: { includeUserPrompt: boolean },
): Promise<string[]> {
  const workspaceContext = await buildWorkspaceContextPrompt(params.workspaceDir);
  const skillsPrompt = buildHermesSkillsPrompt(params.skillsSnapshot);
  return [
    "# OpenClaw Runtime",
    [
      "You are executing as the current OpenClaw agent through the Hermes ACP runtime.",
      "Preserve the active OpenClaw agent identity, workspace, session, and channel context.",
      "If Hermes has its own default assistant identity, treat it only as the execution backend; do not replace the OpenClaw agent identity with it.",
      "Treat each prompt as part of the current OpenClaw session. If the user sends a short follow-up such as 'help me think about it', resolve it against the immediately preceding OpenClaw conversation when available instead of treating it as a brand-new unrelated task.",
      "OpenClaw workspace identity files (SOUL.md, USER.md, AGENTS.md, MEMORY.md) are read-only context, not a scratchpad for edits.",
      "Do not create, overwrite, or mutate OpenClaw workspace identity or memory files unless OpenClaw explicitly requests writeback through its own mechanisms.",
      "Hermes runtime-local skills, memory, and identity are implementation details of the backend. Do not present them as capabilities of the current OpenClaw agent.",
      "Only the skills listed under # Available OpenClaw Skills are exposed to the current OpenClaw agent. If that section is absent or empty, say no OpenClaw skills were exposed.",
      "If the user asks what skills you have, list only # Available OpenClaw Skills. Do not enumerate Hermes image/container built-in skills unless OpenClaw explicitly lists them there.",
      "When a lookup depends on live external data or a backend tool fails because a local skill, login, or API key is unavailable, try an available equivalent route before giving up. Explain the limitation in natural language and do not expose raw internal JSON errors to the user.",
      "Use Hermes tools for execution. If OpenClaw dynamic tools are unavailable through ACP, explain the limitation instead of pretending to call them.",
    ].join("\n"),
    params.agentId ? `# Agent\nagentId: ${params.agentId}` : undefined,
    workspaceContext ? `# Workspace Context\n${workspaceContext}` : undefined,
    params.extraSystemPrompt ? `# Developer Instructions\n${params.extraSystemPrompt}` : undefined,
    skillsPrompt ? `# Available OpenClaw Skills\n${skillsPrompt}` : undefined,
    `# OpenClaw Host Capabilities\n${buildHermesHostCapabilityPrompt()}`,
    params.toolsAllow?.length ? `# OpenClaw Tool Allowlist\n${params.toolsAllow.map((tool) => `- ${tool}`).join("\n")}` : undefined,
    options.includeUserPrompt ? `# User Prompt\n${params.prompt}` : undefined,
  ].filter((section): section is string => Boolean(section && section.trim()));
}

export async function resolveHermesHarnessSessionForTest(
  client: HermesAcpClient,
  config: HermesPluginConfig,
  params: AgentHarnessAttemptParams,
  contextHash: string,
): Promise<{ sessionId: string; reused: boolean }> {
  return resolveHermesHarnessSession(
    client,
    config,
    params,
    contextHash,
    resolveHermesRuntimeCwd(config, params.workspaceDir),
  );
}

async function resolveHermesHarnessSession(
  client: HermesAcpClient,
  config: HermesPluginConfig,
  params: AgentHarnessAttemptParams,
  contextHash: string,
  runtimeCwd: string,
): Promise<{ sessionId: string; reused: boolean }> {
  if (config.transport === "tcp") {
    const binding = await readHermesHarnessBinding(params.sessionFile);
    if (
      binding?.sessionId &&
      binding.cwd === runtimeCwd &&
      binding.transport === config.transport &&
      binding.tcpHost === config.tcpHost &&
      binding.tcpPort === config.tcpPort &&
      binding.containerName === config.hermesContainerName
    ) {
      try {
        await client.resumeSession(binding.sessionId, runtimeCwd);
        await writeHermesHarnessBinding(params.sessionFile, {
          ...binding,
          contextHash,
          model: params.modelId,
          agentId: params.agentId,
          updatedAt: new Date().toISOString(),
        });
        return { sessionId: binding.sessionId, reused: true };
      } catch (err) {
        await clearHermesHarnessBinding(params.sessionFile);
        console.warn(
          `[hermes] stale TCP session ${binding.sessionId} could not be resumed; creating a new Hermes session: ${
            formatCallbackError(err)
          }`,
        );
      }
    }
  }

  return createHermesHarnessSession(client, config, params, contextHash, runtimeCwd);
}

async function createHermesHarnessSession(
  client: HermesAcpClient,
  config: HermesPluginConfig,
  params: AgentHarnessAttemptParams,
  contextHash: string,
  runtimeCwd: string,
): Promise<{ sessionId: string; reused: boolean }> {
  const sessionId = await client.newSession(runtimeCwd);
  if (config.transport === "tcp") {
    await writeHermesHarnessBinding(params.sessionFile, {
      schemaVersion: 1,
      sessionFile: params.sessionFile,
      sessionId,
      cwd: runtimeCwd,
      contextHash,
      model: params.modelId,
      agentId: params.agentId,
      transport: config.transport,
      tcpHost: config.tcpHost,
      tcpPort: config.tcpPort,
      containerName: config.hermesContainerName,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  return { sessionId, reused: false };
}

function resolveHermesRuntimeCwd(config: HermesPluginConfig, workspaceDir: string): string {
  const configured = config.runtimeCwd?.trim();
  if (!configured) {
    return workspaceDir;
  }
  return configured;
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
          notifyHarnessCallback("onAssistantMessageStart", () => params.onAssistantMessageStart?.());
        },
        markReasoningStarted: () => {
          state.reasoningStarted = true;
        },
        markReasoningEnded: async () => {
          if (!state.reasoningStarted || state.reasoningEnded) return;
          state.reasoningEnded = true;
          notifyHarnessCallback("onReasoningEnd", () => params.onReasoningEnd?.());
        },
        toolMetas: state.toolMetas,
      });
    },
  });
}

export async function handleHarnessEvent(
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
    notifyHarnessCallback("markAssistantStarted", () => state.markAssistantStarted());
    notifyHarnessCallback("onPartialReply", () => params.onPartialReply?.({ text: event.text }));
    return;
  }

  if (event.type === "thinking" && event.text) {
    state.markReasoningStarted();
    publishHermesHarnessAgentEvent(params, {
      stream: "thinking",
      data: {
        text: event.text,
        delta: event.text,
      },
    });
    notifyHarnessCallback("onReasoningStream", () => params.onReasoningStream?.({ text: event.text }));
    return;
  }

  if (event.type === "tool_progress") {
    const id = event.toolCallId || `${event.toolName || "tool"}:${state.toolMetas.size}`;
    const toolName = event.toolName || "hermes_tool";
    const startedAt = Date.now();
    state.toolMetas.set(id, { toolName });
    publishHermesHarnessAgentEvent(params, {
      stream: "tool",
      data: {
        phase: "start",
        name: toolName,
        toolCallId: id,
      },
    });
    publishHermesHarnessAgentEvent(params, {
      stream: "item",
      data: {
        itemId: id,
        phase: "start",
        kind: "tool",
        title: toolName,
        status: "running",
        name: toolName,
        toolCallId: id,
        startedAt,
      },
    });
    return;
  }

  if (event.type === "tool_result") {
    const id = event.toolCallId || `tool:${state.toolMetas.size}`;
    const existing = state.toolMetas.get(id);
    const toolName = event.toolName || existing?.toolName || "hermes_tool";
    const outputText = formatHermesToolOutput(event.text);
    const isError = isHermesToolError(event.text);
    state.toolMetas.set(id, {
      toolName,
      ...(outputText ? { meta: outputText.slice(0, 200) } : {}),
    });
    publishHermesHarnessAgentEvent(params, {
      stream: "tool",
      data: {
        phase: "result",
        name: toolName,
        toolCallId: id,
        isError,
        result: {
          content: outputText ? [{ type: "text", text: outputText }] : [],
        },
      },
    });
    publishHermesHarnessAgentEvent(params, {
      stream: "item",
      data: {
        itemId: id,
        phase: "end",
        kind: "tool",
        title: buildHermesToolItemTitle(toolName, outputText),
        status: isError ? "failed" : "completed",
        name: toolName,
        toolCallId: id,
        endedAt: Date.now(),
        ...(outputText ? { summary: outputText, progressText: outputText } : {}),
      },
    });
    notifyHarnessCallback("onToolResult", () => params.onToolResult?.({ text: outputText } as never));
    return;
  }

  if (event.type === "done") {
    notifyHarnessCallback("markReasoningEnded", () => state.markReasoningEnded());
  }
}

async function safeHarnessCallback(label: string, callback: () => unknown): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(callback()),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, HARNESS_CALLBACK_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    console.warn(`[hermes] OpenClaw harness callback ${label} failed: ${formatCallbackError(err)}`);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function notifyHarnessCallback(label: string, callback: () => unknown): void {
  void safeHarnessCallback(label, callback);
}

function formatCallbackError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function buildHermesToolItemTitle(toolName: string, outputText: string): string {
  const firstLine = outputText.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) {
    return toolName;
  }
  return `${toolName}: ${firstLine.slice(0, 120)}`;
}

function formatHermesToolOutput(text: string | undefined): string {
  if (!text) {
    return "";
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const output = readString(record.output);
      const error = readString(record.error);
      const nestedError = readNestedError(record.error);
      const exitCode = record.exit_code ?? record.exitCode;
      const parts: string[] = [];
      const title = readString(record.title);
      const url = readString(record.url);
      const message = readString(record.message);
      const command = readString(record.command);
      const success = record.success;
      const snapshot = readString(record.snapshot);
      if (output) {
        parts.push(output);
      }
      if (!output && command) {
        parts.push(`command: ${command}`);
      }
      if (title) {
        parts.push(`title: ${title}`);
      }
      if (url) {
        parts.push(`url: ${url}`);
      }
      if (!output && typeof success === "boolean") {
        parts.push(`success: ${success}`);
      }
      if (!output && message) {
        parts.push(message);
      }
      if (error) {
        parts.push(`error: ${error}`);
      } else if (nestedError) {
        parts.push(`error: ${nestedError}`);
      }
      if (typeof exitCode === "number" && exitCode !== 0) {
        parts.push(`exit_code: ${exitCode}`);
      }
      if (parts.length === 0 && snapshot) {
        parts.push("snapshot captured");
      }
      if (parts.length > 0) {
        return truncateVisibleToolText(parts.join("\n").trim());
      }
      const summary = summarizeJsonToolResult(record);
      if (summary) {
        return summary;
      }
    }
  } catch {
    // Fall through to the original text for non-JSON tool payloads.
  }
  return truncateVisibleToolText(trimmed);
}

function isHermesToolError(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const record = parsed as Record<string, unknown>;
    const exitCode = record.exit_code ?? record.exitCode;
    if (typeof exitCode === "number" && exitCode !== 0) {
      return true;
    }
    const error = record.error;
    return Boolean(
      (typeof error === "string" && error.trim().length > 0) ||
        readNestedError(error) ||
        record.success === false,
    );
  } catch {
    return false;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readNestedError(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const message = readString(record.message) ?? readString(record.error) ?? readString(record.msg);
  const statusCode = record.statusCode ?? record.code;
  if (message && (typeof statusCode === "number" || typeof statusCode === "string")) {
    return `${message} (code=${statusCode})`;
  }
  return message;
}

function truncateVisibleToolText(text: string, maxChars = 1200): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars - 32)}\n...[tool output truncated]`;
}

function summarizeJsonToolResult(record: Record<string, unknown>): string {
  const noisyKeys = new Set([
    "snapshot",
    "content",
    "html",
    "markdown",
    "raw_output",
    "rawOutput",
    "details",
    "data",
  ]);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (noisyKeys.has(key)) {
      continue;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) {
        continue;
      }
      lines.push(`${key}: ${trimmed}`);
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      lines.push(`${key}: ${String(value)}`);
      continue;
    }
  }
  return lines.length > 0 ? truncateVisibleToolText(lines.join("\n")) : "";
}

function buildHermesSkillsPrompt(snapshot: AgentHarnessAttemptParams["skillsSnapshot"]): string {
  if (!snapshot) {
    return "";
  }
  const resolvedSkills = snapshot.resolvedSkills ?? [];
  if (resolvedSkills.length > 0) {
    return resolvedSkills
      .map((skill) => {
        const name = skill.name ?? skill.source ?? "unknown";
        const description = skill.description ? `: ${skill.description}` : "";
        return `- ${name}${description}`;
      })
      .join("\n");
  }

  const skills = snapshot.skills ?? [];
  if (skills.length > 0) {
    return skills
      .map((skill) => {
        const required = skill.requiredEnv?.length
          ? `; requires env: ${skill.requiredEnv.join(", ")}`
          : "";
        const primary = skill.primaryEnv ? `; primary env: ${skill.primaryEnv}` : "";
        return `- ${skill.name}${primary}${required}`;
      })
      .join("\n");
  }

  const prompt = snapshot.prompt?.trim() ?? "";
  if (!prompt) {
    return "";
  }
  return prompt
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        Boolean(line) &&
        !line.includes("<available_skills>") &&
        !line.includes("</available_skills>") &&
        !line.includes("<location>") &&
        !line.includes("read its SKILL.md") &&
        !line.includes("Before replying: scan <available_skills>"),
    )
    .join("\n");
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

function hashHermesHarnessSections(sections: string[]): string {
  return createHash("sha256").update(sections.join("\n\n---\n\n")).digest("hex");
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
