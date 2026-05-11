import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { HermesPluginConfig } from "./types.js";

type Logger = {
  warn: (msg: string, ...args: unknown[]) => void;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
};

export type HostBackedToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (_id: string, toolParams: Record<string, unknown>) => Promise<ToolResult> | ToolResult;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 20_000;
const OPENCLAW_WORKSPACE_SKILLS_DIR = "/root/.openclaw/workspace/skills";
const ARKDRIVE_MOUNT_PATH = "/root/.openclaw/workspace/arkdrive_uploads";
const CUA_RUNS_DIR = "/root/.cua/runs";
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

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function valueAtPath(obj: unknown, path: string[]): unknown {
  let current = obj;
  for (const part of path) {
    if (!current || typeof current !== "object" || !(part in current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function shortJsonValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function newestCuaRunDir(sinceMs: number): Promise<string | undefined> {
  let entries: string[] = [];
  try {
    entries = await readdir(CUA_RUNS_DIR);
  } catch {
    return undefined;
  }
  let newest: { dir: string; mtimeMs: number } | undefined;
  for (const entry of entries) {
    const dir = join(CUA_RUNS_DIR, entry);
    try {
      const info = await stat(join(dir, "run.meta.json"));
      if (info.mtimeMs + 5_000 < sinceMs) continue;
      if (!newest || info.mtimeMs > newest.mtimeMs) newest = { dir, mtimeMs: info.mtimeMs };
    } catch {
      // Ignore non-run entries.
    }
  }
  return newest?.dir;
}

function extractRunDirFromStdout(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const parsed = safeJsonParse(line.trim());
    if (!parsed || typeof parsed !== "object") continue;
    const runDir = (parsed as Record<string, unknown>).run_dir;
    if (typeof runDir === "string" && runDir.trim()) return runDir.trim();
  }
  return undefined;
}

async function summarizeCuaRun(runDir: string | undefined): Promise<string> {
  if (!runDir) return "";
  let stepsRaw = "";
  try {
    stepsRaw = await readFile(join(runDir, "steps.jsonl"), "utf8");
  } catch {
    return `\n\ncua_run_summary:\n- runDir: ${runDir}\n- status: run directory detected, but steps.jsonl is not available yet.`;
  }

  const steps = stepsRaw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => safeJsonParse(line))
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object");

  if (!steps.length) {
    return `\n\ncua_run_summary:\n- runDir: ${runDir}\n- status: steps.jsonl is empty.`;
  }

  const last = steps[steps.length - 1];
  const brain = valueAtPath(last, ["brain"]);
  const lines = [
    "",
    "",
    "cua_run_summary:",
    `- runDir: ${runDir}`,
    `- stepsCompleted: ${steps.length}`,
    `- lastStep: ${shortJsonValue(last.step)}`,
    `- lastAction: ${shortJsonValue(last.actionName)} ${shortJsonValue(last.actionArgs)}`.trim(),
  ];
  const screenshotPath = shortJsonValue(last.screenshotPath);
  if (screenshotPath) lines.push(`- lastScreenshot: ${screenshotPath}`);
  const progress = shortJsonValue(valueAtPath(brain, ["progress"]));
  if (progress) lines.push(`- progress: ${progress}`);
  const failureReason = shortJsonValue(valueAtPath(brain, ["failure_reason"]));
  if (failureReason) lines.push(`- failureReason: ${failureReason}`);
  const nextGoal = shortJsonValue(valueAtPath(brain, ["next_goal"]));
  if (nextGoal) lines.push(`- nextGoal: ${nextGoal}`);

  const recent = steps.slice(-5).map((step) => {
    const action = `${shortJsonValue(step.actionName)} ${shortJsonValue(step.actionArgs)}`.trim();
    const rationale = Array.isArray(valueAtPath(step, ["llm", "rationales"]))
      ? (valueAtPath(step, ["llm", "rationales"]) as unknown[]).map(shortJsonValue).filter(Boolean)[0]
      : "";
    return `  step ${shortJsonValue(step.step)}: ${action}${rationale ? `; rationale=${rationale}` : ""}`;
  });
  lines.push("- recentSteps:");
  lines.push(...recent);

  try {
    const finalRaw = await readFile(join(runDir, "steps.json"), "utf8");
    const final = safeJsonParse(finalRaw);
    if (final && typeof final === "object") {
      const success = shortJsonValue((final as Record<string, unknown>).success);
      const reason = shortJsonValue((final as Record<string, unknown>).reason);
      if (success || reason) lines.push(`- final: success=${success || "unknown"} reason=${reason || ""}`);
    }
  } catch {
    // Many interrupted CUA runs do not write steps.json; steps.jsonl is still useful.
  }

  return lines.join("\n");
}

async function runComputerUseCommand(params: {
  script: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  mode: "run" | "preflight";
  task?: string;
  timeoutMs: number;
}): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const startedAt = Date.now();
  const result = await runCommand({
    command: "bash",
    args: params.mode === "preflight" ? [params.script, "preflight"] : [params.script, "run", params.task ?? ""],
    cwd: params.cwd,
    env: params.env,
    timeoutMs: params.timeoutMs,
  });

  if (params.mode !== "run") return result;

  const runDir = extractRunDirFromStdout(result.stdout) ?? (await newestCuaRunDir(startedAt));
  const summary = await summarizeCuaRun(runDir);
  const status =
    result.exitCode === 0
      ? "completed"
      : result.exitCode === 130
        ? "interrupted_or_handoff"
        : result.signal
          ? "terminated"
          : "partial_or_failed";
  const guidance = [
    "",
    "",
    "computer_use_interpretation:",
    `- status: ${status}`,
    "- note: If cua_run_summary contains completed steps or extracted page information, do not report this as \"tool unavailable\". Report the partial result and the last completed step instead.",
    "- note: exitCode=130 from the underlying CUA often means interrupted/handoff/record-finalization failure, not that MCP or the query tool is unavailable.",
  ].join("\n");

  return {
    ...result,
    stdout: `${summary}${guidance}\n\nraw_stdout:\n${result.stdout.trim()}`.trim(),
  };
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

function resolveArkDrivePath(pathValue: unknown): { path?: string; error?: string } {
  const raw = stringifyParam(pathValue) ?? ".";
  const trimmed = raw.replace(/^\/+/, "");
  if (!trimmed || trimmed === ".") return { path: ARKDRIVE_MOUNT_PATH };
  const target = resolve(ARKDRIVE_MOUNT_PATH, trimmed);
  const rel = relative(ARKDRIVE_MOUNT_PATH, target);
  if (rel.startsWith("..") || rel === ".." || target !== ARKDRIVE_MOUNT_PATH && rel === "") {
    return { error: `path escapes ArkDrive mount: ${raw}` };
  }
  return { path: target };
}

async function isArkDriveMounted(): Promise<{ mounted: boolean; detail: string }> {
  const result = await runCommand({
    command: "bash",
    args: ["-lc", `mount | grep -F ' on ${ARKDRIVE_MOUNT_PATH} type fuse' || true`],
    cwd: "/root",
    env: process.env,
    timeoutMs: 10_000,
  });
  const line = result.stdout.trim();
  return {
    mounted: Boolean(line),
    detail: line || `No FUSE mount found at ${ARKDRIVE_MOUNT_PATH}`,
  };
}

async function formatArkDriveStatus(checkScript: string, skillDir: string, config: HermesPluginConfig): Promise<ToolResult> {
  try {
    await ensureExecutable(checkScript);
  } catch {
    const workspaceNetdriveDir = join(OPENCLAW_WORKSPACE_SKILLS_DIR, "workspace-netdrive");
    const workspaceDetectScript = join(workspaceNetdriveDir, "scripts", "detect_mounts.sh");
    try {
      await ensureExecutable(workspaceDetectScript);
    } catch {
      return { content: [{ type: "text", text: `Error: arkdrive-netdisk script not found: ${checkScript}` }] };
    }
    const result = await runCommand({
      command: "bash",
      args: [workspaceDetectScript],
      cwd: workspaceNetdriveDir,
      env: buildHostSkillEnv(config),
      timeoutMs: 30_000,
    });
    return formatProcessResult({ label: "workspace_netdrive status", ...result });
  }
  const result = await runCommand({
    command: "bash",
    args: [checkScript],
    cwd: skillDir,
    env: buildHostSkillEnv(config),
    timeoutMs: 30_000,
  });
  return formatProcessResult({ label: "arkdrive_netdisk status", ...result });
}

export function createHostBackedSkillTools(params: {
  config: HermesPluginConfig;
  logger: Logger;
}): HostBackedToolDefinition[] {
  const bytedWebSearchDir = join(OPENCLAW_WORKSPACE_SKILLS_DIR, "byted-web-search");
  const bytedWebSearchScript = join(bytedWebSearchDir, "scripts", "web_search.py");
  const computerUseDir = join(OPENCLAW_WORKSPACE_SKILLS_DIR, "computer-use");
  const computerUseScript = join(computerUseDir, "scripts", "cua.sh");
  const arkDriveDir = join(OPENCLAW_WORKSPACE_SKILLS_DIR, "arkdrive-netdisk");
  const arkDriveCheckScript = join(arkDriveDir, "scripts", "check_arkdrive.sh");

  return [{
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
  },
  {
    name: "computer_use",
    description: [
      "Run the host-backed computer-use CUA skill.",
      "This executes the OpenClaw computer-use script on the host so Hermes can request GUI/Office automation through MCP.",
      "The tool may require a multimodal model and can return model-switch or computer-handoff tags from the underlying skill.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["run", "preflight"],
          description: "Use preflight for local readiness checks without launching a full computer-use task.",
        },
        task: {
          type: "string",
          description: "Computer-use task content, including target app/page and expected result. Required when mode is run.",
        },
        timeoutSeconds: {
          type: "number",
          description: "Optional timeout in seconds. Defaults to 180 for run and 60 for preflight, capped at 300 for run and 3600 for preflight.",
        },
      },
    },
    async execute(_id: string, toolParams: Record<string, unknown>) {
      const mode = stringifyParam(toolParams.mode) === "preflight" ? "preflight" : "run";
      const task = stringifyParam(toolParams.task);
      if (mode === "run" && !task) return { content: [{ type: "text", text: "Error: task is required when mode is run" }] };
      try {
        await ensureExecutable(computerUseScript);
      } catch {
        return {
          content: [{ type: "text", text: `Error: computer-use script not found: ${computerUseScript}` }],
        };
      }
      const defaultTimeoutSeconds = mode === "preflight" ? 60 : 180;
      const maxTimeoutSeconds = mode === "preflight" ? 3600 : 300;
      const timeoutSeconds = Math.min(Math.max(numberParam(toolParams.timeoutSeconds) ?? defaultTimeoutSeconds, 10), maxTimeoutSeconds);
      params.logger.warn(`computer_use requested; mode=${mode} timeoutSeconds=${timeoutSeconds}`);
      const result = await runComputerUseCommand({
        script: computerUseScript,
        mode,
        task,
        cwd: computerUseDir,
        env: buildHostSkillEnv(params.config),
        timeoutMs: timeoutSeconds * 1000,
      });
      return formatProcessResult({ label: "computer_use", ...result });
    },
  },
  {
    name: "arkdrive_netdisk",
    description: [
      "Run host-backed ArkDrive netdisk operations.",
      "This tool checks and writes the host ArkDrive mount at /root/.openclaw/workspace/arkdrive_uploads through OpenClaw MCP.",
      "Use this instead of running the projected arkdrive-netdisk skill inside the Hermes container, because FUSE mount state is host-scoped.",
      "The internal ._arkdrive_lock file is hidden from list output and must not be modified.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "list", "mkdir", "write_text"],
          description: "Operation to run. Use status before write operations.",
        },
        path: {
          type: "string",
          description: "Relative path inside ArkDrive. Defaults to the ArkDrive root.",
        },
        content: {
          type: "string",
          description: "UTF-8 content for write_text.",
        },
      },
    },
    async execute(_id: string, toolParams: Record<string, unknown>) {
      const action = stringifyParam(toolParams.action) ?? "status";
      if (action === "status") {
        return await formatArkDriveStatus(arkDriveCheckScript, arkDriveDir, params.config);
      }

      const mount = await isArkDriveMounted();
      if (!mount.mounted) {
        return {
          content: [
            {
              type: "text",
              text: [
                "arkdrive_netdisk unavailable",
                `mountPath: ${ARKDRIVE_MOUNT_PATH}`,
                mount.detail,
                "ArkDrive is not enabled or not mounted on the host.",
              ].join("\n"),
            },
          ],
        };
      }

      const resolved = resolveArkDrivePath(toolParams.path);
      if (resolved.error || !resolved.path) {
        return { content: [{ type: "text", text: `Error: ${resolved.error ?? "invalid ArkDrive path"}` }] };
      }
      if (resolved.path.endsWith("/._arkdrive_lock") || resolved.path === join(ARKDRIVE_MOUNT_PATH, "._arkdrive_lock")) {
        return { content: [{ type: "text", text: "Error: ._arkdrive_lock is internal and cannot be modified or exposed" }] };
      }

      if (action === "list") {
        const entries = await readdir(resolved.path, { withFileTypes: true });
        const lines = entries
          .filter((entry) => entry.name !== "._arkdrive_lock")
          .map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`)
          .sort();
        return {
          content: [
            {
              type: "text",
              text: [`arkdrive_netdisk list`, `path: ${relative(ARKDRIVE_MOUNT_PATH, resolved.path) || "."}`, ...lines].join("\n"),
            },
          ],
        };
      }

      if (action === "mkdir") {
        await mkdir(resolved.path, { recursive: true });
        return { content: [{ type: "text", text: `arkdrive_netdisk mkdir ok: ${relative(ARKDRIVE_MOUNT_PATH, resolved.path) || "."}` }] };
      }

      if (action === "write_text") {
        const content = stringifyParam(toolParams.content);
        if (content === undefined) return { content: [{ type: "text", text: "Error: content is required for write_text" }] };
        await mkdir(resolve(resolved.path, ".."), { recursive: true });
        await writeFile(resolved.path, content, "utf8");
        return { content: [{ type: "text", text: `arkdrive_netdisk write_text ok: ${relative(ARKDRIVE_MOUNT_PATH, resolved.path)}` }] };
      }

      return { content: [{ type: "text", text: `Error: unsupported arkdrive_netdisk action: ${action}` }] };
    },
  }];
}

export function registerHostBackedSkillTools(params: {
  api: any;
  config: HermesPluginConfig;
  logger: Logger;
}): void {
  for (const tool of createHostBackedSkillTools(params)) {
    params.api.registerTool(tool);
  }
}
