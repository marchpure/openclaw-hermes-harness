import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildEmbeddedAttemptToolRunContext,
  clearActiveEmbeddedRun,
  createOpenClawCodingTools,
  normalizeProviderToolSchemas,
  resolveAttemptSpawnWorkspaceDir,
  resolveModelAuthMode,
  resolveOpenClawAgentDir,
  resolveSandboxContext,
  resolveSessionAgentIds,
  resolveUserPath,
  setActiveEmbeddedRun,
  supportsModelTools,
  type AgentHarnessAttemptParams,
  type AgentHarnessAttemptResult,
  type AnyAgentTool,
  type NormalizedUsage,
} from "openclaw/plugin-sdk/agent-harness";
import type { HermesPluginConfig } from "../types.js";
import { buildHermesHarnessPromptBlocks, readTextPromptForAppServer } from "../runtime-client.js";
import { HermesAppServerClient } from "./client.js";
import { createHermesDynamicToolBridge } from "./dynamic-tools.js";
import { HermesAppServerEventProjector } from "./projector.js";
import type {
  HermesDynamicToolCallParams,
  HermesThreadStartResponse,
  HermesTurnStartResponse,
  JsonObject,
  JsonValue,
} from "./protocol.js";

const SCRIPT_CONTAINER_PATH = "/opt/data/openclaw-hermes-app-server.py";

export async function runHermesAppServerAttempt(
  config: HermesPluginConfig,
  params: AgentHarnessAttemptParams,
): Promise<AgentHarnessAttemptResult> {
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  const sandboxSessionKey = params.sessionKey?.trim() || params.sessionId;
  const sandbox = await resolveSandboxContext({
    config: params.config,
    sessionKey: sandboxSessionKey,
    workspaceDir: resolvedWorkspace,
  });
  const effectiveWorkspace = sandbox?.enabled
    ? sandbox.workspaceAccess === "rw"
      ? resolvedWorkspace
      : sandbox.workspaceDir
    : resolvedWorkspace;

  const runAbortController = new AbortController();
  const abortFromUpstream = () => runAbortController.abort(params.abortSignal?.reason ?? "upstream_abort");
  if (params.abortSignal?.aborted) {
    abortFromUpstream();
  } else {
    params.abortSignal?.addEventListener("abort", abortFromUpstream, { once: true });
  }

  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });

  let yieldDetected = false;
  const tools = await buildDynamicTools({
    params,
    resolvedWorkspace,
    effectiveWorkspace,
    sandboxSessionKey,
    sandbox,
    runAbortController,
    sessionAgentId,
    onYieldDetected: () => {
      yieldDetected = true;
    },
  });
  const toolBridge = createHermesDynamicToolBridge({ tools, signal: runAbortController.signal });
  await ensureHermesAppServerScript(config);

  const client = new HermesAppServerClient("docker", [
    "exec",
    "-i",
    config.hermesContainerName,
    "bash",
    "-lc",
    `source /opt/hermes/.venv/bin/activate && python3 ${SCRIPT_CONTAINER_PATH}`,
  ]);

  let threadId = "";
  let projector: HermesAppServerEventProjector | undefined;
  let turnCompleted = false;
  let resolveTurnCompletion: (() => void) | undefined;
  const turnCompletion = new Promise<void>((resolve) => {
    resolveTurnCompletion = resolve;
  });
  let notificationQueue: Promise<void> = Promise.resolve();
  const requestCleanup = client.addRequestHandler(async (request) => {
    if (request.method !== "item/tool/call") {
      return undefined;
    }
    const call = readDynamicToolCallParams(request.params);
    if (!call) {
      return {
        contentItems: [{ type: "inputText", text: "Malformed Hermes dynamic tool call" }],
        success: false,
      } satisfies JsonValue;
    }
    return (await toolBridge.handleToolCall(call)) as unknown as JsonValue;
  });
  const notificationCleanup = client.addNotificationHandler(async (notification) => {
    notificationQueue = notificationQueue.then(
      async () => {
        await projector?.handleNotification(notification);
        if (notification.method === "turn/completed") {
          turnCompleted = true;
          resolveTurnCompletion?.();
        }
      },
      async () => {
        await projector?.handleNotification(notification);
        if (notification.method === "turn/completed") {
          turnCompleted = true;
          resolveTurnCompletion?.();
        }
      },
    );
    await notificationQueue;
  });

  const timeout = setTimeout(() => runAbortController.abort("timeout"), Math.max(100, params.timeoutMs));
  const handle = {
    kind: "embedded" as const,
    queueMessage: async () => {},
    isStreaming: () => !runAbortController.signal.aborted,
    isCompacting: () => false,
    cancel: () => runAbortController.abort("cancelled"),
    abort: () => runAbortController.abort("aborted"),
  };
  setActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);

  try {
    await client.initialize(params.timeoutMs);
    const promptBlocks = await buildHermesHarnessPromptBlocks(params);
    const promptText = readTextPromptForAppServer(promptBlocks);
    const thread = await client.request<HermesThreadStartResponse>(
      "thread/start",
      {
        cwd: effectiveWorkspace,
        model: params.modelId || config.defaultModel || null,
        dynamicTools: toolBridge.specs,
        systemPrompt: promptText,
      } satisfies JsonObject,
      { timeoutMs: params.timeoutMs, signal: runAbortController.signal },
    );
    threadId = thread.thread.id;
    projector = new HermesAppServerEventProjector(params, threadId);
    const turn = await client.request<HermesTurnStartResponse>(
      "turn/start",
      {
        threadId,
        input: [{ type: "text", text: params.prompt }],
      } satisfies JsonObject,
      { timeoutMs: params.timeoutMs, signal: runAbortController.signal },
    );
    projector.setUsage(normalizeHermesUsage(turn.usage));
    if (!turnCompleted) {
      await turnCompletion;
    }
    await notificationQueue;
    return projector.buildResult(toolBridge.telemetry, { yieldDetected });
  } catch (error) {
    if (runAbortController.signal.aborted) {
      projector?.markTimedOut();
    }
    if (projector) {
      resolveTurnCompletion?.();
      await notificationQueue.catch(() => undefined);
      return projector.buildResult(toolBridge.telemetry, { yieldDetected });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    notificationCleanup();
    requestCleanup();
    client.close();
    clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
    params.abortSignal?.removeEventListener("abort", abortFromUpstream);
  }
}

