declare module "openclaw/plugin-sdk/plugin-entry" {
  export type ProviderRuntimeModel = Record<string, unknown>;
}

declare module "openclaw/plugin-sdk/provider-model-shared" {
  export type ModelDefinitionConfig = {
    id: string;
    name: string;
    api: string;
    reasoning?: boolean;
    input?: string[];
    cost?: Record<string, number>;
    contextWindow?: number;
    maxTokens?: number;
    compat?: Record<string, unknown>;
  };
  export type ProviderPlugin = Record<string, unknown>;
  export function normalizeModelCompat<T>(value: T): T;
}

declare module "openclaw/plugin-sdk/agent-harness" {
  export type AgentHarnessAttemptParams = {
    prompt: string;
    modelId?: string;
    timeoutMs: number;
    workspaceDir: string;
    sessionId?: string;
    bootstrapPromptWarningSignaturesSeen?: string[];
    bootstrapPromptWarningSignature?: string;
    onAssistantMessageStart?: () => void | Promise<void>;
    onPartialReply?: (payload: { text: string }) => void | Promise<void>;
  };
  export type AgentHarnessAttemptResult = Record<string, unknown>;
  export type AgentHarnessCompactResult = {
    ok: boolean;
    compacted: boolean;
    reason?: string;
  };
  export type AgentHarness = {
    id: string;
    label: string;
    supports: (ctx: { provider: string; modelId?: string }) => {
      supported: boolean;
      priority?: number;
      reason?: string;
    };
    runAttempt: (params: AgentHarnessAttemptParams) => Promise<AgentHarnessAttemptResult>;
    compact?: () => Promise<AgentHarnessCompactResult>;
    reset?: (params: { sessionFile?: string }) => Promise<void>;
  };
}
