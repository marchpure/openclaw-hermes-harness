import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createHostBackedSkillTools, type HostBackedToolDefinition } from "./host-skill-tools.js";
import type { HermesPluginConfig } from "./types.js";

type Logger = {
  warn: (msg: string, ...args: unknown[]) => void;
};

type PrivateMcpContext = {
  upstreamUrl?: string;
  upstreamHeaders: Record<string, string>;
  tools: Map<string, HostBackedToolDefinition>;
};

type PrivateMcpRuntime = {
  port: number;
  token: string;
  serverConfig: Record<string, unknown>;
};

const contexts = new Map<string, PrivateMcpContext>();
let serverPromise: Promise<{ port: number }> | undefined;
let serverInstance: ReturnType<typeof createServer> | undefined;

export async function createPrivateOpenClawMcpBridge(params: {
  config: HermesPluginConfig;
  logger: Logger;
  upstreamServer?: unknown;
}): Promise<PrivateMcpRuntime> {
  const server = await ensurePrivateMcpServer();
  const token = randomBytes(32).toString("hex");
  const tools = createHostBackedSkillTools({ config: params.config, logger: params.logger });
  const upstream = normalizeHttpMcpServer(params.upstreamServer);

  contexts.set(token, {
    upstreamUrl: upstream?.url,
    upstreamHeaders: upstream?.headers ?? {},
    tools: new Map(tools.map((tool) => [tool.name, tool])),
  });

  return {
    port: server.port,
    token,
    serverConfig: {
      type: "http",
      url: `http://127.0.0.1:${server.port}/mcp`,
      headers: {
        Authorization: `Bearer ${token}`,
      },
      _meta: {
        openclaw: {
          timeout: 600,
          connectTimeout: 60,
        },
      },
    },
  };
}

function normalizeHttpMcpServer(value: unknown): { url: string; headers: Record<string, string> } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const url = typeof record.url === "string" && record.url.trim() ? record.url.trim() : undefined;
  if (!url) return undefined;
  const headers = record.headers && typeof record.headers === "object" && !Array.isArray(record.headers)
    ? Object.fromEntries(
        Object.entries(record.headers as Record<string, unknown>).flatMap(([key, raw]) =>
          typeof raw === "string" ? [[key, raw]] : [],
        ),
      )
    : {};
  return { url, headers };
}

async function ensurePrivateMcpServer(): Promise<{ port: number }> {
  if (serverPromise) return serverPromise;
  serverPromise = new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      void handleRequest(req, res).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
        }
        res.end(JSON.stringify(jsonRpcError(null, -32603, err instanceof Error ? err.message : String(err))));
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      serverInstance = server;
      const address = server.address() as AddressInfo;
      resolve({ port: address.port });
    });
  });
  return serverPromise;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST" });
    res.end();
    return;
  }
  const auth = req.headers.authorization ?? "";
  const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  const context = contexts.get(token);
  if (!context) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  const body = await readBody(req);
  const parsed = JSON.parse(body);
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const responses = [];
  for (const message of messages) {
    const response = await handleJsonRpc(context, message);
    if (response !== null) responses.push(response);
  }
  if (responses.length === 0) {
    res.writeHead(202);
    res.end();
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(Array.isArray(parsed) ? responses : responses[0]));
}

async function handleJsonRpc(context: PrivateMcpContext, message: Record<string, unknown>): Promise<unknown> {
  const id = message.id as string | number | null | undefined;
  const method = message.method;
  if (method === "initialize") {
    return jsonRpcResult(id, {
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "openclaw", version: "hermes-private" },
    });
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return null;
  if (method === "tools/list") {
    const upstreamTools = await listUpstreamTools(context);
    return jsonRpcResult(id, {
      tools: mergeToolSchemas(upstreamTools, [...context.tools.values()].map(toolToSchema)),
    });
  }
  if (method === "tools/call") {
    const params = message.params && typeof message.params === "object" ? message.params as Record<string, unknown> : {};
    const name = typeof params.name === "string" ? params.name : "";
    const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
      ? params.arguments as Record<string, unknown>
      : {};
    const privateTool = context.tools.get(name);
    if (privateTool) {
      try {
        const result = await privateTool.execute(`mcp-${Date.now()}`, args);
        return jsonRpcResult(id, { content: result.content, isError: false });
      } catch (err) {
        return jsonRpcResult(id, {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        });
      }
    }
    return await proxyUpstreamJsonRpc(context, message);
  }
  if (context.upstreamUrl) return await proxyUpstreamJsonRpc(context, message);
  return jsonRpcError(id, -32601, `Method not found: ${String(method)}`);
}

async function listUpstreamTools(context: PrivateMcpContext): Promise<Array<Record<string, unknown>>> {
  if (!context.upstreamUrl) return [];
  try {
    const response = await proxyUpstreamJsonRpc(context, {
      jsonrpc: "2.0",
      id: "tools-list",
      method: "tools/list",
      params: {},
    }) as Record<string, unknown>;
    const result = response.result as Record<string, unknown> | undefined;
    return Array.isArray(result?.tools) ? result.tools as Array<Record<string, unknown>> : [];
  } catch {
    return [];
  }
}

async function proxyUpstreamJsonRpc(context: PrivateMcpContext, message: Record<string, unknown>): Promise<unknown> {
  if (!context.upstreamUrl) {
    return jsonRpcResult(message.id as string | number | null | undefined, {
      content: [{ type: "text", text: "OpenClaw upstream MCP bridge is unavailable" }],
      isError: true,
    });
  }
  const response = await fetch(context.upstreamUrl, {
    method: "POST",
    headers: {
      ...context.upstreamHeaders,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
  });
  return await response.json();
}

function mergeToolSchemas(
  upstreamTools: Array<Record<string, unknown>>,
  privateTools: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const merged = new Map<string, Record<string, unknown>>();
  for (const tool of upstreamTools) {
    if (typeof tool.name === "string") merged.set(tool.name, tool);
  }
  for (const tool of privateTools) {
    if (typeof tool.name === "string") merged.set(tool.name, tool);
  }
  return [...merged.values()];
}

function toolToSchema(tool: HostBackedToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
  };
}

function jsonRpcResult(id: string | number | null | undefined, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function jsonRpcError(id: string | number | null | undefined, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function readBody(req: IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function closePrivateOpenClawMcpServer(): Promise<void> {
  contexts.clear();
  const server = serverInstance;
  if (!server) return;
  serverInstance = undefined;
  serverPromise = undefined;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
}
