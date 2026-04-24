import type {
  AgentHarness,
  AgentHarnessCompactResult,
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
} from "openclaw/plugin-sdk/agent-harness";
import {
  clearHermesHarnessBinding,
  createHermesRuntimeClient,
  type HermesRunResponse,
  type HermesRuntimeClient,
} from "./harness-runtime.js";
import { resolveHermesAcpConfig } from "./config.js";

const DEFAULT_HERMES_HARNESS_PROVIDER_IDS = new Set(["hermes"]);

export function createHermesAgentHarness(options?: {
  id?: string;
  label?: string;
  providerIds?: Iterable<string>;
  pluginConfig?: unknown;
  client?: HermesRuntimeClient;
}): AgentHarness {
  const providerIds = new Set(
    [...(options?.providerIds ?? DEFAULT_HERMES_HARNESS_PROVIDER_IDS)].map((id) =>
      id.trim().toLowerCase(),
    ),
  );
  return {
    id: options?.id ?? "hermes",
    label: options?.label ?? "Hermes agent harness",
    supports: (ctx) => {
      const provider = ctx.provider.trim().toLowerCase();
      if (providerIds.has(provider)) {
        return { supported: true, priority: 100 };
      }
      return {
        supported: false,
        reason: `provider is not one of: ${[...providerIds].sort().join(", ")}`,
      };
    },
    runAttempt: async (params) => {
      // Provider 解析出的 `hermes/<model>` 最终都会落到 harness.runAttempt。
      // 这里是“OpenClaw 把一次 agent attempt 交给 Hermes runtime”的总入口。
      const client =
        options?.client ??
        createHermesRuntimeClient({
          config: resolveHermesAcpConfig(options?.pluginConfig),
        });
      const response = await client.runAttempt(params);
      return buildHermesAttemptResult(params, response);
    },
    compact: async () => buildUnsupportedCompactResult(),
    reset: async (params) => {
      // reset 当前只清理本地的 session binding，不尝试远程 compact，
      // 因为 Hermes 还没有暴露一个和 OpenClaw compact 语义对齐的接口。
      if (params.sessionFile) {
        await clearHermesHarnessBinding(
          resolveHermesAcpConfig(options?.pluginConfig),
          params.sessionFile,
        );
      }
    },
  };
}

function buildUnsupportedCompactResult(): AgentHarnessCompactResult {
  return {
    ok: false,
    compacted: false,
    reason: "Hermes ACP runtime does not expose an OpenClaw-compatible compaction API yet; reset clears the session binding.",
  };
}

function buildHermesAttemptResult(
  params: AgentHarnessAttemptParams,
  response: HermesRunResponse,
): AgentHarnessAttemptResult {
  const assistantTexts =
    response.assistantTexts && response.assistantTexts.length > 0
      ? response.assistantTexts
      : response.assistantText
        ? [response.assistantText]
        : [];
  const hadPotentialSideEffects = response.hadPotentialSideEffects === true;
  return {
    aborted: response.aborted ?? false,
    externalAbort: response.externalAbort ?? false,
    timedOut: response.timedOut ?? false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    promptError: response.promptError ?? null,
    promptErrorSource: response.promptErrorSource ?? null,
    sessionIdUsed: response.sessionId ?? params.sessionId,
    bootstrapPromptWarningSignaturesSeen: params.bootstrapPromptWarningSignaturesSeen,
    bootstrapPromptWarningSignature: params.bootstrapPromptWarningSignature,
    finalPromptText: response.finalPromptText,
    messagesSnapshot: response.messagesSnapshot ?? [],
    assistantTexts,
    toolMetas: response.toolMetas ?? [],
    lastAssistant: response.lastAssistant as never,
    currentAttemptAssistant: response.currentAttemptAssistant as never,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    attemptUsage: response.usage,
    replayMetadata: {
      hadPotentialSideEffects,
      replaySafe: response.replaySafe ?? !hadPotentialSideEffects,
    },
    itemLifecycle: response.itemLifecycle ?? {
      startedCount: assistantTexts.length > 0 ? 1 : 0,
      completedCount: assistantTexts.length > 0 ? 1 : 0,
      activeCount: 0,
    },
  };
}
