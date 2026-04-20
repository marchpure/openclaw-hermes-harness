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
  OpenClawSkillSnapshot,
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
  const { workspaceDir, config, openClawContext } = options;
  const isHarnessAttempt = hasHarnessContext(openClawContext);
  const payload: ContextPayload = { task };

  // ── L0: Task + Model Config ───────────────────────────────────────────

  payload.modelConfig = {
    model: config.defaultModel ?? "minimax-m2.5",
  };

  if (isHarnessAttempt) {
    await addPreparedOpenClawContext(payload, workspaceDir, openClawContext);
  }

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

  await addWorkspaceIdentity(payload, workspaceDir);

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

  if (level === "L2") return payload;

  // ── L3: + Skills, MCP Servers, Cron ───────────────────────────────────

  // Full untruncated memory at L3
  if (longTermMemory) {
    payload.memory.longTerm = longTermMemory;
    payload.memory.summary = undefined;
  }

  // Prefer OpenClaw's prepared skills snapshot in harness mode; it already
  // reflects agent-level filters and merged skill sources.
  if (openClawContext?.skillsSnapshot) {
    payload.openClaw = {
      ...(payload.openClaw ?? {}),
      skillsPrompt: buildSkillsPromptFromSnapshot(openClawContext.skillsSnapshot),
    };
  } else {
    const skillsDir = join(workspaceDir, "skills");
    payload.skills = await readSkillsManifest(skillsDir);
  }

  // Read MCP server config (from OpenClaw config if available)
  // For now, return empty — this would integrate with OpenClaw's config system
  payload.mcpServers = {};

  // Read cron definitions (from OpenClaw's cron system if available)
  payload.cronDefinitions = [];

  return payload;
}

function hasHarnessContext(context: OpenClawAttemptContext | undefined): boolean {
  return Boolean(
    context?.agentId ||
      context?.agentDir ||
      context?.skillsSnapshot ||
      context?.extraSystemPrompt ||
      context?.toolsAllow?.length ||
      context?.bootstrapContextMode ||
      context?.bootstrapContextRunKind,
  );
}

async function addPreparedOpenClawContext(
  payload: ContextPayload,
  workspaceDir: string,
  context: OpenClawAttemptContext | undefined,
): Promise<void> {
  payload.openClaw = {
    ...(context?.agentId ? { agentId: context.agentId } : {}),
    ...(context?.agentDir ? { agentDir: context.agentDir } : {}),
    ...(context?.extraSystemPrompt ? { extraSystemPrompt: context.extraSystemPrompt } : {}),
    ...(context?.toolsAllow?.length ? { toolsAllow: context.toolsAllow } : {}),
    ...(context?.bootstrapContextMode ? { bootstrapContextMode: context.bootstrapContextMode } : {}),
    ...(context?.bootstrapContextRunKind ? { bootstrapContextRunKind: context.bootstrapContextRunKind } : {}),
  };

  if (context?.skillsSnapshot) {
    payload.openClaw.skillsPrompt = buildSkillsPromptFromSnapshot(context.skillsSnapshot);
  }

  await addWorkspaceIdentity(payload, workspaceDir);
}

async function addWorkspaceIdentity(payload: ContextPayload, workspaceDir: string): Promise<void> {
  const [soul, user, agents] = await Promise.all([
    readFileIfExists(join(workspaceDir, "SOUL.md")),
    readFileIfExists(join(workspaceDir, "USER.md")),
    readFileIfExists(join(workspaceDir, "AGENTS.md")),
  ]);

  payload.identity = {
    ...(payload.identity ?? {}),
    ...(soul ? { soul } : {}),
    ...(user ? { user } : {}),
    ...(agents ? { agents } : {}),
  };
}

function buildSkillsPromptFromSnapshot(snapshot: OpenClawSkillSnapshot): string {
  if (snapshot.prompt?.trim()) {
    return snapshot.prompt;
  }

  const resolvedSkills = snapshot.resolvedSkills ?? [];
  if (resolvedSkills.length > 0) {
    return resolvedSkills
      .map((skill) => {
        const name = skill.name ?? skill.source ?? skill.path ?? "unknown";
        const description = skill.description ? `: ${skill.description}` : "";
        const path = skill.path ? ` (${skill.path})` : "";
        return `- **${name}**${description}${path}`;
      })
      .join("\n");
  }

  const skills = snapshot.skills ?? [];
  return skills
    .map((skill) => {
      const required = skill.requiredEnv?.length ? `; requires env: ${skill.requiredEnv.join(", ")}` : "";
      const primary = skill.primaryEnv ? `; primary env: ${skill.primaryEnv}` : "";
      return `- **${skill.name}**${primary}${required}`;
    })
    .join("\n");
}

/**
 * Scan the skills directory and build a manifest of available skills.
 */
async function readSkillsManifest(
  skillsDir: string,
): Promise<Array<{ name: string; path: string; description?: string }>> {
  const skills: Array<{ name: string; path: string; description?: string }> = [];

  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(skillsDir, entry.name, "SKILL.md");
      try {
        await stat(skillPath);
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
 * Serialize the context payload into a system prompt prefix for Hermes.
 */
export function serializeContextForPrompt(payload: ContextPayload): string {
  const parts: string[] = [];

  parts.push(`# Task\n${payload.task}`);

  if (payload.openClaw?.agentId) {
    parts.push(`# OpenClaw Agent\nagentId: ${payload.openClaw.agentId}`);
  }
  if (payload.openClaw?.extraSystemPrompt) {
    parts.push(`# OpenClaw Extra System Prompt\n${payload.openClaw.extraSystemPrompt}`);
  }

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
  if (payload.openClaw?.toolsAllow?.length) {
    parts.push(`# OpenClaw Tool Allowlist\n${payload.openClaw.toolsAllow.map((tool) => `- ${tool}`).join("\n")}`);
  }

  if (payload.openClaw?.skillsPrompt?.trim()) {
    parts.push(`# Available Skills\n${payload.openClaw.skillsPrompt.trim()}`);
  }
  if (payload.skills && payload.skills.length > 0) {
    const skillList = payload.skills
      .map((s) => `- **${s.name}**: ${s.description ?? "(no description)"}`)
      .join("\n");
    parts.push(`# Available Skills\n${skillList}`);
  }

  return parts.join("\n\n---\n\n");
}