type DynamicToolBuildParams = {
  params: AgentHarnessAttemptParams;
  resolvedWorkspace: string;
  effectiveWorkspace: string;
  sandboxSessionKey: string;
  sandbox: Awaited<ReturnType<typeof resolveSandboxContext>>;
  runAbortController: AbortController;
  sessionAgentId: string | undefined;
  onYieldDetected: () => void;
};

async function buildDynamicTools(input: DynamicToolBuildParams): Promise<AnyAgentTool[]> {
  const { params } = input;
  if (params.disableTools || !supportsModelTools(params.model)) {
    return [];
  }
  const modelHasVision = params.model.input?.includes("image") ?? false;
  const agentDir = params.agentDir ?? resolveOpenClawAgentDir();
  const allTools = createOpenClawCodingTools({
    agentId: input.sessionAgentId,
    ...buildEmbeddedAttemptToolRunContext(params),
    exec: {
      ...params.execOverrides,
      elevated: params.bashElevated,
    },
    sandbox: input.sandbox,
    messageProvider: params.messageChannel ?? params.messageProvider,
    agentAccountId: params.agentAccountId,
    messageTo: params.messageTo,
    messageThreadId: params.messageThreadId,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    spawnedBy: params.spawnedBy,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
    senderIsOwner: params.senderIsOwner,
    allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
    sessionKey: input.sandboxSessionKey,
    sessionId: params.sessionId,
    runId: params.runId,
    agentDir,
    workspaceDir: input.effectiveWorkspace,
    spawnWorkspaceDir: resolveAttemptSpawnWorkspaceDir({
      sandbox: input.sandbox,
      resolvedWorkspace: input.resolvedWorkspace,
    }),
    config: params.config,
    abortSignal: input.runAbortController.signal,
    modelProvider: params.model.provider,
    modelId: params.modelId,
    modelCompat: params.model.compat,
    modelApi: params.model.api,
    modelContextWindowTokens: params.model.contextWindow,
    modelAuthMode: resolveModelAuthMode(params.model.provider, params.config),
    currentChannelId: params.currentChannelId,
    currentThreadTs: params.currentThreadTs,
    currentMessageId: params.currentMessageId,
    replyToMode: params.replyToMode,
    hasRepliedRef: params.hasRepliedRef,
    modelHasVision,
    requireExplicitMessageTarget:
      params.requireExplicitMessageTarget ?? params.sessionKey?.startsWith("agent:") === true,
    disableMessageTool: params.disableMessageTool,
    onYield: () => {
      input.onYieldDetected();
      input.runAbortController.abort("sessions_yield");
    },
  });
  const filtered =
    params.toolsAllow && params.toolsAllow.length > 0
      ? allTools.filter((tool) => params.toolsAllow?.includes(tool.name))
      : allTools;
  return normalizeProviderToolSchemas({
    tools: filtered,
    provider: params.provider,
    config: params.config,
    workspaceDir: input.effectiveWorkspace,
    env: process.env,
    modelId: params.modelId,
    modelApi: params.model.api,
    model: params.model,
  });
}

