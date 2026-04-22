import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentHarnessAttemptParams } from "openclaw/plugin-sdk/agent-harness";

type GatewayRequestScope = {
  context?: {
    agentRunSeq: Map<string, number>;
    broadcast: (event: string, payload: Record<string, unknown>, opts?: { dropIfSlow?: boolean }) => void;
    nodeSendToSession: (sessionKey: string, event: string, payload: Record<string, unknown>) => void;
  };
};

let cachedScopeReader: (() => GatewayRequestScope | undefined) | null | undefined;

function loadScopeReader(): (() => GatewayRequestScope | undefined) | null {
  if (cachedScopeReader !== undefined) {
    return cachedScopeReader;
  }
  const require = createRequire(import.meta.url);
  const candidates: string[] = [];
  try {
    candidates.push("openclaw/plugin-sdk/nostr");
  } catch {
    // Ignore; fall through to internal runtime paths.
  }
  try {
    const sdkEntry = require.resolve("openclaw/plugin-sdk/agent-harness");
    const pkgRoot = dirname(dirname(sdkEntry));
    candidates.push(join(pkgRoot, "plugin-sdk", "nostr.js"));
    candidates.push(join(pkgRoot, "plugins", "runtime", "gateway-request-scope.js"));
    candidates.push(join(pkgRoot, "gateway-request-scope.js"));
    candidates.push(...findBundledGatewayRequestScopeModules(pkgRoot));
  } catch {
    // Ignore resolution failures and keep best-effort behavior.
  }
  candidates.push(...findBundledGatewayRequestScopeModules("/usr/lib/node_modules/openclaw/dist"));
  candidates.push(...findBundledGatewayRequestScopeModules("/usr/local/lib/node_modules/openclaw/dist"));
  for (const candidate of candidates) {
    try {
      const mod = require(candidate) as
        | {
            getPluginRuntimeGatewayRequestScope?: () => GatewayRequestScope | undefined;
            t?: () => GatewayRequestScope | undefined;
          }
        | undefined;
      const reader = mod?.getPluginRuntimeGatewayRequestScope ?? mod?.t;
      if (typeof reader === "function") {
        cachedScopeReader = () => reader();
        return cachedScopeReader;
      }
    } catch {
      // Try the next candidate.
    }
  }
  cachedScopeReader = null;
  return cachedScopeReader;
}

function findBundledGatewayRequestScopeModules(distRoot: string): string[] {
  try {
    return readdirSync(distRoot)
      .filter((entry) => /^gateway-request-scope-[\w-]+\.js$/.test(entry))
      .map((entry) => join(distRoot, entry));
  } catch {
    return [];
  }
}

type WebUiBridgeState = {
  assistantText: string;
  lastDeltaSentAt: number;
  lastBroadcastLen: number;
  reasoningStarted: boolean;
};

function nextSeq(context: { agentRunSeq: Map<string, number> }, runId: string): number {
  const next = (context.agentRunSeq.get(runId) ?? 0) + 1;
  context.agentRunSeq.set(runId, next);
  return next;
}

function resolveScope(params: AgentHarnessAttemptParams) {
  const runId = typeof params.runId === "string" && params.runId.trim() ? params.runId.trim() : "";
  const sessionKey =
    typeof params.sessionKey === "string" && params.sessionKey.trim() ? params.sessionKey.trim() : "";
  if (!runId || !sessionKey) {
    return null;
  }
  const scope = loadScopeReader()?.();
  if (!scope?.context) {
    return null;
  }
  return {
    runId,
    sessionKey,
    context: scope.context,
  };
}

function emitAgent(
  params: AgentHarnessAttemptParams,
  stream: string,
  data: Record<string, unknown>,
): void {
  const resolved = resolveScope(params);
  if (!resolved) {
    return;
  }
  const payload = {
    runId: resolved.runId,
    sessionKey: resolved.sessionKey,
    seq: nextSeq(resolved.context, resolved.runId),
    ts: Date.now(),
    stream,
    data,
  };
  resolved.context.broadcast("agent", payload, { dropIfSlow: true });
  resolved.context.nodeSendToSession(resolved.sessionKey, "agent", payload);
}

