import type { AgentHarnessAttemptParams, NormalizedUsage } from "openclaw/plugin-sdk/agent-harness";
import { dispatchToHermes } from "./dispatcher.js";
import type { HermesPluginConfig } from "./types.js";

export type HermesRunResponse = {
  assistantText?: string;
  assistantTexts?: string[];
  sessionId?: string;
  usage?: NormalizedUsage;
  hadPotentialSideEffects?: boolean;
  replaySafe?: boolean;
};

export type HermesRuntimeClient = {
  runAttempt(params: AgentHarnessAttemptParams): Promise<HermesRunResponse>;
};

export function createHermesRuntimeClient(options: {
  config: HermesPluginConfig;
}): HermesRuntimeClient {
  return {
    runAttempt: (params) => runHermesAttempt(options.config, params),
  };
}

async function runHermesAttempt(
  config: HermesPluginConfig,
  params: AgentHarnessAttemptParams,
): Promise<HermesRunResponse> {
  const result = await dispatchToHermes(
    {
      task: params.prompt,
      model: params.modelId,
      timeout: Math.max(1, Math.ceil(params.timeoutMs / 1000)),
    },
    {
      config,
      workspaceDir: params.workspaceDir,
      logger: {
        info: (msg, ...args) => console.log(`[hermes] ${msg}`, ...args),
        warn: (msg, ...args) => console.warn(`[hermes] ${msg}`, ...args),
        error: (msg, ...args) => console.error(`[hermes] ${msg}`, ...args),
      },
    },
  );

  const usage =
    result.tokensUsed > 0
      ? {
          input: 0,
          output: result.tokensUsed,
          total: result.tokensUsed,
        }
      : undefined;

  return {
    assistantText: result.result,
    sessionId: params.sessionId,
    ...(usage ? { usage } : {}),
    hadPotentialSideEffects: result.status === "success",
    replaySafe: result.status !== "success",
  };
}
