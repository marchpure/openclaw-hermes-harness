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
} from "./runtime-client.js";
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
      if (params.sessionFile) {
        await clearHermesHarnessBinding(params.sessionFile);
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
