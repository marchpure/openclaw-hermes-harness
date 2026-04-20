/**
 * openclaw-plugin-hermes — Type definitions
 *
 * Implements the Three-Dimensional Dispatch Protocol:
 *   Dimension 1: Context Level  (L0–L3) — how much Hermes knows
 *   Dimension 2: Credential Scope (C0–C2) — what services Hermes can access
 *   Dimension 3: Writeback Level (W0–W3) — what gets written back to OpenClaw
 */

// ─── Context Level ──────────────────────────────────────────────────────────

export type ContextLevel = "L0" | "L1" | "L2" | "L3";

export interface ContextLevelSpec {
  level: ContextLevel;
  description: string;
  includes: string[];
}

export const CONTEXT_LEVELS: Record<ContextLevel, ContextLevelSpec> = {
  L0: {
    level: "L0",
    description: "Stateless — task + model config only",
    includes: ["task", "model_config"],
  },
  L1: {
    level: "L1",
    description: "Tools — + tool config, command allowlist, browser config",
    includes: ["task", "model_config", "tool_config", "command_allowlist", "browser_config"],
  },
  L2: {
    level: "L2",
    description: "Context — + adaptive memory, identity, workspace instructions",
    includes: [
      "task",
      "model_config",
      "tool_config",
      "command_allowlist",
      "browser_config",
      "memory",
      "identity",
      "agents_md",
    ],
  },
  L3: {
    level: "L3",
    description: "Full Sync — + skills, MCP definitions, cron definitions",
    includes: [
      "task",
      "model_config",
      "tool_config",
      "command_allowlist",
      "browser_config",
      "memory",
      "identity",
      "agents_md",
      "skills",
      "mcp_servers",
      "cron_definitions",
    ],
  },
};

// ─── Credential Scope ───────────────────────────────────────────────────────

export type CredentialScopeMode = "none" | "specified" | "all";

export interface CredentialScope {
  mode: CredentialScopeMode;
  /** Only used when mode = "specified" */
  keys?: string[];
}

export const CREDENTIAL_SCOPES = {
  C0: { mode: "none" as const },
  C1: (keys: string[]): CredentialScope => ({ mode: "specified", keys }),
  C2: { mode: "all" as const },
};

// ─── Writeback Level ────────────────────────────────────────────────────────

export type WritebackLevel = "W0" | "W1" | "W2" | "W3";

export interface WritebackSpec {
  level: WritebackLevel;
  description: string;
  actions: string[];
}

export const WRITEBACK_LEVELS: Record<WritebackLevel, WritebackSpec> = {
  W0: {
    level: "W0",
    description: "None — pure query, no writeback",
    actions: [],
  },
  W1: {
    level: "W1",
    description: "Result — return execution result text only",
    actions: ["return_result"],
  },
  W2: {
    level: "W2",
    description: "Memory — + update OpenClaw memory",
    actions: ["return_result", "update_memory"],
  },
  W3: {
    level: "W3",
    description: "Full — + create skills, cron, config (requires user confirmation)",
    actions: ["return_result", "update_memory", "create_skills", "update_cron", "update_config"],
  },
};

// ─── Strategy Triple ────────────────────────────────────────────────────────

export interface StrategyTriple {
  context: ContextLevel;
  credential: CredentialScope;
  writeback: WritebackLevel;
  confidence: number; // 0.0 – 1.0
  reasoning: string;
}

// ─── Dispatch Request / Result ──────────────────────────────────────────────

export interface FileAttachment {
  name: string;
  content: string;
  encoding?: "utf8" | "base64";
  mimeType?: string;
}

export interface DispatchRequest {
  task: string;
  contextLevel?: ContextLevel;
  credentialScope?: CredentialScope;
  writeback?: WritebackLevel;
  model?: string;
  tools?: string[];
  timeout?: number;
  files?: FileAttachment[];
  /** If set, skip auto-strategy and use these exact values */
  explicitStrategy?: boolean;
  /**
   * OpenClaw's prepared attempt context when Hermes is selected as an
   * Agent Harness runtime. This context is agent-scoped and must not be
   * inferred from the plugin registration workspace.
   */
  openClawContext?: OpenClawAttemptContext;
}

export interface Artifact {
  name: string;
  path: string;
  mimeType?: string;
  size?: number;
}

export interface MemoryUpdate {
  target: "MEMORY.md" | "daily";
  content: string;
  action: "append" | "replace";
}

export interface DispatchResult {
  status: "success" | "error" | "timeout" | "cancelled";
  result: string;
  artifacts?: Artifact[];
  memoryUpdates?: MemoryUpdate[];
  skillsCreated?: string[];
  tokensUsed: number;
  duration: number;
  strategy: StrategyTriple;
}

// ─── Plugin Config ──────────────────────────────────────────────────────────

export type TransportMode = "tcp" | "stdio";

