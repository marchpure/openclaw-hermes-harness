import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { executeHermesHostTool, type HostToolBridgeResult } from "./host-tool-bridge.js";
import type { HermesPluginConfig } from "./types.js";

const HOST_TOOL_PATH = "/__openclaw/hermes-host-tool";
const REQUEST_BODY_LIMIT_BYTES = 128 * 1024;

type HostToolLogger = {
  info?: (msg: string, ...args: unknown[]) => void;
  warn?: (msg: string, ...args: unknown[]) => void;
  error?: (msg: string, ...args: unknown[]) => void;
};

type HostToolServerState = {
  server: Server;
  host: string;
  port: number;
};

let activeServer: HostToolServerState | undefined;

export async function startHermesHostToolServer(
  config: HermesPluginConfig,
  logger: HostToolLogger = {},
): Promise<HostToolServerState | undefined> {
  if (!config.hostBridgeEnabled) {
    return undefined;
  }

  const host = config.hostBridgeHost;
  const port = config.hostBridgePort;
  if (activeServer && activeServer.host === host && activeServer.port === port) {
    return activeServer;
  }

  if (activeServer) {
    await closeServer(activeServer.server);
    activeServer = undefined;
  }

  const server = createServer((req, res) => {
    void handleHostToolRequest(req, res, logger);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  activeServer = { server, host, port };
  logger.info?.(`Hermes host tool bridge listening on http://${host}:${port}${HOST_TOOL_PATH}`);
  return activeServer;
}

export async function stopHermesHostToolServerForTest(): Promise<void> {
  if (!activeServer) return;
  await closeServer(activeServer.server);
  activeServer = undefined;
}

async function handleHostToolRequest(
  req: IncomingMessage,
  res: ServerResponse,
  logger: HostToolLogger,
): Promise<void> {
  if (req.method !== "POST" || req.url !== HOST_TOOL_PATH) {
    writeJson(res, 404, { ok: false, error: { code: "not_found", message: "Not found" } });
    return;
  }

  const body = await readRequestBody(req);
  if (!body.ok) {
    writeJson(res, 400, { ok: false, error: body.error });
    return;
  }

  const request = parseHostToolRequest(body.text);
  if (!request.ok) {
    writeJson(res, 400, { ok: false, error: request.error });
    return;
  }

  logger.info?.(`Hermes host tool request: ${request.tool}`);
  const result = await executeHermesHostTool(request.tool, request.arguments);
  writeJson(res, result.ok ? 200 : statusForHostToolError(result), result);
}

async function readRequestBody(
  req: IncomingMessage,
): Promise<{ ok: true; text: string } | { ok: false; error: { code: string; message: string } }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > REQUEST_BODY_LIMIT_BYTES) {
      return { ok: false, error: { code: "request_too_large", message: "Request body is too large" } };
    }
    chunks.push(buffer);
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

function parseHostToolRequest(
  text: string,
): { ok: true; tool: string; arguments: unknown } | { ok: false; error: { code: string; message: string } } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: { code: "invalid_json", message: "Request body must be valid JSON" } };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: { code: "invalid_request", message: "Request body must be a JSON object" } };
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.tool !== "string" || !record.tool.trim()) {
    return { ok: false, error: { code: "invalid_request", message: "Request requires a non-empty tool" } };
  }
  return { ok: true, tool: record.tool.trim(), arguments: record.arguments };
}

function statusForHostToolError(result: HostToolBridgeResult): number {
  if (result.ok) return 200;
  if (result.error.code === "invalid_tool") return 404;
  if (result.error.code === "invalid_arguments") return 400;
  if (result.error.code === "permission_denied") return 403;
  return 500;
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(`${JSON.stringify(body)}\n`);
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
