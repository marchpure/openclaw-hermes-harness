import type {
  AgentHarness,
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
} from "openclaw/plugin-sdk/agent-harness";
import {
  createHermesRuntimeClient,
  type HermesRuntimeClient,
  type HermesRunResponse,
} from "./src/client.js";
import { resolveHermesAcpConfig } from "./src/config.js";

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
    aborted: false,
    externalAbort: false,
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    promptError: null,
    promptErrorSource: null,
    sessionIdUsed: response.sessionId ?? params.sessionId,
    bootstrapPromptWarningSignaturesSeen: params.bootstrapPromptWarningSignaturesSeen,
    bootstrapPromptWarningSignature: params.bootstrapPromptWarningSignature,
    messagesSnapshot: [],
    assistantTexts,
    toolMetas: [],
    lastAssistant: undefined,
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
    itemLifecycle: {
      startedCount: assistantTexts.length > 0 ? 1 : 0,
      completedCount: assistantTexts.length > 0 ? 1 : 0,
      activeCount: 0,
    },
  };
}
