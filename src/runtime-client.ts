import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { assembleProjectedContext, serializeProjectedContextForPrompt } from "./context-assembler.js";
import { buildExecEnv } from "./execenv-builder.js";
import type {
  ContextLevel,
  ExecEnvBuildResult,
  HermesPluginConfig,
  OpenClawAttemptContext,
  OpenClawSkillSnapshot,
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
  projectionVersion: string;
  skillNames: string[];
  skillsHash?: string;
  mcpConfigHash?: string;
  credentialScopeHash?: string;
  extraPromptHash?: string;
  agentId?: string;
}): string {
  // Hash only the dimensions that determine whether an ACP session can be
  // reused: workspace root, runtime cwd, projection schema, and exposed skills.
  return createHash("sha256")
    .update(
      JSON.stringify({
        workspaceDir: input.workspaceDir,
        runtimeExecEnvPath: input.runtimeExecEnvPath,
        projectionVersion: input.projectionVersion,
        skills: input.skillNames,
        skillsHash: input.skillsHash,
        mcpConfigHash: input.mcpConfigHash,
        credentialScopeHash: input.credentialScopeHash,
        extraPromptHash: input.extraPromptHash,
        agentId: input.agentId,
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

function normalizeSkillName(name: string): string {
  return name.trim().toLowerCase();
}

function sanitizeSkillDirName(name: string, used: Set<string>): string {
  const base =
    name
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "skill";
  const safeBase = base.startsWith(".") ? `skill-${base.replace(/^\.+/, "") || "skill"}` : base;
  let candidate = safeBase;
  for (let index = 2; used.has(candidate); index += 1) {
    candidate = `${safeBase}-${index}`;
  }
  used.add(candidate);
  return candidate;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function readSnapshotSkillPath(skill: NonNullable<OpenClawSkillSnapshot["resolvedSkills"]>[number]) {
  const raw = skill.filePath ?? skill.path;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function classifySkill(params: {
  name: string;
  sourcePath?: string;
  config: HermesPluginConfig,
}): Pick<ProjectedSkill, "classification" | "placement" | "mcpTool" | "diagnostics"> {
  const hostBackedNames = new Set(
    [
      ...params.config.skillProjection.hostBackedDenylist,
      ...params.config.skillProjection.hostBackedSkillNames,
    ].map((entry) => normalizeSkillName(entry)),
  );
  const containerEnvNames = new Set(
    params.config.skillProjection.containerEnvSkillNames.map((entry) => normalizeSkillName(entry)),
  );
  const normalized = normalizeSkillName(params.name);
  if (hostBackedNames.has(normalized) || normalized.startsWith("lark-")) {
    return {
      classification: "host-backed",
      placement: "host-backed",
      mcpTool: "openclaw.skill.invoke",
    };
  }
  if (containerEnvNames.has(normalized)) {
    return {
      classification: "container-env-required",
      placement: "container-env-required",
    };
  }
  if (params.sourcePath?.endsWith("/SKILL.md") || params.sourcePath?.endsWith("\\SKILL.md")) {
    return { classification: "projectable-local", placement: "projected-local" };
  }
  return {
    classification: "unsupported",
    placement: "unsupported",
    diagnostics: [`${params.name}: missing readable SKILL.md path`],
  };
}

function resolveSkillsFromSnapshot(
  snapshot: OpenClawSkillSnapshot | undefined,
  config: HermesPluginConfig,
): { skills: ProjectedSkill[]; skillsHash?: string; diagnostics: string[] } | null {
  if (!snapshot) {
    return null;
  }
  const usedTargetNames = new Set<string>();
  const diagnostics: string[] = [];
  const resolvedSkills = snapshot.resolvedSkills ?? [];
  const skills = resolvedSkills.flatMap((skill): ProjectedSkill[] => {
    const name = (skill.name ?? skill.source ?? "").trim();
    if (!name) {
      diagnostics.push("snapshot skill skipped: missing name");
      return [];
    }
    const sourcePath = readSnapshotSkillPath(skill);
    if (sourcePath) {
      try {
        const sourceStat = statSync(sourcePath);
        if (!sourceStat.isFile()) {
          diagnostics.push(`${name}: skill path is not a file: ${sourcePath}`);
        }
      } catch {
        diagnostics.push(`${name}: skill file not readable: ${sourcePath}`);
      }
    }
    const classification = classifySkill({ name, sourcePath, config });
    const targetDirName = sanitizeSkillDirName(name, usedTargetNames);
    const entry: ProjectedSkill = {
      name,
      path: sourcePath ?? "",
      ...(skill.description ? { description: skill.description } : {}),
      ...(sourcePath ? { sourcePath } : {}),
      ...classification,
    };
    if (classification.placement === "projected-local") {
      entry.path = sourcePath ?? "";
      entry.runtimePath = targetDirName;
    }
    return [entry];
  });
  const fallbackSkills = snapshot.skills ?? [];
  if (skills.length === 0 && fallbackSkills.length > 0) {
    for (const skill of fallbackSkills) {
      const name = skill.name.trim();
      if (!name) {
        continue;
      }
      const classification = classifySkill({ name, config });
      skills.push({
        name,
        path: "",
        requiredEnv: skill.requiredEnv,
        ...classification,
      });
    }
  }
  const skillsHash = hashJson({
    version: snapshot.version,
    skills: skills.map((skill) => ({
      name: skill.name,
      placement: skill.placement,
      sourcePath: skill.sourcePath,
      requiredEnv: skill.requiredEnv,
    })),
  });
  return { skills, skillsHash, diagnostics };
}

function resolveProjectableSkills(
  skills: SkillManifestEntry[],
  config: HermesPluginConfig,
): ProjectedSkill[] {
  const usedTargetNames = new Set<string>();

  return skills.flatMap((skill): ProjectedSkill[] => {
    const classification = classifySkill({
      name: skill.name,
      sourcePath: skill.path,
      config,
    });
    if (classification.placement === "unsupported") {
      return [];
    }
    return [
      {
        ...skill,
        ...classification,
        ...(skill.path ? { sourcePath: skill.path } : {}),
        runtimePath: sanitizeSkillDirName(skill.name, usedTargetNames),
      },
    ];
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
  openClawContext?: OpenClawAttemptContext;
  mcpConfigHash?: string;
  credentialScopeHash?: string;
}): Promise<PreparedExecution> {
  // Step 1: reduce the OpenClaw workspace into the context Hermes actually
  // needs. This is still abstract data and has not been materialized to disk.
  const projectedContext = await assembleProjectedContext(params.task, params.contextLevel, {
    workspaceDir: params.workspaceDir,
    config: params.config,
    includeWorkspaceSkills: params.includeWorkspaceSkills,
    openClawContext: params.openClawContext,
  });
  // Step 2: keep only skills that can be represented as local markdown inside
  // the Hermes execenv. Host-backed skills depend on OpenClaw process state and
  // must not be projected into the container.
  const snapshotSkills = resolveSkillsFromSnapshot(
    params.openClawContext?.skillsSnapshot,
    params.config,
  );
  const projectableSkills =
    snapshotSkills?.skills ?? resolveProjectableSkills(projectedContext.discoveredSkills, params.config);
  const runtimeRoot = buildRuntimeRoot(params.config);
  const sessionAnchor = sanitizeSessionAnchor(params.sessionAnchor ?? params.taskId);
  const runtimeExecEnvPathHint = `${runtimeRoot}/${sessionAnchor}`;
  // The binding hash must be stable before buildExecEnv because session resume
  // and later cache reuse depend on it.
  const sessionBindingHash = computeSessionBindingHash({
    workspaceDir: params.workspaceDir,
    runtimeExecEnvPath: runtimeExecEnvPathHint,
    projectionVersion: params.config.projectionVersion,
    skillNames: projectableSkills.map((skill) => skill.name),
    skillsHash: snapshotSkills?.skillsHash,
    mcpConfigHash: params.mcpConfigHash,
    credentialScopeHash: params.credentialScopeHash,
    extraPromptHash: params.openClawContext?.extraSystemPrompt
      ? createHash("sha256").update(params.openClawContext.extraSystemPrompt).digest("hex")
      : undefined,
    agentId: params.openClawContext?.agentId,
  });
  const execEnv = await buildExecEnv(
    params.config,
    {
      taskId: sessionAnchor,
      workspaceDir: params.workspaceDir,
      contextFiles: projectedContext.files,
      projectedSkills: projectableSkills,
      runtimeConfig: {
        model: params.model ?? params.config.defaultModel ?? "minimax-m2.5",
        contextLevel: params.contextLevel,
        projectionVersion: params.config.projectionVersion,
      },
      openClaw: {
        agentId: params.openClawContext?.agentId,
        skillsSnapshotVersion: params.openClawContext?.skillsSnapshot?.version,
        skillsSource: snapshotSkills ? "snapshot" : "workspace",
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
