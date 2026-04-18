/**
 * openclaw-plugin-hermes — Strategy Engine
 *
 * Automatically infers the optimal L/C/W triple for a given task by
 * analyzing the task text for keywords, required tools, and intent signals.
 */

import type {
  ContextLevel,
  CredentialScope,
  WritebackLevel,
  StrategyTriple,
} from "./types.js";

// ─── Keyword Patterns ───────────────────────────────────────────────────────

/** Signals that require memory / identity context (→ L2+) */
const MEMORY_SIGNALS = [
  /上次|之前|记得|记住|习惯|偏好|以前/,
  /last\s+time|remember|previously|before|preference/i,
  /我的(语气|风格|方式|口吻)/,
  /my\s+(style|tone|voice|way)/i,
];

/** Signals that require skill/MCP management (→ L3) */
const SKILL_SIGNALS = [
  /创建.*skill|新建.*技能|skill.*create/i,
  /mcp\s*(server|服务)/i,
  /cron|定时|计划任务|schedule/i,
];

/** Signals that need terminal / browser / file tools (→ L1+) */
const TOOL_SIGNALS = [
  /运行|执行|跑|编译|构建|部署|安装/,
  /run|execute|compile|build|deploy|install|npm|pip|docker|git/i,
  /浏览器|截图|网页|爬取|自动化/,
  /browser|screenshot|scrape|automate|playwright/i,
  /文件|目录|重命名|移动|删除|读取|写入/,
  /file|directory|rename|move|delete|read|write|mkdir/i,
  /终端|命令行|shell|ssh|sudo/i,
  /磁盘|日志|进程|服务|nginx|systemd/i,
];

/** Signals that require specific credentials (→ C1) */
const CREDENTIAL_SIGNALS: Array<{ pattern: RegExp; keys: string[] }> = [
  { pattern: /github|gh\s|仓库|repo|fork|pr|pull\s*request/i, keys: ["GITHUB_TOKEN"] },
  { pattern: /telegram|tg/i, keys: ["TELEGRAM_BOT_TOKEN"] },
  { pattern: /discord/i, keys: ["DISCORD_BOT_TOKEN"] },
  { pattern: /home\s*assistant|ha_|智能家居|灯|场景|自动化.*家/i, keys: ["HASS_TOKEN", "HASS_URL"] },
  { pattern: /twitter|tweet|x\.com/i, keys: ["TWITTER_API_KEY"] },
  { pattern: /slack/i, keys: ["SLACK_BOT_TOKEN"] },
  { pattern: /email|邮件|smtp|gmail/i, keys: ["EMAIL_USER", "EMAIL_PASS"] },
  { pattern: /openai/i, keys: ["OPENAI_API_KEY"] },
  { pattern: /anthropic|claude/i, keys: ["ANTHROPIC_API_KEY"] },
  { pattern: /aws|s3|ec2/i, keys: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] },
  { pattern: /通知|notify|send.*message|发.*消息/i, keys: ["TELEGRAM_BOT_TOKEN", "DISCORD_BOT_TOKEN"] },
  { pattern: /image.*gen|生成.*图|画图|flux|fal/i, keys: ["FAL_KEY"] },
  { pattern: /tts|语音|朗读|text.*speech/i, keys: ["ELEVENLABS_API_KEY"] },
];

/** Signals for all-credentials scope (→ C2) — rare, requires confirmation */
const ALL_CREDENTIALS_SIGNALS = [
  /所有.*通道|全部.*平台|统一.*回复|all\s+channels/i,
  /跨平台|cross.*platform/i,
];

/** Signals for skill/cron/config writeback (→ W3) */
const FULL_WRITEBACK_SIGNALS = [
  /创建.*skill|新建.*技能|create.*skill/i,
  /创建.*cron|设置.*定时|schedule.*cron/i,
  /更新.*配置|修改.*config|update.*config/i,
];

/** Signals for memory writeback (→ W2) */
const MEMORY_WRITEBACK_SIGNALS = [
  /记住|记下|保存|更新|部署|上线/,
  /remember|save|update|deploy|persist/i,
  /学到|总结|lesson|learned/i,
];

/** Signals for query-only / no writeback (→ W0) */
const QUERY_SIGNALS = [
  /^(查|看|搜|找|检查|显示|列出|获取)/,
  /^(check|show|list|get|find|search|look|view|read|cat|ls|ps|df)/i,
  /什么|多少|哪个|是否|有没有/,
  /what|how\s+many|which|whether|is\s+there/i,
];

