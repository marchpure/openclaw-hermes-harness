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
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    total_tokens?: number;
  };
  duration: number;
  strategy: StrategyTriple;
}

// ─── Plugin Config ──────────────────────────────────────────────────────────

export type ProjectedCapabilityClass =
  | "projectable-local"
  | "container-env-required"
  | "host-backed"
  | "unsupported";

export type SkillExecutionPlacement =
  | "projected-local"
  | "host-backed"
  | "container-env-required"
  | "unsupported";

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
    filePath?: string;
    path?: string;
    source?: string;
  }>;
  skillFilter?: string[];
  version?: number;
}

export interface OpenClawAttemptContext {
  agentId?: string;
  skillsSnapshot?: OpenClawSkillSnapshot;
  extraSystemPrompt?: string;
  bootstrapContextMode?: string;
}

export interface HermesPluginConfig {
  hermesContainerName: string;
  hermesDataDir?: string;
  /** Host root dir for task-scoped execution envs. Defaults under hermesDataDir. */
  execEnvRootDir?: string;
  /** Runtime-visible root dir for task-scoped execution envs. Defaults to execEnvRootDir. */
  runtimeExecEnvRootDir?: string;
  /** If true, mirror host execenvs into the Hermes Docker container before ACP turns. */
  mirrorExecEnvToContainer: boolean;
  /** Stable schema/version marker used in session binding hashes. */
  projectionVersion: string;
  /** The local Hermes bridge is TCP-only in the current OpenClaw deployment. */
  transport: "tcp";
  /** TCP host for the local Hermes ACP bridge. */
  tcpHost: string;
  /** TCP port for the local Hermes ACP bridge. */
  tcpPort: number;
  defaultModel?: string;
  defaultContextLevel: ContextLevel;
  runtimeMinContextLevel: ContextLevel;
  runtimeProjectWorkspaceSkills: boolean;
  defaultCredentialScope: CredentialScopeMode;
  defaultWriteback: WritebackLevel;
  timeout: number;
  autoStrategy: boolean;
  /** Enable the layered L/C/W dispatch path. Disabled means direct dispatch. */
  enableLayeredProtocol: boolean;
  skillProjection: {
    hostBackedDenylist: string[];
    hostBackedSkillNames: string[];
    containerEnvSkillNames: string[];
    alwaysExposeSkillNames: string[];
  };
  mcpBridge: {
    enabled: boolean;
    servers: Record<string, unknown>;
    env: Record<string, string>;
  };
  execEnvCleanup: {
    enabled: boolean;
    maxAgeHours: number;
    maxCount: number;
  };
  otel?: {
    endpoint?: string;
    serviceName?: string;
  };
}

export const DEFAULT_CONFIG: HermesPluginConfig = {
  hermesContainerName: "hermes-agent",
  transport: "tcp",
  tcpHost: "127.0.0.1",
  tcpPort: 3100,
  projectionVersion: "c1c2-v1",
  runtimeExecEnvRootDir: "/tmp/openclaw-hermes-execenv",
  mirrorExecEnvToContainer: true,
  defaultContextLevel: "L1",
  runtimeMinContextLevel: "L2",
  runtimeProjectWorkspaceSkills: true,
  defaultCredentialScope: "none",
  defaultWriteback: "W1",
  timeout: 1800,
  autoStrategy: true,
  enableLayeredProtocol: true,
  skillProjection: {
    hostBackedDenylist: ["browser", "browser-use", "feishu"],
    hostBackedSkillNames: [
      "lark-doc",
      "lark-calendar",
      "lark-im",
      "lark-sheets",
      "lark-base",
      "lark-drive",
      "lark-task",
      "lark-mail",
      "feishu",
      "feishu-fetch-doc",
      "feishu-create-doc",
      "feishu-update-doc",
      "feishu-calendar",
      "feishu-im-read",
      "feishu-bitable",
      "feishu-task",
      "feishu-troubleshoot",
      "browser",
      "browser-use",
      "computer-use",
      "arkdrive-netdisk",
      "workspace-netdrive",
    ],
    containerEnvSkillNames: ["byted-web-search"],
    alwaysExposeSkillNames: [
      "browser-use",
      "computer-use",
      "byted-web-search",
      "opencli",
      "byted-seedream-image-generate",
      "byted-seedance-video-generate",
      "arkdrive-netdisk",
    ],
  },
  mcpBridge: {
    enabled: false,
    servers: {},
    env: {},
  },
  execEnvCleanup: {
    enabled: true,
    maxAgeHours: 24,
    maxCount: 200,
  },
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
  timestamp?: number;
  text?: string;
  toolName?: string;
  toolTitle?: string;
  toolInput?: unknown;
  toolCallId?: string;
  message?: string;
}

// ─── Context Payload ────────────────────────────────────────────────────────

export interface ContextPayload {
  task: string;
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

// ─── Execution Projection ──────────────────────────────────────────────────

export interface SkillManifestEntry {
  name: string;
  path: string;
  description?: string;
  requiredEnv?: string[];
}

export interface ProjectedSkill extends SkillManifestEntry {
  classification: ProjectedCapabilityClass;
  placement: SkillExecutionPlacement;
  sourcePath?: string;
  projectedPath?: string;
  runtimePath?: string;
  hash?: string;
  mcpTool?: string;
  mcpToolHint?: string;
  diagnostics?: string[];
}

export interface ProjectedContextFiles {
  soul?: string;
  user?: string;
  agent?: string;
  task?: string;
}

export interface ProjectedContext {
  files: ProjectedContextFiles;
  memory?: ContextPayload["memory"];
  commandAllowlist?: string[];
  discoveredSkills: SkillManifestEntry[];
  skillsPrompt?: string;
  skillDiagnostics?: string[];
}

export interface ExecEnvInput {
  taskId: string;
  workspaceDir: string;
  contextFiles: ProjectedContextFiles;
  projectedSkills: ProjectedSkill[];
  runtimeConfig: Record<string, unknown>;
  openClaw?: {
    agentId?: string;
    skillsSnapshotVersion?: number;
    skillsSource?: "snapshot" | "workspace";
  };
}

export interface ExecEnvManifest {
  version: string;
  taskId: string;
  hostWorkspaceDir: string;
  runtimeCwd: string;
  files: {
    soul?: string;
    user?: string;
    agent?: string;
    task?: string;
  };
  skills: ProjectedSkill[];
  openClaw?: {
    agentId?: string;
    skillsSnapshotVersion?: number;
    skillsSource?: "snapshot" | "workspace";
  };
  hashes: {
    workspace: string;
    skills: string;
    projection: string;
    sessionBinding: string;
  };
}

export interface ExecEnvBuildResult {
  hostExecEnvPath: string;
  runtimeExecEnvPath: string;
  manifestPath: string;
  projectedSkills: ProjectedSkill[];
  sessionBindingHash: string;
}

export interface HermesAcpSessionOptions {
  cwd: string;
  mcpServers?: Record<string, unknown>;
  mcpConfigPath?: string;
  env?: Record<string, string>;
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
  hermesVersion?: string;
  containerStats?: {
    cpuPercent: string;
    memUsage: string;
    memLimit: string;
  };
  errors: string[];
}
