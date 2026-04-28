/**
 * openclaw-plugin-hermes — Context Assembler
 *
 * Builds the context payload for Hermes based on the requested context level.
 * Each level is additive: L3 ⊃ L2 ⊃ L1 ⊃ L0.
 *
 * L0: task + model config
 * L1: + tool config, command allowlist, browser config
 * L2: + adaptive memory, identity (SOUL/USER), AGENTS.md
 * L3: + skills manifest, MCP server definitions, cron definitions
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  ContextLevel,
  ContextPayload,
  HermesPluginConfig,
  OpenClawAttemptContext,
  ProjectedContext,
  ProjectedSkill,
  SkillManifestEntry,
} from "./types.js";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Token threshold for memory summarization (approx 2K tokens ≈ 5500 chars) */
const MEMORY_FULL_THRESHOLD_CHARS = 5500;

// ─── Helpers ────────────────────────────────────────────────────────────────

async function readFileIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  const content = await readFileIfExists(path);
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Rough token estimate: ~2.75 chars per token for mixed CJK/English.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2.75);
}

/**
 * Summarize memory to fit within token budget.
 * Keeps the most recent entries and truncates older content.
 */
function adaptiveMemorySummary(fullMemory: string, maxChars: number): string {
  if (fullMemory.length <= maxChars) return fullMemory;

  // Split by sections (## headers)
  const sections = fullMemory.split(/(?=^## )/m);
  if (sections.length <= 1) {
    return fullMemory.slice(-maxChars);
  }

  // Keep the header (first section) and as many recent sections as fit
  const header = sections[0];
  const body = sections.slice(1);
  let result = header;
  const remaining = maxChars - header.length;

  // Take from the end (most recent first)
  const kept: string[] = [];
  let used = 0;
  for (let i = body.length - 1; i >= 0; i--) {
    if (used + body[i].length > remaining) break;
    kept.unshift(body[i]);
    used += body[i].length;
  }

  if (kept.length < body.length) {
    result += `\n> [${body.length - kept.length} older sections omitted]\n`;
  }
  result += kept.join("");
  return result;
}

// ─── Context Assembly ───────────────────────────────────────────────────────

export interface AssemblerOptions {
  workspaceDir: string;
  config: HermesPluginConfig;
  includeWorkspaceSkills?: boolean;
  openClawContext?: OpenClawAttemptContext;
}

/**
 * Assemble context payload for a given level.
 */
export async function assembleContext(
  task: string,
  level: ContextLevel,
  options: AssemblerOptions,
): Promise<ContextPayload> {
  const { workspaceDir, config, includeWorkspaceSkills = false } = options;
  const payload: ContextPayload = { task };

  // ── L0: Task + Model Config ───────────────────────────────────────────

  payload.modelConfig = {
    model: config.defaultModel ?? "minimax-m2.5",
  };

  if (level === "L0") return payload;

  // ── L1: + Tool Config ─────────────────────────────────────────────────

  payload.toolConfig = {
    enabledToolsets: ["hermes-acp"],
  };

  // Read exec approvals / command allowlist if it exists
  const approvalsPath = join(workspaceDir, "exec-approvals.json");
  const approvals = await readJsonIfExists(approvalsPath);
  if (approvals && typeof approvals === "object" && !Array.isArray(approvals)) {
    const allowlist = Object.keys(approvals as Record<string, unknown>);
    if (allowlist.length > 0) {
      payload.toolConfig.commandAllowlist = allowlist;
    }
  }

  if (level === "L1") return payload;

  // ── L2: + Memory, Identity, Workspace Instructions ────────────────────

  // Read SOUL.md
  const soulPath = join(workspaceDir, "SOUL.md");
  const soul = await readFileIfExists(soulPath);

  // Read USER.md
  const userPath = join(workspaceDir, "USER.md");
  const user = await readFileIfExists(userPath);

  // Read AGENTS.md
  const agentsPath = join(workspaceDir, "AGENTS.md");
  const agents = await readFileIfExists(agentsPath);

  payload.identity = {};
  if (soul) payload.identity.soul = soul;
  if (user) payload.identity.user = user;
  if (agents) payload.identity.agents = agents;

  // Read memory: MEMORY.md + today's daily file
  const memoryPath = join(workspaceDir, "MEMORY.md");
  const longTermMemory = await readFileIfExists(memoryPath);

  // Get today's daily notes
  const today = new Date();
  const dateStr = today.toISOString().split("T")[0]; // YYYY-MM-DD
  const dailyPath = join(workspaceDir, "memory", `${dateStr}.md`);
  const dailyMemory = await readFileIfExists(dailyPath);

  payload.memory = {};

  if (longTermMemory) {
    const tokens = estimateTokens(longTermMemory);
    if (tokens > 2000) {
      // Summarize: keep only the most relevant parts
      payload.memory.longTerm = adaptiveMemorySummary(longTermMemory, MEMORY_FULL_THRESHOLD_CHARS);
      payload.memory.summary = `[Memory truncated: ${tokens} tokens → ~2K tokens. Full memory available at L3.]`;
    } else {
      payload.memory.longTerm = longTermMemory;
    }
  }

  if (dailyMemory) {
    payload.memory.daily = dailyMemory;
  }

  if (level === "L2" && !includeWorkspaceSkills) return payload;

  // ── L3: + Skills, MCP Servers, Cron ───────────────────────────────────

  // Full untruncated memory at L3
  if (longTermMemory) {
    payload.memory.longTerm = longTermMemory;
    payload.memory.summary = undefined;
  }

  // Read skills manifest
  const skillsDir = join(workspaceDir, "skills");
  if (!options.openClawContext?.skillsSnapshot && (level === "L3" || includeWorkspaceSkills)) {
    payload.skills = await readSkillsManifest(skillsDir);
  }

  // Read MCP server config (from OpenClaw config if available)
  // For now, return empty — this would integrate with OpenClaw's config system
  payload.mcpServers = {};

  // Read cron definitions (from OpenClaw's cron system if available)
  payload.cronDefinitions = [];

  return payload;
}

/**
 * Scan the skills directory and build a manifest of available skills.
 */
export async function readSkillsManifest(skillsDir: string): Promise<SkillManifestEntry[]> {
  const skills: SkillManifestEntry[] = [];

  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillPath = join(skillsDir, entry.name, "SKILL.md");
      try {
        const skillStat = await stat(skillPath);
        if (!skillStat.isFile()) continue;
        // Read first few lines for description
        const content = await readFile(skillPath, "utf8");
        const descMatch = content.match(/^#\s+.*\n\n(.+)/m);
        skills.push({
          name: entry.name,
          path: skillPath,
          description: descMatch?.[1]?.slice(0, 200),
        });
      } catch {
        // No SKILL.md, skip
      }
    }
  } catch {
    // Skills directory doesn't exist
  }

  return skills;
}

/**
 * Build a projected context object that can be materialized into an execution workdir.
 */
export async function assembleProjectedContext(
  task: string,
  level: ContextLevel,
  options: AssemblerOptions,
): Promise<ProjectedContext> {
  const payload = await assembleContext(task, level, options);
  return {
    files: {
      soul: payload.identity?.soul,
      user: payload.identity?.user,
      agent: payload.identity?.agents,
      task: payload.task,
    },
    memory: payload.memory,
    commandAllowlist: payload.toolConfig?.commandAllowlist,
    discoveredSkills: payload.skills ?? [],
    skillsPrompt: options.openClawContext?.skillsSnapshot?.prompt,
  };
}

function formatProjectedSkill(skill: ProjectedSkill): string {
  const description = skill.description ?? "(no description)";
  if (skill.placement === "host-backed") {
    return [
      `- **${skill.name}** (host-backed): ${description}`,
      `  Execution: OpenClaw MCP bridge.`,
      `  MCP tool: ${skill.mcpTool ?? "openclaw.skill.invoke"}.`,
      `  Do not run this skill's host CLI directly inside the Hermes container.`,
    ].join("\n");
  }
  if (skill.placement === "container-env-required") {
    return [
      `- **${skill.name}** (container-env-required): ${description}`,
      skill.requiredEnv?.length
        ? `  Required env: ${skill.requiredEnv.join(", ")}.`
        : `  Required env: see the skill's SKILL.md.`,
      skill.runtimePath ? `  Runtime file: ${skill.runtimePath}.` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (skill.placement === "projected-local") {
    return [
      `- **${skill.name}** (projected-local): ${description}`,
      skill.runtimePath ? `  Runtime file: ${skill.runtimePath}.` : undefined,
      `  Execution: local in the Hermes container.`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return `- **${skill.name}** (unsupported): ${description}`;
}

/**
 * Serialize the context payload into a system prompt prefix for Hermes.
 */
export function serializeContextForPrompt(payload: ContextPayload): string {
  const parts: string[] = [];

  parts.push(`# Task\n${payload.task}`);

  if (payload.identity?.soul) {
    parts.push(`# Identity (SOUL)\n${payload.identity.soul}`);
  }
  if (payload.identity?.user) {
    parts.push(`# User Profile\n${payload.identity.user}`);
  }
  if (payload.identity?.agents) {
    parts.push(`# Workspace Instructions\n${payload.identity.agents}`);
  }

  if (payload.memory?.longTerm) {
    parts.push(`# Long-term Memory\n${payload.memory.longTerm}`);
  }
  if (payload.memory?.daily) {
    parts.push(`# Today's Notes\n${payload.memory.daily}`);
  }
  if (payload.memory?.summary) {
    parts.push(`> ${payload.memory.summary}`);
  }

  if (payload.toolConfig?.commandAllowlist?.length) {
    parts.push(
      `# Allowed Commands\n${payload.toolConfig.commandAllowlist.map((c) => `- ${c}`).join("\n")}`,
    );
  }

  if (payload.skills && payload.skills.length > 0) {
    const skillList = payload.skills
      .map((s) => `- **${s.name}**: ${s.description ?? "(no description)"}`)
      .join("\n");
    parts.push(`# Available Skills\n${skillList}`);
  }

  return parts.join("\n\n---\n\n");
}

export function serializeProjectedContextForPrompt(
  projected: ProjectedContext,
  exposedSkills: ProjectedSkill[],
  runtime?: {
    runtimeCwd: string;
    projectionPath: string;
    conversationHistory?: string;
  },
): string {
  const parts: string[] = [];

  if (projected.files.task) {
    parts.push(`# Task\n${projected.files.task}`);
  }
  if (projected.files.soul) {
    parts.push(`# Identity (SOUL)\n${projected.files.soul}`);
  }
  if (projected.files.user) {
    parts.push(`# User Profile\n${projected.files.user}`);
  }
  if (projected.files.agent) {
    parts.push(`# Workspace Instructions\n${projected.files.agent}`);
  }
  if (projected.memory?.longTerm) {
    parts.push(`# Long-term Memory\n${projected.memory.longTerm}`);
  }
  if (projected.memory?.daily) {
    parts.push(`# Today's Notes\n${projected.memory.daily}`);
  }
  if (projected.memory?.summary) {
    parts.push(`> ${projected.memory.summary}`);
  }
  if (projected.commandAllowlist?.length) {
    parts.push(`# Allowed Commands\n${projected.commandAllowlist.map((c) => `- ${c}`).join("\n")}`);
  }
  if (runtime?.conversationHistory) {
    parts.push(`# Conversation History\n${runtime.conversationHistory}`);
  }
  if (exposedSkills.length > 0) {
    const promptCatalog = projected.skillsPrompt?.trim();
    parts.push(
      [
        "# Available OpenClaw Skills",
        "The following skills are selected by OpenClaw for this session. Only these skills are available.",
        ...(promptCatalog ? ["", "OpenClaw skill catalog:", promptCatalog] : []),
        "",
        exposedSkills.map(formatProjectedSkill).join("\n"),
      ].join("\n"),
    );
  }

  parts.push(
    [
      "# Runtime Contract",
      ...(runtime
        ? [
            `Projected runtime cwd: ${runtime.runtimeCwd}`,
            `Projected manifest path: ${runtime.projectionPath}`,
          ]
        : []),
      "Only use the skills listed under # Available OpenClaw Skills as OpenClaw-provided capabilities.",
      "When a projected-local or container-env-required skill matches the task, read its runtime SKILL.md first and resolve relative references against that skill directory.",
      "When a host-backed skill matches the task, call the listed OpenClaw MCP tool instead of running host-specific CLIs inside the container.",
      "If a capability is not listed there, do not claim it is available from the current OpenClaw workspace.",
      "If realtime or browser-based work is requested but no matching OpenClaw skill is listed, explain the limitation naturally instead of exposing internal errors.",
      ...(runtime
        ? [
            "For terminal-style execution, default to the projected runtime cwd above.",
            "If you need to read the projected manifest or projected skills, use the exact paths above instead of guessing the working directory.",
          ]
        : []),
      ...(exposedSkills.length > 0
        ? [
            `Projected OpenClaw skill files:`,
            ...exposedSkills.map((skill) => `- ${skill.name}: ${skill.projectedPath ?? "(path unavailable)"}`),
          ]
        : []),
    ].join("\n"),
  );

  return parts.join("\n\n---\n\n");
}
