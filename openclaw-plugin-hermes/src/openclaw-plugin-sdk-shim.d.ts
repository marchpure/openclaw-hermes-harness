declare module "openclaw/plugin-sdk/plugin-entry" {
  export type ProviderRuntimeModel = {
    id?: string;
    name?: string;
    provider?: string;
    baseUrl?: string;
    api?: string;
    reasoning?: boolean;
    input?: string[];
    contextWindow?: number;
    maxTokens?: number;
    compat?: Record<string, unknown>;
  };
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
  export type ProviderPlugin = {
    id: string;
    label: string;
    docsPath?: string;
    auth?: unknown[];
    catalog?: {
      order?: string;
      run: () => Promise<unknown>;
    };
    resolveDynamicModel?: (ctx: { modelId: string }) => unknown;
    resolveSyntheticAuth?: () => Record<string, unknown>;
    isModernModelRef?: () => boolean;
  };
  export function normalizeModelCompat<T>(value: T): T;
}

declare module "openclaw/plugin-sdk/agent-harness" {
  export type AgentHarnessMessage = Record<string, unknown>;
  export type NormalizedUsage = {
    input: number;
    output: number;
    total: number;
  };
  export type AgentHarnessAttemptParams = {
    prompt: string;
    modelId?: string;
    timeoutMs: number;
    workspaceDir: string;
    sessionId?: string;
    sessionFile?: string;
    runId?: string;
    sessionKey?: string;
    agentId?: string;
    messageChannel?: string;
    messageProvider?: string;
    agentAccountId?: string;
    messageTo?: string;
    messageThreadId?: string | number;
    currentChannelId?: string;
    currentThreadTs?: string;
    currentMessageId?: string | number;
    senderId?: string | null;
    senderIsOwner?: boolean;
    abortSignal?: AbortSignal;
    images?: Array<{ data: string; mimeType: string }>;
    extraSystemPrompt?: string;
    toolsAllow?: string[];
    skillsSnapshot?: {
      prompt?: string;
      skills?: Array<{ name: string; primaryEnv?: string; requiredEnv?: string[] }>;
      resolvedSkills?: Array<{ name?: string; description?: string; path?: string; source?: string }>;
      skillFilter?: string[];
      version?: number;
    };
    config?: unknown;
    model?: { api?: string };
    provider?: string;
    bootstrapPromptWarningSignaturesSeen?: string[];
    bootstrapPromptWarningSignature?: string;
    onAssistantMessageStart?: () => void | Promise<void>;
    onPartialReply?: (payload: { text: string }) => void | Promise<void>;
    onReasoningStart?: () => void | Promise<void>;
    onReasoningStream?: (payload: { text: string }) => void | Promise<void>;
    onReasoningEnd?: () => void | Promise<void>;
    onToolResult?: (payload: { text: string }) => void | Promise<void>;
    onAgentEvent?: (event: { stream: string; data: Record<string, unknown> }) => void | Promise<void>;
  };
  export type AgentHarnessAttemptResult = {
    aborted?: boolean;
    externalAbort?: boolean;
    timedOut?: boolean;
    idleTimedOut?: boolean;
    timedOutDuringCompaction?: boolean;
    promptError?: unknown;
    promptErrorSource?: string | null;
    sessionIdUsed?: string;
    bootstrapPromptWarningSignaturesSeen?: string[];
    bootstrapPromptWarningSignature?: string;
    finalPromptText?: string;
    messagesSnapshot?: AgentHarnessMessage[];
    assistantTexts?: string[];
    toolMetas?: Array<{ toolName: string; meta?: string }>;
    lastAssistant?: AgentHarnessMessage;
    currentAttemptAssistant?: AgentHarnessMessage;
    didSendViaMessagingTool?: boolean;
    messagingToolSentTexts?: string[];
    messagingToolSentMediaUrls?: string[];
    messagingToolSentTargets?: string[];
    cloudCodeAssistFormatError?: boolean;
    attemptUsage?: NormalizedUsage;
    replayMetadata?: {
      hadPotentialSideEffects: boolean;
      replaySafe: boolean;
    };
    itemLifecycle?: {
      startedCount: number;
      completedCount: number;
      activeCount: number;
    };
  };
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

declare module "openclaw/plugin-sdk/agent-harness-runtime" {
  export type AgentHarnessMcpBridge = {
    mcpServers?: Record<string, unknown>;
    env?: Record<string, string>;
    mcpConfigHash?: string;
    mcpResumeHash?: string;
    credentialScopeHash?: string;
  };
  export function prepareAgentHarnessMcpBridge(
    params: {
      enabled?: boolean;
      config?: unknown;
      workspaceDir?: string;
      configuredServers?: Record<string, unknown>;
      configuredEnv?: Record<string, string>;
      sessionKey?: string;
      agentId?: string;
      accountId?: string;
      messageChannel?: string;
      messageProvider?: string;
      messageTo?: string;
      messageThreadId?: string | number;
      currentChannelId?: string;
      currentThreadTs?: string;
      currentMessageId?: string | number;
      requesterSenderId?: string | null;
      senderIsOwner?: boolean;
    },
  ): Promise<AgentHarnessMcpBridge>;
}

declare module "openclaw/plugin-sdk/nostr" {
  export type PluginRuntimeGatewayRequestScope = {
    context?: {
      broadcast: (event: string, payload: unknown, options?: { dropIfSlow?: boolean }) => void;
      nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
      agentRunSeq: Map<string, number>;
    };
    client?: unknown;
    isWebchatConnect: (params: unknown) => boolean;
    pluginId?: string;
  };

  export function getPluginRuntimeGatewayRequestScope():
    | PluginRuntimeGatewayRequestScope
    | undefined;
}