function emitChat(
  params: AgentHarnessAttemptParams,
  state: WebUiBridgeState,
  chatState: "delta" | "final" | "error",
  extra?: Record<string, unknown>,
): void {
  const resolved = resolveScope(params);
  if (!resolved) {
    return;
  }
  const payload = {
    runId: resolved.runId,
    sessionKey: resolved.sessionKey,
    seq: nextSeq(resolved.context, resolved.runId),
    state: chatState,
    ...(chatState === "error"
      ? extra ?? {}
      : {
          message: {
            role: "assistant",
            content: [{ type: "text", text: state.assistantText }],
            timestamp: Date.now(),
          },
          ...(extra ?? {}),
        }),
  };
  resolved.context.broadcast("chat", payload, { dropIfSlow: true });
  resolved.context.nodeSendToSession(resolved.sessionKey, "chat", payload);
}

export function createWebUiEventBridge(params: AgentHarnessAttemptParams) {
  const state: WebUiBridgeState = {
    assistantText: "",
    lastDeltaSentAt: 0,
    lastBroadcastLen: 0,
    reasoningStarted: false,
  };

  return {
    lifecycleStart(extra?: Record<string, unknown>) {
      emitAgent(params, "lifecycle", { phase: "start", ...(extra ?? {}) });
    },
    lifecycleEnd(extra?: Record<string, unknown>) {
      emitAgent(params, "lifecycle", { phase: "end", ...(extra ?? {}) });
      if (state.assistantText.trim()) {
        emitChat(params, state, "final");
      }
    },
    lifecycleError(errorMessage: string, extra?: Record<string, unknown>) {
      emitAgent(params, "lifecycle", {
        phase: "error",
        error: errorMessage,
        ...(extra ?? {}),
      });
      emitChat(params, state, "error", { errorMessage });
    },
    assistantDelta(deltaText: string) {
      if (!deltaText) {
        return;
      }
      state.assistantText += deltaText;
      emitAgent(params, "assistant", {
        text: state.assistantText,
        delta: deltaText,
      });
      const now = Date.now();
      if (now - state.lastDeltaSentAt < 150 && state.assistantText.length <= state.lastBroadcastLen) {
        return;
      }
      state.lastDeltaSentAt = now;
      state.lastBroadcastLen = state.assistantText.length;
      emitChat(params, state, "delta");
    },
    thinkingStart() {
      if (state.reasoningStarted) {
        return;
      }
      state.reasoningStarted = true;
      emitAgent(params, "thinking", { phase: "start" });
    },
    thinkingDelta(deltaText: string) {
      if (!deltaText) {
        return;
      }
      if (!state.reasoningStarted) {
        state.reasoningStarted = true;
        emitAgent(params, "thinking", { phase: "start" });
      }
      emitAgent(params, "thinking", { text: deltaText, delta: deltaText });
    },
    thinkingEnd() {
      if (!state.reasoningStarted) {
        return;
      }
      state.reasoningStarted = false;
      emitAgent(params, "thinking", { phase: "end" });
    },
    toolStart(toolName: string, toolCallId: string) {
      emitAgent(params, "tool", {
        phase: "start",
        name: toolName,
        toolCallId,
      });
    },
    toolResult(toolName: string, toolCallId: string, summary?: string, isError?: boolean) {
      emitAgent(params, "tool", {
        phase: "result",
        name: toolName,
        toolCallId,
        ...(summary
          ? {
              result: {
                content: [{ type: "text", text: summary }],
              },
              summary,
            }
          : {}),
        ...(isError ? { isError: true } : {}),
      });
    },
  };
}
