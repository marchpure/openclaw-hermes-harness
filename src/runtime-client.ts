import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { assembleProjectedContext, serializeProjectedContextForPrompt } from "./context-assembler.js";
import { buildExecEnv } from "./execenv-builder.js";
import { classifyWorkspaceSkills } from "./skill-classifier.js";
import type {
  ContextLevel,
  ExecEnvBuildResult,
  HermesPluginConfig,
  ProjectedContext,
  ProjectedSkill,
} from "./types.js";

export interface PreparedExecution {
  execEnv: ExecEnvBuildResult;
  projectedContext: ProjectedContext;
  exposedSkills: ProjectedSkill[];
  bootstrapPrompt: string;
  sessionBindingHash: string;
  sessionAnchor: string;
}

export interface SessionBindingRecord {
  sessionId: string;
  runtimeExecEnvPath: string;
  bindingHash: string;
}

const sessionBindings = new Map<string, SessionBindingRecord>();

function resolveOpenClawStateDir(): string {
  const configured = process.env.OPENCLAW_STATE_DIR?.trim();
  if (configured) return configured;
  return join(homedir(), ".openclaw");
}

function resolveSessionBindingsStorePath(): string {
  return join(resolveOpenClawStateDir(), "hermes", "session-bindings.json");
}

function loadPersistedBindings(): void {
  const storePath = resolveSessionBindingsStorePath();
  if (!existsSync(storePath)) return;
  try {
    const raw = JSON.parse(readFileSync(storePath, "utf8")) as Record<string, SessionBindingRecord>;
    for (const [key, value] of Object.entries(raw)) {
      if (!value || typeof value !== "object") continue;
      if (typeof value.sessionId !== "string" || typeof value.runtimeExecEnvPath !== "string") continue;
      sessionBindings.set(key, value);
    }
  } catch {
    // Ignore corrupt cache; runtime can recreate bindings.
  }
}

function persistBindings(): void {
  const storePath = resolveSessionBindingsStorePath();
  mkdirSync(dirname(storePath), { recursive: true });
  console.log(`[hermes-acp] Persisting session bindings -> ${storePath} (${sessionBindings.size})`);
  writeFileSync(
    storePath,
    JSON.stringify(Object.fromEntries(sessionBindings.entries()), null, 2) + "\n",
    "utf8",
  );
}

loadPersistedBindings();

function computeSessionBindingHash(input: {
  workspaceDir: string;
  runtimeExecEnvPath: string;
  projectionVersion: string;
  skillNames: string[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        workspaceDir: input.workspaceDir,
        runtimeExecEnvPath: input.runtimeExecEnvPath,
        projectionVersion: input.projectionVersion,
        skills: input.skillNames,
      }),
    )
    .digest("hex");
}

function buildRuntimeRoot(config: HermesPluginConfig): string {
  return config.runtimeExecEnvRootDir ??
    config.execEnvRootDir ??
    config.hermesDataDir ??
    "/var/cache/hermes-agent/execenv";
}

function sanitizeSessionAnchor(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120) || "default";
}

export function resolveStableSessionAnchor(params: {
  workspaceDir: string;
  sessionKey?: string;
  sessionFile?: string;
  sessionId?: string;
  agentId?: string;
}): string {
  // OpenClaw CLI/local runs often reuse a broad sessionKey such as
  // `agent:main:main` while still passing a distinct sessionId. Prefer the
  // explicit session identity so Hermes does not resume unrelated ACP turns
  // into the same projected execenv.
  const raw =
    params.sessionId?.trim() ||
    params.sessionFile?.trim() ||
    params.sessionKey?.trim() ||
    params.agentId?.trim() ||
    params.workspaceDir;

  return sanitizeSessionAnchor(
    createHash("sha256")
      .update(raw)
      .digest("hex"),
  );
}

export async function prepareProjectedExecutionEnv(params: {
  task: string;
  taskId: string;
  workspaceDir: string;
  contextLevel: ContextLevel;
  includeWorkspaceSkills?: boolean;
  model?: string;
  config: HermesPluginConfig;
  sessionAnchor?: string;
}): Promise<PreparedExecution> {
  const projectedContext = await assembleProjectedContext(params.task, params.contextLevel, {
    workspaceDir: params.workspaceDir,
    config: params.config,
    includeWorkspaceSkills: params.includeWorkspaceSkills,
  });
  const classifiedSkills = classifyWorkspaceSkills(projectedContext.discoveredSkills, params.config);
  const runtimeRoot = buildRuntimeRoot(params.config);
  const sessionAnchor = sanitizeSessionAnchor(params.sessionAnchor ?? params.taskId);
  const runtimeExecEnvPathHint = `${runtimeRoot}/${sessionAnchor}`;
  const sessionBindingHash = computeSessionBindingHash({
    workspaceDir: params.workspaceDir,
    runtimeExecEnvPath: runtimeExecEnvPathHint,
    projectionVersion: params.config.projectionVersion,
    skillNames: classifiedSkills.projectableLocalSkills.map((skill) => skill.name),
  });
  const execEnv = await buildExecEnv(
    params.config,
    {
      taskId: sessionAnchor,
      workspaceDir: params.workspaceDir,
      runtimeRootDir: runtimeRoot,
      contextFiles: projectedContext.files,
      projectedSkills: classifiedSkills.projectableLocalSkills,
      runtimeConfig: {
        model: params.model ?? params.config.defaultModel ?? "minimax-m2.5",
        contextLevel: params.contextLevel,
        projectionVersion: params.config.projectionVersion,
      },
    },
    sessionBindingHash,
  );

  return {
    execEnv,
    projectedContext,
    exposedSkills: execEnv.projectedSkills,
    bootstrapPrompt: serializeProjectedContextForPrompt(projectedContext, execEnv.projectedSkills, {
      runtimeCwd: execEnv.runtimeExecEnvPath,
      projectionPath: `${execEnv.runtimeExecEnvPath}/projection.json`,
    }),
    sessionBindingHash,
    sessionAnchor,
  };
}

export function readSessionBinding(bindingHash: string): SessionBindingRecord | undefined {
  return sessionBindings.get(bindingHash);
}

export function writeSessionBinding(bindingHash: string, record: SessionBindingRecord): void {
  sessionBindings.set(bindingHash, record);
  console.log(
    `[hermes-acp] writeSessionBinding hash=${bindingHash.slice(0, 12)} session=${record.sessionId} cwd=${record.runtimeExecEnvPath}`,
  );
  persistBindings();
}

export function clearSessionBinding(bindingHash: string): void {
  sessionBindings.delete(bindingHash);
  console.log(`[hermes-acp] clearSessionBinding hash=${bindingHash.slice(0, 12)}`);
  persistBindings();
}
