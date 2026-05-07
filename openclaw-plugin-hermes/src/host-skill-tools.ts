import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { HermesPluginConfig } from "./types.js";

type Logger = {
  warn: (msg: string, ...args: unknown[]) => void;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 20_000;
const OPENCLAW_WORKSPACE_SKILLS_DIR = "/root/.openclaw/workspace/skills";
const SENSITIVE_ENV_KEYS = [
  "WEB_SEARCH_API_KEY",
  "VOLCENGINE_ACCESS_KEY",
  "VOLCENGINE_SECRET_KEY",
  "VOLCENGINE_SESSION_TOKEN",
];

function stringifyParam(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return undefined;
}

function booleanParam(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  return false;
}

function numberParam(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function buildHostSkillEnv(config: HermesPluginConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(config.mcpBridge.env ?? {})) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function redactSensitiveText(text: string): string {
  let next = text;
  for (const key of SENSITIVE_ENV_KEYS) {
    const value = process.env[key];
    if (value && value.length >= 6) {
      next = next.split(value).join(`[redacted:${key}]`);
    }
  }
  return next;
}

function truncateOutput(value: string): string {
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated ${value.length - MAX_OUTPUT_CHARS} chars]`;
}

async function ensureExecutable(path: string): Promise<void> {
  await access(path, constants.R_OK);
}

async function runCommand(params: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      env: params.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 2_000).unref();
    }, params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timeout.unref();

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
}

function formatProcessResult(params: {
  label: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}): ToolResult {
  const text = [
    `${params.label} exitCode=${params.exitCode ?? "null"} signal=${params.signal ?? "none"}`,
    params.stdout.trim() ? `\nstdout:\n${truncateOutput(redactSensitiveText(params.stdout.trim()))}` : "",
    params.stderr.trim() ? `\nstderr:\n${truncateOutput(redactSensitiveText(params.stderr.trim()))}` : "",
  ].join("");
  return { content: [{ type: "text", text }] };
}

export function registerHostBackedSkillTools(params: {
  api: any;
  config: HermesPluginConfig;
  logger: Logger;
}): void {
  const bytedWebSearchDir = join(OPENCLAW_WORKSPACE_SKILLS_DIR, "byted-web-search");
  const bytedWebSearchScript = join(bytedWebSearchDir, "scripts", "web_search.py");
  const computerUseDir = join(OPENCLAW_WORKSPACE_SKILLS_DIR, "computer-use");
  const computerUseScript = join(computerUseDir, "scripts", "cua.sh");

  params.api.registerTool({
    name: "byted_web_search",
    description: [
      "Run the host-backed Byted/Volcano Engine web search skill.",
      "This tool executes the OpenClaw byted-web-search skill on the host so Hermes can use it through MCP.",
      "It reuses the skill's native credential chain: WEB_SEARCH_API_KEY, VOLCENGINE_ACCESS_KEY/VOLCENGINE_SECRET_KEY, then VeFaaS IAM.",
      "Use for current web search, source discovery, images, and time-sensitive facts.",
    ].join("\n"),
    parameters: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Search query text." },
        count: { type: "number", description: "Result count. Web max 50, image max 5." },
        type: { type: "string", enum: ["web", "image"], description: "Search result type." },
        timeRange: {
          type: "string",
          enum: ["OneDay", "OneWeek", "OneMonth", "OneYear"],
          description: "Optional time range filter.",
        },
        authLevel: {
          type: "number",
          description: "Authority filter. Use 1 for very authoritative sources.",
        },
        queryRewrite: {
          type: "boolean",
          description: "Enable query rewrite for conversational or long queries.",
        },
        apiKey: {
          type: "string",
          description: "Optional WEB_SEARCH_API_KEY override for this call. Prefer configuring env instead.",
        },
      },
    },
    async execute(_id: string, toolParams: Record<string, unknown>) {
      const query = stringifyParam(toolParams.query);
      if (!query) return { content: [{ type: "text", text: "Error: query is required" }] };

      try {
        await ensureExecutable(bytedWebSearchScript);
      } catch {
        return {
          content: [{ type: "text", text: `Error: byted-web-search script not found: ${bytedWebSearchScript}` }],
        };
      }

      const args = [bytedWebSearchScript, query];
      const count = numberParam(toolParams.count);
      if (count !== undefined) args.push("--count", String(count));
      const type = stringifyParam(toolParams.type);
      if (type) args.push("--type", type);
      const timeRange = stringifyParam(toolParams.timeRange);
      if (timeRange) args.push("--time-range", timeRange);
      const authLevel = numberParam(toolParams.authLevel);
      if (authLevel !== undefined) args.push("--auth-level", String(authLevel));
      if (booleanParam(toolParams.queryRewrite)) args.push("--query-rewrite");
      const apiKey = stringifyParam(toolParams.apiKey);
      if (apiKey) args.push("--api-key", apiKey);

      const env = buildHostSkillEnv(params.config);
      const result = await runCommand({
        command: "python3",
        args,
        cwd: bytedWebSearchDir,
        env,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      return formatProcessResult({ label: "byted_web_search", ...result });
    },
  });

  params.api.registerTool({
    name: "computer_use",
    description: [
      "Run the host-backed computer-use CUA skill.",
      "This executes the OpenClaw computer-use script on the host so Hermes can request GUI/Office automation through MCP.",
      "The tool may require a multimodal model and can return model-switch or computer-handoff tags from the underlying skill.",
    ].join("\n"),
    parameters: {
      type: "object",
      required: ["task"],
      properties: {
        task: {
          type: "string",
          description: "Computer-use task content, including target app/page and expected result.",
        },
        timeoutSeconds: {
          type: "number",
          description: "Optional timeout in seconds. Defaults to 600, capped at 3600.",
        },
      },
    },
    async execute(_id: string, toolParams: Record<string, unknown>) {
      const task = stringifyParam(toolParams.task);
      if (!task) return { content: [{ type: "text", text: "Error: task is required" }] };
      try {
        await ensureExecutable(computerUseScript);
      } catch {
        return {
          content: [{ type: "text", text: `Error: computer-use script not found: ${computerUseScript}` }],
        };
      }
      const timeoutSeconds = Math.min(Math.max(numberParam(toolParams.timeoutSeconds) ?? 600, 30), 3600);
      params.logger.warn(`computer_use requested; timeoutSeconds=${timeoutSeconds}`);
      const result = await runCommand({
        command: "bash",
        args: [computerUseScript, "run", task],
        cwd: computerUseDir,
        env: buildHostSkillEnv(params.config),
        timeoutMs: timeoutSeconds * 1000,
      });
      return formatProcessResult({ label: "computer_use", ...result });
    },
  });
}
