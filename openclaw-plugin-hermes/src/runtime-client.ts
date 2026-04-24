import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { assembleProjectedContext, serializeProjectedContextForPrompt } from "./context-assembler.js";
import { buildExecEnv } from "./execenv-builder.js";
import type {
  ContextLevel,
  ExecEnvBuildResult,
  HermesPluginConfig,
  ProjectedContext,
  ProjectedSkill,
  SkillManifestEntry,
} from "./types.js";

export interface PreparedExecution {
  execEnv: ExecEnvBuildResult;
  projectedContext: ProjectedContext;
  exposedSkills: ProjectedSkill[];
  bootstrapPrompt: string;
  sessionBindingHash: string;
  sessionAnchor: string;
  conversationHistory?: string;
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
    // Session bindings are cross-process cache state. After plugin restarts we
    // still want to resume the same Hermes ACP session and stable execenv.
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
  model: string;
  projectionVersion: string;
  skillNames: string[];
}): string {
  // Hash only the dimensions that determine whether an ACP session can be
  // reused: workspace root, runtime cwd, projection schema, and exposed skills.
  return createHash("sha256")
    .update(
      JSON.stringify({
        workspaceDir: input.workspaceDir,
        runtimeExecEnvPath: input.runtimeExecEnvPath,
        model: input.model,
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

function resolveRuntimeModel(model: string | undefined, config: HermesPluginConfig): string {
  const requested = model?.trim();
  if (requested && requested !== "default") {
    return requested;
  }
  return config.defaultModel ?? "minimax-m2.5";
}

function sanitizeSessionAnchor(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120) || "default";
}

function normalizeSkillName(name: string): string {
  return name.trim().toLowerCase();
}

function resolveProjectableSkills(
  skills: SkillManifestEntry[],
  config: HermesPluginConfig,
): ProjectedSkill[] {
  const hostBackedNames = new Set(
    config.skillProjection.hostBackedDenylist.map((entry) => normalizeSkillName(entry)),
  );

  return skills.flatMap((skill): ProjectedSkill[] => {
    const normalized = normalizeSkillName(skill.name);
    if (hostBackedNames.has(normalized)) {
      return [];
    }

    if (skill.path?.endsWith("/SKILL.md") || skill.path?.endsWith("\\SKILL.md")) {
      return [
        {
          ...skill,
          classification: "projectable-local",
          sourcePath: skill.path,
        },
      ];
    }

    return [];
  });
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
  conversationHistory?: string;
}): Promise<PreparedExecution> {
  // Step 1: reduce the OpenClaw workspace into the context Hermes actually
  // needs. This is still abstract data and has not been materialized to disk.
  const projectedContext = await assembleProjectedContext(params.task, params.contextLevel, {
    workspaceDir: params.workspaceDir,
    config: params.config,
    includeWorkspaceSkills: params.includeWorkspaceSkills,
  });
  // Step 2: keep only skills that can be represented as local markdown inside
  // the Hermes execenv. Host-backed skills depend on OpenClaw process state and
  // must not be projected into the container.
  const projectableSkills = resolveProjectableSkills(projectedContext.discoveredSkills, params.config);
  const runtimeRoot = buildRuntimeRoot(params.config);
  const sessionAnchor = sanitizeSessionAnchor(params.sessionAnchor ?? params.taskId);
  const runtimeExecEnvPathHint = `${runtimeRoot}/${sessionAnchor}`;
  const resolvedModel = resolveRuntimeModel(params.model, params.config);
  // The binding hash must be stable before buildExecEnv because session resume
  // and later cache reuse depend on it.
  const sessionBindingHash = computeSessionBindingHash({
    workspaceDir: params.workspaceDir,
    runtimeExecEnvPath: runtimeExecEnvPathHint,
    model: resolvedModel,
    projectionVersion: params.config.projectionVersion,
    skillNames: projectableSkills.map((skill) => skill.name),
  });
  const execEnv = await buildExecEnv(
    params.config,
    {
      taskId: sessionAnchor,
      workspaceDir: params.workspaceDir,
      contextFiles: projectedContext.files,
      projectedSkills: projectableSkills,
      runtimeConfig: {
        model: resolvedModel,
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
    // bootstrapPrompt is Hermes' real entry text. It ties together projection
    // metadata, runtime cwd, visible skills, and workspace context files.
    bootstrapPrompt: serializeProjectedContextForPrompt(projectedContext, execEnv.projectedSkills, {
      runtimeCwd: execEnv.runtimeExecEnvPath,
      projectionPath: `${execEnv.runtimeExecEnvPath}/projection.json`,
      conversationHistory: params.conversationHistory,
    }),
    sessionBindingHash,
    sessionAnchor,
    conversationHistory: params.conversationHistory,
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