export interface HermesPluginConfig {
  hermesCommand?: string;
  hermesContainerName: string;
  hermesDataDir?: string;
  /** Execution cwd inside Hermes. Use "/tmp" to keep OpenClaw workspace files read-only by default. */
  runtimeCwd: string;
  /** Transport mode: "tcp" (recommended) or "stdio" (docker exec). Default: "tcp" */
  transport: TransportMode;
  /** TCP host for Hermes ACP bridge. Default: "127.0.0.1" */
  tcpHost: string;
  /** TCP port for Hermes ACP bridge. Default: 3100 */
  tcpPort: number;
  /** Enable the host-side read-only capability bridge used by openclaw-host-tool. */
  hostBridgeEnabled: boolean;
  /** Host interface for the host capability bridge. Default: 127.0.0.1. */
  hostBridgeHost: string;
  /** Port for the host capability bridge. Default: 3199. */
  hostBridgePort: number;
  defaultModel?: string;
  defaultContextLevel: ContextLevel;
  defaultCredentialScope: CredentialScopeMode;
  defaultWriteback: WritebackLevel;
  timeout: number;
  autoStrategy: boolean;
  /** 是否启用分层协议（L/C/W），关闭后直接派发任务 */
  enableLayeredProtocol: boolean;
}

export const DEFAULT_CONFIG: HermesPluginConfig = {
  hermesContainerName: "hermes-agent",
  runtimeCwd: "/tmp",
  transport: "tcp",
  tcpHost: "127.0.0.1",
  tcpPort: 3100,
  hostBridgeEnabled: true,
  hostBridgeHost: "127.0.0.1",
  hostBridgePort: 3199,
  defaultContextLevel: "L1",
  defaultCredentialScope: "none",
  defaultWriteback: "W1",
  timeout: 1800,
  autoStrategy: true,
  enableLayeredProtocol: true,
};

// ─── ACP Protocol Types ─────────────────────────────────────────────────────

export interface AcpJsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
  id: number;
}

export interface AcpJsonRpcResponse {
  jsonrpc: "2.0";
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id: number | null;
}

export interface AcpSessionEvent {
  type: "text" | "thinking" | "tool_progress" | "tool_result" | "done" | "error";
  text?: string;
  toolName?: string;
  toolCallId?: string;
  message?: string;
}

// ─── Context Payload ────────────────────────────────────────────────────────

export interface ContextPayload {
  task: string;
  openClaw?: {
    agentId?: string;
    agentDir?: string;
    extraSystemPrompt?: string;
    skillsPrompt?: string;
    toolsAllow?: string[];
    bootstrapContextMode?: "full" | "lightweight";
    bootstrapContextRunKind?: "default" | "heartbeat" | "cron";
  };
  modelConfig?: {
    model: string;
    provider?: string;
    baseUrl?: string;
  };
  toolConfig?: {
    enabledToolsets?: string[];
    commandAllowlist?: string[];
    browserConfig?: Record<string, unknown>;
  };
  memory?: {
    longTerm?: string;
    daily?: string;
    summary?: string;
  };
  identity?: {
    soul?: string;
    user?: string;
    agents?: string;
  };
  skills?: Array<{ name: string; path: string; description?: string }>;
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  cronDefinitions?: Array<{ schedule: string; task: string; enabled: boolean }>;
}

export interface OpenClawSkillSnapshot {
  prompt?: string;
  skills?: Array<{
    name: string;
    primaryEnv?: string;
    requiredEnv?: string[];
  }>;
  resolvedSkills?: Array<{
    name?: string;
    description?: string;
    path?: string;
    source?: string;
  }>;
  skillFilter?: string[];
  version?: number;
}

export interface OpenClawAttemptContext {
  agentId?: string;
  agentDir?: string;
  config?: unknown;
  skillsSnapshot?: OpenClawSkillSnapshot;
  extraSystemPrompt?: string;
  toolsAllow?: string[];
  bootstrapContextMode?: "full" | "lightweight";
  bootstrapContextRunKind?: "default" | "heartbeat" | "cron";
}

// ─── Credential Entry ───────────────────────────────────────────────────────

export interface CredentialEntry {
  key: string;
  envVar: string;
  value: string;
  source: string;
}

export interface CredentialInjectionResult {
  injected: CredentialEntry[];
  envVars: Record<string, string>;
  auditLog: string[];
}

// ─── Health ─────────────────────────────────────────────────────────────────

export interface HealthReport {
  healthy: boolean;
  containerRunning: boolean;
  acpResponsive: boolean;
  hostBridgeAvailable: boolean;
  larkDocsSearchAvailable: boolean;
  larkDocsFetchAvailable: boolean;
  hermesVersion?: string;
  containerStats?: {
    cpuPercent: string;
    memUsage: string;
    memLimit: string;
  };
  errors: string[];
}