// ─── Strategy Inference ─────────────────────────────────────────────────────

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

function inferContextLevel(task: string): { level: ContextLevel; confidence: number; reason: string } {
  // L3: needs skill/MCP management
  if (matchesAny(task, SKILL_SIGNALS)) {
    return { level: "L3", confidence: 0.85, reason: "Task involves skill/MCP/cron management" };
  }

  // L2: needs memory or identity context
  if (matchesAny(task, MEMORY_SIGNALS)) {
    return { level: "L2", confidence: 0.8, reason: "Task references memory, preferences, or identity" };
  }

  // L1: needs tools (terminal, browser, file)
  if (matchesAny(task, TOOL_SIGNALS)) {
    return { level: "L1", confidence: 0.75, reason: "Task requires tool execution (terminal/browser/file)" };
  }

  // L0: pure instruction, no tools needed
  return { level: "L0", confidence: 0.7, reason: "Simple task — no tools or context needed" };
}

function inferCredentialScope(task: string): { scope: CredentialScope; confidence: number; reason: string } {
  // C2: all credentials (very rare)
  if (matchesAny(task, ALL_CREDENTIALS_SIGNALS)) {
    return {
      scope: { mode: "all" },
      confidence: 0.6,
      reason: "Task requires cross-platform / all-channel access",
    };
  }

  // C1: specific credentials
  const matchedKeys = new Set<string>();
  const matchedServices: string[] = [];
  for (const { pattern, keys } of CREDENTIAL_SIGNALS) {
    if (pattern.test(task)) {
      keys.forEach((k) => matchedKeys.add(k));
      matchedServices.push(pattern.source.slice(0, 20));
    }
  }

  if (matchedKeys.size > 0) {
    return {
      scope: { mode: "specified", keys: [...matchedKeys] },
      confidence: 0.75,
      reason: `Task needs credentials for: ${matchedServices.join(", ")}`,
    };
  }

  // C0: no credentials
  return {
    scope: { mode: "none" },
    confidence: 0.85,
    reason: "No external service credentials needed",
  };
}

function inferWritebackLevel(task: string): { level: WritebackLevel; confidence: number; reason: string } {
  // W3: create skills, cron, config
  if (matchesAny(task, FULL_WRITEBACK_SIGNALS)) {
    return { level: "W3", confidence: 0.8, reason: "Task creates skills, cron jobs, or config changes" };
  }

  // W2: update memory
  if (matchesAny(task, MEMORY_WRITEBACK_SIGNALS)) {
    return { level: "W2", confidence: 0.75, reason: "Task produces learnings or state to persist" };
  }

  // W0: query only
  if (matchesAny(task, QUERY_SIGNALS)) {
    return { level: "W0", confidence: 0.7, reason: "Read-only query — no writeback needed" };
  }

  // W1: return result (default)
  return { level: "W1", confidence: 0.65, reason: "Default — return execution result" };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Infer the optimal L/C/W strategy triple for a task.
 */
export function inferStrategy(task: string): StrategyTriple {
  const ctx = inferContextLevel(task);
  const cred = inferCredentialScope(task);
  const wb = inferWritebackLevel(task);

  // Cross-dimensional consistency checks
  // If W3 (creating skills/cron), we need at least L2 context
  let finalContext = ctx.level;
  if (wb.level === "W3" && ctx.level < "L2") {
    finalContext = "L3";
  }
  // If C2 (all credentials), we probably need L2+ for identity context
  if (cred.scope.mode === "all" && finalContext < "L2") {
    finalContext = "L2";
  }

  const avgConfidence = (ctx.confidence + cred.confidence + wb.confidence) / 3;
  const reasoning = [ctx.reason, cred.reason, wb.reason].join("; ");

  return {
    context: finalContext,
    credential: cred.scope,
    writeback: wb.level,
    confidence: Math.round(avgConfidence * 100) / 100,
    reasoning,
  };
}

/**
 * Format a strategy triple as a compact string: "L1/C0/W1"
 */
export function formatStrategy(strategy: StrategyTriple): string {
  const cLabel =
    strategy.credential.mode === "none"
      ? "C0"
      : strategy.credential.mode === "specified"
        ? `C1(${strategy.credential.keys?.join(",") ?? ""})`
        : "C2";
  return `${strategy.context}/${cLabel}/${strategy.writeback}`;
}
