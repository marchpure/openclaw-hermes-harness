import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  assembleProjectedContext,
  readSkillsManifest,
  serializeProjectedContextForPrompt,
} from "./context-assembler.js";
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
  projectionVersion: string;
  skillNames: string[];
  skillsHash?: string;
  mcpConfigHash?: string;
  credentialScopeHash?: string;
  extraPromptHash?: string;
  agentId?: string;
  sessionAnchor?: string;
}): string {
  // Hash only the dimensions that determine whether an ACP session can be
  // reused: workspace root, runtime cwd, projection schema, exposed skills,
  // and the explicit OpenClaw session identity.
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
        sessionAnchor: input.sessionAnchor,
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

function isFeishuOrLarkSkillName(name: string): boolean {
  const normalized = normalizeSkillName(name);
  return normalized === "feishu" ||
    normalized === "lark" ||
    normalized.startsWith("feishu-") ||
    normalized.startsWith("feishu_") ||
    normalized.startsWith("lark-") ||
    normalized.startsWith("lark_");
}

const HOST_BACKED_MCP_TOOL_HINTS: Record<string, { tool: string; hint: string }> = {
  browser: {
    tool: "mcp_openclaw_browser",
    hint: "Use the OpenClaw MCP `mcp_openclaw_browser` tool for status/start/open/snapshot/screenshot/actions.",
  },
  "browser-use": {
    tool: "mcp_openclaw_browser",
    hint: "Use the OpenClaw MCP `mcp_openclaw_browser` tool; read the projected browser-use SKILL.md when it is available for operating rules.",
  },
  "byted-web-search": {
    tool: "mcp_openclaw_byted_web_search",
    hint: "Use the OpenClaw MCP `mcp_openclaw_byted_web_search` tool for Volcano Engine web/image search. It runs host-backed so API credentials stay in the OpenClaw gateway environment.",
  },
  web_search: {
    tool: "mcp_openclaw_byted_web_search",
    hint: "Use the OpenClaw MCP `mcp_openclaw_byted_web_search` tool for web/image search when available.",
  },
  "computer-use": {
    tool: "mcp_openclaw_computer_use",
    hint: "Use the OpenClaw MCP `mcp_openclaw_computer_use` tool for host-backed CUA tasks. Use `mcp_openclaw_browser` for browser-only operations.",
  },
  "arkdrive-netdisk": {
    tool: "mcp_openclaw_arkdrive_netdisk",
    hint: "Use the OpenClaw MCP `mcp_openclaw_arkdrive_netdisk` tool for ArkDrive status, listing, directory creation, and text writes. Do not run the projected ArkDrive script inside the Hermes container because FUSE mount state is host-scoped.",
  },
  "workspace-netdrive": {
    tool: "mcp_openclaw_arkdrive_netdisk",
    hint: "Use the OpenClaw MCP `mcp_openclaw_arkdrive_netdisk` tool for workspace netdisk operations.",
  },
  feishu: {
    tool: "mcp_openclaw_feishu_*",
    hint: "Use the concrete OpenClaw MCP Feishu tools exposed in tools/list. Common names include `mcp_openclaw_feishu_doc` with action `read`, or openclaw-lark tools such as `mcp_openclaw_feishu_fetch_doc`, `mcp_openclaw_feishu_create_doc`, and `mcp_openclaw_feishu_update_doc` when those are present.",
  },
  "lark-doc": {
    tool: "mcp_openclaw_feishu_*",
    hint: "Use the concrete OpenClaw MCP Feishu document tool exposed in tools/list. Prefer `mcp_openclaw_feishu_doc` with action `read` for stock OpenClaw, or `mcp_openclaw_feishu_fetch_doc` when the openclaw-lark bridge exposes it.",
  },
  "lark-calendar": {
    tool: "mcp_openclaw_feishu_*",
    hint: "Use the OpenClaw MCP Feishu calendar tools exposed in the current tool list.",
  },
  "lark-im": {
    tool: "mcp_openclaw_message / mcp_openclaw_feishu_*",
    hint: "Use the OpenClaw MCP `mcp_openclaw_message` tool for channel replies/sends and Feishu IM tools for Feishu-specific operations.",
  },
  "lark-sheets": {
    tool: "mcp_openclaw_feishu_*",
    hint: "Use the OpenClaw MCP Feishu spreadsheet tools exposed in the current tool list.",
  },
  "lark-base": {
    tool: "mcp_openclaw_feishu_*",
    hint: "Use the OpenClaw MCP Feishu Base tools exposed in the current tool list.",
  },
  "lark-drive": {
    tool: "mcp_openclaw_feishu_*",
    hint: "Use the OpenClaw MCP Feishu Drive tools exposed in the current tool list.",
  },
  "lark-task": {
    tool: "mcp_openclaw_feishu_*",
    hint: "Use the OpenClaw MCP Feishu task tools exposed in the current tool list.",
  },
  "lark-mail": {
    tool: "mcp_openclaw_feishu_*",
    hint: "Use the OpenClaw MCP Feishu mail tools exposed in the current tool list.",
  },
};

function resolveHostBackedMcpHint(name: string): { mcpTool: string; mcpToolHint: string } {
  const normalized = normalizeSkillName(name);
  const entry =
    HOST_BACKED_MCP_TOOL_HINTS[normalized] ??
    (isFeishuOrLarkSkillName(normalized) ? HOST_BACKED_MCP_TOOL_HINTS["lark-doc"] : undefined);
  return {
    mcpTool: entry?.tool ?? "OpenClaw MCP tools",
    mcpToolHint:
      entry?.hint ??
      "Use the concrete OpenClaw MCP tool exposed in the current tool list for this capability; do not call `openclaw.skill.invoke`.",
  };
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

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function getSkillAliasNames(name: string): string[] {
  const aliases: Record<string, string[]> = {
    browser: ["browser-use"],
    "browser-use": ["browser"],
    "byted-web-search": ["web_search"],
    web_search: ["byted-web-search"],
    "byted-seedream-image-generate": ["image-generate"],
    "image-generate": ["byted-seedream-image-generate"],
    "byted-seedance-video-generate": ["video-generate"],
    "video-generate": ["byted-seedance-video-generate"],
    "arkdrive-netdisk": ["workspace-netdrive"],
    "workspace-netdrive": ["arkdrive-netdisk"],
    opencli: ["OpenCLI"],
  };
  return aliases[normalizeSkillName(name)] ?? [];
}

function containsSymlinkSync(path: string): boolean {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return true;
    if (!info.isDirectory()) return false;
    return readdirSync(path).some((entry) => containsSymlinkSync(join(path, entry)));
  } catch {
    return true;
  }
}

function isProjectableSkillSource(path: string): boolean {
  return !containsSymlinkSync(dirname(path));
}

function readSnapshotSkillPath(skill: NonNullable<OpenClawSkillSnapshot["resolvedSkills"]>[number]) {
  const raw = skill.filePath ?? skill.path;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function classifySkill(params: {
  name: string;
  sourcePath?: string;
  config: HermesPluginConfig;
}): Pick<ProjectedSkill, "classification" | "placement" | "requiredEnv" | "mcpTool" | "mcpToolHint" | "diagnostics"> {
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
  if (hostBackedNames.has(normalized) || isFeishuOrLarkSkillName(normalized)) {
    const mcpHint = resolveHostBackedMcpHint(params.name);
    return {
      classification: "host-backed",
      placement: "host-backed",
      ...mcpHint,
    };
  }
  if (containerEnvNames.has(normalized)) {
    return {
      classification: "container-env-required",
      placement: "container-env-required",
      requiredEnv: normalized === "byted-web-search"
        ? ["WEB_SEARCH_API_KEY", "VOLCENGINE_ACCESS_KEY", "VOLCENGINE_SECRET_KEY", "VOLCENGINE_SESSION_TOKEN"]
        : undefined,
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
    if (classification.placement === "projected-local" || classification.placement === "container-env-required") {
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

async function mergeAlwaysExposeSkills(
  skills: ProjectedSkill[],
  workspaceDir: string,
  config: HermesPluginConfig,
): Promise<ProjectedSkill[]> {
  const requestedNames = config.skillProjection.alwaysExposeSkillNames
    .map((name) => name.trim())
    .filter(Boolean);
  if (requestedNames.length === 0) {
    return skills;
  }

  const manifest = [
    ...(await readSkillsManifest(join(workspaceDir, "skills"))),
    ...(await readSkillsManifest(join(resolveOpenClawStateDir(), "workspace", "skills"))),
  ];
  const manifestByName = new Map(manifest.map((skill) => [normalizeSkillName(skill.name), skill]));
  const existingNames = new Set(
    skills.flatMap((skill) => [
      normalizeSkillName(skill.name),
      ...getSkillAliasNames(skill.name).map(normalizeSkillName),
    ]),
  );
  const usedTargetNames = new Set(
    skills
      .map((skill) => skill.runtimePath)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );

  const additions: ProjectedSkill[] = [];
  for (const requestedName of requestedNames) {
    const candidates = [requestedName, ...getSkillAliasNames(requestedName)];
    if (candidates.some((candidate) => existingNames.has(normalizeSkillName(candidate)))) {
      continue;
    }

    const manifestSkill = candidates
      .map((candidate) => manifestByName.get(normalizeSkillName(candidate)))
      .find((candidate): candidate is SkillManifestEntry =>
        Boolean(candidate?.path && isProjectableSkillSource(candidate.path)),
      );
    if (!manifestSkill) {
      continue;
    }

    const classification = classifySkill({
      name: manifestSkill.name,
      sourcePath: manifestSkill.path,
      config,
    });
    if (classification.placement === "unsupported") {
      continue;
    }

    additions.push({
      ...manifestSkill,
      ...classification,
      sourcePath: manifestSkill.path,
      runtimePath: sanitizeSkillDirName(manifestSkill.name, usedTargetNames),
    });
    existingNames.add(normalizeSkillName(manifestSkill.name));
    for (const alias of getSkillAliasNames(manifestSkill.name)) {
      existingNames.add(normalizeSkillName(alias));
    }
  }

  return additions.length > 0 ? [...skills, ...additions] : skills;
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
  const selectedSkills =
    snapshotSkills?.skills ?? resolveProjectableSkills(projectedContext.discoveredSkills, params.config);
  const projectableSkills = await mergeAlwaysExposeSkills(
    selectedSkills,
    params.workspaceDir,
    params.config,
  );
  const runtimeRoot = buildRuntimeRoot(params.config);
  const sessionAnchor = sanitizeSessionAnchor(params.sessionAnchor ?? params.taskId);
  const runtimeExecEnvPathHint = `${runtimeRoot}/${sessionAnchor}`;
  const resolvedModel = resolveRuntimeModel(params.model, params.config);
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
    sessionAnchor,
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
