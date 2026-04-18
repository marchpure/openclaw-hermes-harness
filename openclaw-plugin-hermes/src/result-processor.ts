/**
 * openclaw-plugin-hermes — Result Processor
 *
 * Handles writeback of Hermes execution results back to OpenClaw.
 *
 * W0: None — discard results (query only, result still returned to caller)
 * W1: Result — return execution result text
 * W2: Memory — + append to MEMORY.md or daily notes
 * W3: Full — + create/update skills, cron, config (requires user confirmation)
 */

import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type {
  WritebackLevel,
  DispatchResult,
  MemoryUpdate,
  AcpSessionEvent,
} from "./types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ProcessorOptions {
  workspaceDir: string;
  /** Callback for W3 operations that require user confirmation */
  confirmAction?: (description: string) => Promise<boolean>;
}

export interface ProcessedResult {
  text: string;
  memoryUpdates: MemoryUpdate[];
  skillsCreated: string[];
  warnings: string[];
}

// ─── Result Processing ──────────────────────────────────────────────────────

/**
 * Process the raw Hermes output according to the writeback level.
 */
export async function processResult(
  rawText: string,
  events: AcpSessionEvent[],
  writebackLevel: WritebackLevel,
  options: ProcessorOptions,
): Promise<ProcessedResult> {
  const result: ProcessedResult = {
    text: rawText,
    memoryUpdates: [],
    skillsCreated: [],
    warnings: [],
  };

  // W0: No writeback — just return
  if (writebackLevel === "W0") {
    return result;
  }

  // W1: Return result text (already set)
  if (writebackLevel === "W1") {
    return result;
  }

  // W2: + Update memory
  if (writebackLevel === "W2" || writebackLevel === "W3") {
    const memoryUpdates = await processMemoryWriteback(rawText, events, options);
    result.memoryUpdates = memoryUpdates;
  }

  // W3: + Create skills, cron, config
  if (writebackLevel === "W3") {
    const skillsResult = await processFullWriteback(rawText, events, options);
    result.skillsCreated = skillsResult.skills;
    result.warnings.push(...skillsResult.warnings);
  }

  return result;
}

/**
 * Apply writeback changes to the filesystem.
 * This is separated from processResult so the caller can review before applying.
 */
