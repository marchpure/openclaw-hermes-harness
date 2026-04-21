import type {
  AgentHarness,
  AgentHarnessCompactResult,
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
} from "openclaw/plugin-sdk/agent-harness";
import { dispatchToHermes } from "./dispatcher.js";
import { resolveHermesAcpConfig } from "./config.js";

const DEFAULT_HERMES_HARNESS_PROVIDER_IDS = new Set(["hermes"]);

export function createHermesAgentHarness(options?: {
  id?: string;
  label?: string;
  providerIds?: Iterable<string>;
  pluginConfig?: unknown;
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
      const config = resolveHermesAcpConfig(options?.pluginConfig);
      const response = await dispatchToHermes(
        {
          task: params.prompt,
          model: params.modelId,
          timeout: Math.max(1, Math.ceil(params.timeoutMs / 1000)),
          contextLevel: config.defaultContextLevel,
          credentialScope: { mode: config.defaultCredentialScope },
          writeback: config.defaultWriteback,
          explicitStrategy: true,
        },
        {
          config,
          workspaceDir: params.workspaceDir,
        },
      );
      return buildHermesAttemptResult(params, response.result);
    },
    compact: async () => buildUnsupportedCompactResult(),
    reset: async () => {},
  };
}

function buildUnsupportedCompactResult(): AgentHarnessCompactResult {
  return {
    ok: false,
    compacted: false,
    reason:
      "Hermes ACP runtime does not expose an OpenClaw-compatible compaction API yet.",
  };
}

function buildHermesAttemptResult(
  params: AgentHarnessAttemptParams,
  assistantText: string,
): AgentHarnessAttemptResult {
  const safeText = assistantText.trim();
  void params.onAssistantMessageStart?.();
  if (safeText) {
    void params.onPartialReply?.({ text: safeText });
  }
  return {
    aborted: false,
    externalAbort: false,
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    promptError: null,
    promptErrorSource: null,
    sessionIdUsed: params.sessionId,
    bootstrapPromptWarningSignaturesSeen: params.bootstrapPromptWarningSignaturesSeen,
    bootstrapPromptWarningSignature: params.bootstrapPromptWarningSignature,
    finalPromptText: params.prompt,
    messagesSnapshot: [],
    assistantTexts: safeText ? [safeText] : [],
    toolMetas: [],
    lastAssistant: undefined as never,
    currentAttemptAssistant: undefined as never,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: {
      hadPotentialSideEffects: false,
      replaySafe: true,
    },
    itemLifecycle: {
      startedCount: safeText ? 1 : 0,
      completedCount: safeText ? 1 : 0,
      activeCount: 0,
    },
  };
}