async function ensureHermesAppServerScript(config: HermesPluginConfig): Promise<void> {
  const script = await readHermesAppServerScript();
  const hash = createHash("sha256").update(script).digest("hex");
  const payload = Buffer.from(script, "utf8").toString("base64");
  const command = [
    `TARGET=${shellQuote(SCRIPT_CONTAINER_PATH)}`,
    `HASH_TARGET=${shellQuote(`${SCRIPT_CONTAINER_PATH}.sha256`)}`,
    `NEXT_HASH=${shellQuote(hash)}`,
    `if [ ! -f "$HASH_TARGET" ] || [ "$(cat "$HASH_TARGET" 2>/dev/null)" != "$NEXT_HASH" ]; then`,
    `base64 -d > "$TARGET" <<'OPENCLAW_HERMES_APP_SERVER'`,
    payload,
    "OPENCLAW_HERMES_APP_SERVER",
    `printf '%s' "$NEXT_HASH" > "$HASH_TARGET"`,
    `chmod +x "$TARGET"`,
    "fi",
  ].join("\n");
  await runDockerExec(config.hermesContainerName, command);
}

async function readHermesAppServerScript(): Promise<string> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const homeDir = process.env.HOME || "";
  const candidates = [
    resolve(moduleDir, "hermes-app-server.py"),
    resolve(moduleDir, "app-server", "hermes-app-server.py"),
    resolve(process.cwd(), "src", "app-server", "hermes-app-server.py"),
    resolve(process.cwd(), "extensions", "hermes", "src", "app-server", "hermes-app-server.py"),
    homeDir ? resolve(homeDir, ".openclaw", "extensions", "hermes", "src", "app-server", "hermes-app-server.py") : "",
  ].filter(Boolean);

  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, "utf8");
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Unable to locate Hermes app-server script. Tried:\n${failures.join("\n")}`);
}

function runDockerExec(containerName: string, command: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", ["exec", "-i", containerName, "bash", "-lc", command], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code: number | null) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`docker exec failed with code ${code}: ${stderr.trim()}`));
      }
    });
  });
}

function readDynamicToolCallParams(value: JsonValue | undefined): HermesDynamicToolCallParams | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, JsonValue>;
  const threadId = readString(record.threadId);
  const turnId = readString(record.turnId);
  const callId = readString(record.callId);
  const tool = readString(record.tool);
  if (!threadId || !turnId || !callId || !tool) {
    return undefined;
  }
  return { threadId, turnId, callId, tool, arguments: record.arguments };
}

function normalizeHermesUsage(
  usage: HermesTurnStartResponse["usage"] | undefined,
): NormalizedUsage | undefined {
  if (!usage) {
    return undefined;
  }
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? input + output;
  return {
    input,
    output,
    total: totalTokens,
    cacheRead: 0,
    cacheWrite: 0,
  };
}

function readString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
