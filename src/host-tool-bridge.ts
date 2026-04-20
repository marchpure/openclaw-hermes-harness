import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HostCapability } from "./host-capabilities.js";
import { HERMES_HOST_CAPABILITIES } from "./host-capabilities.js";

const execFileAsync = promisify(execFile);
const LARK_QUERY_MAX_LENGTH = 50;
const HOST_TOOL_TIMEOUT_MS = 30_000;
const LARK_UPDATE_MODES = new Set([
  "append",
  "overwrite",
  "replace_range",
  "replace_all",
  "insert_before",
  "insert_after",
  "delete_range",
]);

type ExecFileLike = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

type HostToolErrorCode = "invalid_tool" | "invalid_arguments" | "permission_denied" | "execution_failed" | "invalid_response";

export type HostToolBridgeDeps = {
  execFile?: ExecFileLike;
};

export type HostToolBridgeResult =
  | {
      ok: true;
      tool: HostCapability["name"];
      contentType: "application/json" | "text/markdown";
      content: string;
      raw: unknown;
    }
  | {
      ok: false;
      tool: HostCapability["name"] | string;
      error: {
        code: HostToolErrorCode;
        message: string;
      };
    };

export async function executeHermesHostTool(
  tool: string,
  args: unknown,
  deps: HostToolBridgeDeps = {},
): Promise<HostToolBridgeResult> {
  if (!isHostCapabilityName(tool)) {
    return hostToolError(tool, "invalid_tool", `Unsupported host tool: ${tool}`);
  }

  if (tool === "lark.docs.search") {
    const query = readStringArg(args, "query");
    if (!query) {
      return hostToolError(tool, "invalid_arguments", "lark.docs.search requires a non-empty query string");
    }
    if (query.length > LARK_QUERY_MAX_LENGTH) {
      return hostToolError(
        tool,
        "invalid_arguments",
        `lark.docs.search query must be ${LARK_QUERY_MAX_LENGTH} characters or fewer`,
      );
    }
    return executeLarkCli(tool, ["docs", "+search", "--query", query, "--as", "user", "--format", "json"], deps);
  }

  if (tool === "lark.docs.fetch") {
    const doc = readStringArg(args, "doc");
    if (!doc) {
      return hostToolError(tool, "invalid_arguments", "lark.docs.fetch requires a non-empty doc string");
    }
    return executeLarkCli(tool, ["docs", "+fetch", "--doc", doc, "--as", "user", "--format", "json"], deps);
  }

  if (tool === "lark.docs.create") {
    const title = readStringArg(args, "title");
    const markdown = readStringArg(args, "markdown");
    if (!title || !markdown) {
      return hostToolError(tool, "invalid_arguments", "lark.docs.create requires non-empty title and markdown strings");
    }
    const cliArgs = ["docs", "+create", "--title", title, "--markdown", markdown, "--as", "user"];
    const folderToken = readStringArg(args, "folderToken");
    if (folderToken) {
      cliArgs.push("--folder-token", folderToken);
    }
    return executeLarkCli(tool, cliArgs, deps);
  }

  const doc = readStringArg(args, "doc");
  const mode = readStringArg(args, "mode");
  if (!doc || !mode) {
    return hostToolError(tool, "invalid_arguments", "lark.docs.update requires non-empty doc and mode strings");
  }
  if (!LARK_UPDATE_MODES.has(mode)) {
    return hostToolError(tool, "invalid_arguments", `Unsupported lark.docs.update mode: ${mode}`);
  }
  const cliArgs = ["docs", "+update", "--doc", doc, "--mode", mode, "--as", "user"];
  const markdown = readStringArg(args, "markdown");
  if (mode !== "delete_range" && !markdown) {
    return hostToolError(tool, "invalid_arguments", `lark.docs.update mode ${mode} requires markdown`);
  }
  if (markdown) {
    cliArgs.push("--markdown", markdown);
  }
  const selectionWithEllipsis = readStringArg(args, "selectionWithEllipsis");
  const selectionByTitle = readStringArg(args, "selectionByTitle");
  if (selectionWithEllipsis) {
    cliArgs.push("--selection-with-ellipsis", selectionWithEllipsis);
  }
  if (selectionByTitle) {
    cliArgs.push("--selection-by-title", selectionByTitle);
  }
  const newTitle = readStringArg(args, "newTitle");
  if (newTitle) {
    cliArgs.push("--new-title", newTitle);
  }
  return executeLarkCli(tool, cliArgs, deps);
}

function isHostCapabilityName(tool: string): tool is HostCapability["name"] {
  return HERMES_HOST_CAPABILITIES.some((capability) => capability.name === tool);
}

async function executeLarkCli(
  tool: HostCapability["name"],
  args: string[],
  deps: HostToolBridgeDeps,
): Promise<HostToolBridgeResult> {
  const runExecFile = deps.execFile ?? execFileAsync;
  try {
    const { stdout } = await runExecFile("lark-cli", args, {
      timeout: HOST_TOOL_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024,
    });
    return parseLarkCliResult(tool, stdout);
  } catch (err) {
    return hostToolError(tool, classifyExecError(err), extractErrorMessage(err));
  }
}

function parseLarkCliResult(tool: HostCapability["name"], stdout: string): HostToolBridgeResult {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return hostToolError(tool, "invalid_response", "lark-cli returned non-JSON output");
  }

  if (!isRecord(raw)) {
    return hostToolError(tool, "invalid_response", "lark-cli returned an unexpected JSON response");
  }

  if (raw.ok === false) {
    return hostToolError(tool, classifyLarkError(raw), readErrorFromLarkResponse(raw));
  }

  if (tool === "lark.docs.fetch") {
    const data = isRecord(raw.data) ? raw.data : {};
    const markdown = typeof data.markdown === "string" ? data.markdown : "";
    return {
      ok: true,
      tool,
      contentType: "text/markdown",
      content: markdown,
      raw,
    };
  }

  if (tool === "lark.docs.create" || tool === "lark.docs.update") {
    return {
      ok: true,
      tool,
      contentType: "application/json",
      content: JSON.stringify(raw, null, 2),
      raw,
    };
  }

  return {
    ok: true,
    tool,
    contentType: "application/json",
    content: JSON.stringify(raw, null, 2),
    raw,
  };
}

function readStringArg(args: unknown, key: string): string | null {
  if (!isRecord(args)) return null;
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function classifyExecError(err: unknown): HostToolErrorCode {
  const message = extractErrorMessage(err);
  if (/permission|scope|auth|login|unauthorized|forbidden/i.test(message)) {
    return "permission_denied";
  }
  return "execution_failed";
}

function classifyLarkError(raw: Record<string, unknown>): HostToolErrorCode {
  const message = readErrorFromLarkResponse(raw);
  if (/permission|scope|auth|login|unauthorized|forbidden/i.test(message)) {
    return "permission_denied";
  }
  return "execution_failed";
}

function readErrorFromLarkResponse(raw: Record<string, unknown>): string {
  const message = raw.message ?? raw.error ?? raw.msg;
  if (typeof message === "string" && message.trim()) {
    return message.trim();
  }
  return "lark-cli returned an error";
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const stderr = "stderr" in err && typeof err.stderr === "string" ? err.stderr.trim() : "";
    return stderr || err.message;
  }
  return String(err);
}

function hostToolError(
  tool: HostCapability["name"] | string,
  code: HostToolErrorCode,
  message: string,
): HostToolBridgeResult {
  return {
    ok: false,
    tool,
    error: {
      code,
      message,
    },
  };
}