export async function applyWriteback(
  processed: ProcessedResult,
  options: ProcessorOptions,
): Promise<string[]> {
  const applied: string[] = [];

  for (const update of processed.memoryUpdates) {
    try {
      await applyMemoryUpdate(update, options.workspaceDir);
      applied.push(`Memory: ${update.action} to ${update.target}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      applied.push(`Memory: FAILED ${update.target} — ${msg}`);
    }
  }

  return applied;
}

// ─── W2: Memory Writeback ───────────────────────────────────────────────────

async function processMemoryWriteback(
  rawText: string,
  events: AcpSessionEvent[],
  options: ProcessorOptions,
): Promise<MemoryUpdate[]> {
  const updates: MemoryUpdate[] = [];

  // Extract task summary from the execution result
  const summary = extractTaskSummary(rawText, events);
  if (!summary) return updates;

  // Append to today's daily notes
  const today = new Date().toISOString().split("T")[0];
  updates.push({
    target: "daily",
    content: `\n## Hermes Task (${new Date().toLocaleTimeString("en-US", { hour12: false })})\n${summary}\n`,
    action: "append",
  });

  // If the result contains significant learnings, also update MEMORY.md
  if (containsSignificantLearning(rawText)) {
    const learning = extractLearning(rawText);
    if (learning) {
      updates.push({
        target: "MEMORY.md",
        content: `\n- ${learning}`,
        action: "append",
      });
    }
  }

  return updates;
}

async function applyMemoryUpdate(
  update: MemoryUpdate,
  workspaceDir: string,
): Promise<void> {
  let targetPath: string;

  if (update.target === "daily") {
    const today = new Date().toISOString().split("T")[0];
    targetPath = join(workspaceDir, "memory", `${today}.md`);
  } else {
    targetPath = join(workspaceDir, update.target);
  }

  // Ensure directory exists
  await mkdir(dirname(targetPath), { recursive: true });

  if (update.action === "append") {
    try {
      await appendFile(targetPath, update.content, "utf8");
    } catch {
      // File might not exist yet
      await writeFile(targetPath, `# ${update.target}\n${update.content}`, "utf8");
    }
  } else {
    await writeFile(targetPath, update.content, "utf8");
  }
}

// ─── W3: Full Writeback ─────────────────────────────────────────────────────

async function processFullWriteback(
  rawText: string,
  events: AcpSessionEvent[],
  options: ProcessorOptions,
): Promise<{ skills: string[]; warnings: string[] }> {
  const skills: string[] = [];
  const warnings: string[] = [];

  // Detect if Hermes created any skills
  const skillCreationEvents = events.filter(
    (e) => e.type === "tool_result" && e.text?.includes("skill_create"),
  );

  if (skillCreationEvents.length > 0) {
    // W3 operations require user confirmation
    if (options.confirmAction) {
      const confirmed = await options.confirmAction(
        `Hermes wants to create ${skillCreationEvents.length} skill(s). Allow?`,
      );
      if (!confirmed) {
        warnings.push("Skill creation blocked by user");
        return { skills, warnings };
      }
    } else {
      warnings.push("W3 skill creation requires user confirmation — skipped (no confirm callback)");
      return { skills, warnings };
    }

    // Process skill creation
    for (const event of skillCreationEvents) {
      try {
        const skillInfo = parseSkillCreationEvent(event);
        if (skillInfo) {
          skills.push(skillInfo.name);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`Failed to process skill creation: ${msg}`);
      }
    }
  }

  // Detect cron job creation requests
  const cronEvents = events.filter(
    (e) => e.type === "tool_result" && e.text?.includes("cronjob"),
  );

  if (cronEvents.length > 0) {
    if (options.confirmAction) {
      const confirmed = await options.confirmAction(
        `Hermes wants to create ${cronEvents.length} cron job(s). Allow?`,
      );
      if (!confirmed) {
        warnings.push("Cron creation blocked by user");
      }
    } else {
      warnings.push("W3 cron creation requires user confirmation — skipped");
    }
  }

  return { skills, warnings };
}

// ─── Extraction Helpers ─────────────────────────────────────────────────────

/**
 * Extract a concise task summary from Hermes output.
 */
function extractTaskSummary(rawText: string, events: AcpSessionEvent[]): string | null {
  if (!rawText || rawText.trim().length === 0) return null;

  // Use the first 500 chars of the response as summary
  const text = rawText.trim();
  if (text.length <= 500) return text;

  // Try to find a natural break point
  const breakPoints = [
    text.indexOf("\n\n", 200),
    text.indexOf("。", 200),
    text.indexOf(". ", 200),
    500,
  ];
  const breakAt = breakPoints.find((p) => p > 0 && p <= 600) ?? 500;
  return text.slice(0, breakAt) + "...";
}

/**
 * Check if the result contains significant learnings worth persisting.
 */
function containsSignificantLearning(text: string): boolean {
  const learningSignals = [
    /学到|发现|注意|重要|结论|总结/,
    /learned|discovered|important|conclusion|takeaway|note/i,
    /✅.*完成|成功.*部署|配置.*生效/,
    /error.*fixed|bug.*resolved|issue.*solved/i,
  ];
  return learningSignals.some((p) => p.test(text));
}

/**
 * Extract a concise learning statement from the result text.
 */
function extractLearning(text: string): string | null {
  // Look for explicit "learned" patterns
  const patterns = [
    /(?:学到|发现|注意)[：:]\s*(.+?)(?:\n|$)/,
    /(?:takeaway|learned|note)[：:]\s*(.+?)(?:\n|$)/i,
    /(?:总结|结论)[：:]\s*(.+?)(?:\n|$)/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].trim().slice(0, 200);
    }
  }

  // Fallback: first sentence
  const firstSentence = text.match(/^(.{20,200}?)(?:\。|\.\s|\n)/);
  if (firstSentence?.[1]) {
    return firstSentence[1].trim();
  }

  return null;
}

/**
 * Parse a skill creation event from Hermes tool output.
 */
function parseSkillCreationEvent(
  event: AcpSessionEvent,
): { name: string; path: string } | null {
  if (!event.text) return null;
  try {
    const data = JSON.parse(event.text);
    if (data.name && data.path) {
      return { name: data.name, path: data.path };
    }
  } catch {
    // Try regex extraction
    const nameMatch = event.text.match(/skill[_\s]name[：:=]\s*["']?(\S+)/i);
    if (nameMatch?.[1]) {
      return { name: nameMatch[1], path: "" };
    }
  }
  return null;
}
