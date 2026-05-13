/**
 * openclaw-plugin-hermes — ACP Client
 *
 * Lightweight JSON-RPC client that communicates with Hermes Agent via the
 * Agent Client Protocol (ACP) over the local TCP bridge on port 3100.
 *
 * ACP method names use namespace format:
 *   initialize, session/new, session/prompt, session/cancel, session/close
 */

import * as net from "node:net";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { EventEmitter } from "node:events";
import type {
  AcpJsonRpcRequest,
  AcpJsonRpcResponse,
  AcpSessionEvent,
  HermesAcpSessionOptions,
  HermesPluginConfig,
} from "./types.js";

// ─── Logger (plugin-compatible) ─────────────────────────────────────────────

interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug?(msg: string, ...args: unknown[]): void;
}

const defaultLogger: Logger = {
  info: (msg, ...args) => console.log(`[hermes-acp] ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`[hermes-acp] WARN ${msg}`, ...args),
  error: (msg, ...args) => console.error(`[hermes-acp] ERROR ${msg}`, ...args),
  debug: (msg, ...args) => console.debug(`[hermes-acp] DEBUG ${msg}`, ...args),
};

const STREAM_IDLE_FINALIZE_MS = 2500;
const ACP_INITIALIZE_STABILITY_MS = 25;
const ACP_CLOSE_TIMEOUT_MS = 1000;
const ACP_CLOSE_SESSION_ON_DISCONNECT =
  process.env.HERMES_ACP_CLOSE_SESSION_ON_DISCONNECT === "true";

type AcpEnvVariable = { name: string; value: string };
type AcpMcpServer =
  | { type: "stdio"; name: string; command: string; args: string[]; env: AcpEnvVariable[]; _meta?: Record<string, unknown> }
  | { type: "http"; name: string; url: string; headers: AcpEnvVariable[]; _meta?: Record<string, unknown> }
  | { type: "sse"; name: string; url: string; headers: AcpEnvVariable[]; _meta?: Record<string, unknown> };

// ─── ACP Client ─────────────────────────────────────────────────────────────

export class HermesAcpClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private readline: ReadlineInterface | null = null;
  private requestId = 0;
  private pendingRequests = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer?: ReturnType<typeof setTimeout> }
  >();
  private sessionId: string | null = null;
  private stderr = "";
  private connected = false;
  private closing = false;
  private logger: Logger;

  constructor(
    private config: HermesPluginConfig,
    logger?: Logger,
  ) {
    super();
    this.logger = logger ?? defaultLogger;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Connect to Hermes over the local ACP TCP bridge, then initialize ACP.
   */
  async start(): Promise<void> {
    if (this.connected) {
      throw new Error("ACP client already connected");
    }
    this.closing = false;

    await this.startTcp();

    // Initialize immediately after the socket is live so callers fail fast if
    // the local bridge is reachable but not speaking ACP correctly.
    const initResult = await this.sendRequestResult("initialize", {
      protocol_version: 1,
      client_info: { name: "openclaw-plugin-hermes", version: "1.0.0" },
      client_capabilities: {},
    });
    await new Promise<void>((resolve) => setTimeout(resolve, ACP_INITIALIZE_STABILITY_MS));
    if (!this.socket || this.socket.destroyed) {
      throw new Error("TCP connection closed during ACP initialize");
    }

    this.connected = true;
    this.logger.info(`ACP initialized (tcp): ${JSON.stringify(initResult)}`);
  }

  // ─── TCP Transport ────────────────────────────────────────────────────

  private startTcp(): Promise<void> {
    return new Promise((resolve, reject) => {
      const { tcpHost, tcpPort } = this.config;
      this.logger.info(`TCP connecting: ${tcpHost}:${tcpPort}`);

      this.socket = net.createConnection({ host: tcpHost, port: tcpPort });
      let startSettled = false;

      const connectTimeout = setTimeout(() => {
        if (startSettled) return;
        startSettled = true;
        this.socket?.destroy();
        reject(new Error(`TCP connection to ${tcpHost}:${tcpPort} timed out after 10s`));
      }, 10000);

      this.socket.on("connect", () => {
        if (startSettled) return;
        startSettled = true;
        clearTimeout(connectTimeout);
        this.logger.info(`TCP connected: ${tcpHost}:${tcpPort}`);

        // Set up line-by-line NDJSON reader on the socket
        this.readline = createInterface({ input: this.socket! });
        this.readline.on("line", (line: string) => this.handleLine(line));

        resolve();
      });

      this.socket.on("error", (err: Error) => {
        this.logger.error(`TCP error: ${err.message}`);
        if (!this.connected) {
          if (startSettled) return;
          startSettled = true;
          clearTimeout(connectTimeout);
          reject(err);
        } else {
          clearTimeout(connectTimeout);
          this.connected = false;
          this.rejectAllPending(err);
          this.emit("error", err);
        }
      });

      this.socket.on("close", () => {
        const wasConnected = this.connected;
        const wasClosing = this.closing;
        this.connected = false;
        this.logger.info("TCP connection closed");
        this.rejectAllPending(new Error(wasClosing ? "ACP client closed" : "TCP connection closed"));
        if (wasConnected && !wasClosing) {
          this.emit("exit", { code: null, signal: null });
        }
      });
    });
  }

  // ─── Session Management ─────────────────────────────────────────────────

  /**
   * Create a new ACP session.
   * ACP method: "session/new"
   */
  async newSession(options: HermesAcpSessionOptions): Promise<string> {
    const result = (await this.sendRequestResult("session/new", buildSessionParams(options))) as {
      session_id?: string;
      sessionId?: string;
    };
    this.sessionId = result.session_id ?? result.sessionId ?? "";
    this.logger.info(`Session created: ${this.sessionId}`);
    return this.sessionId;
  }

  /**
   * Load an existing ACP session without creating a replacement when missing.
   * ACP method: "session/load"
   */
  async loadSession(sessionId: string, options: HermesAcpSessionOptions): Promise<string> {
    const result = (await this.sendRequestResult("session/load", {
      session_id: sessionId,
      ...buildSessionParams(options),
    })) as { session_id?: string; sessionId?: string } | null;
    if (!result) {
      throw new Error(`ACP session ${sessionId} not found`);
    }
    this.sessionId = result.session_id ?? result.sessionId ?? sessionId;
    this.logger.info(`Session loaded: ${this.sessionId}`);
    return this.sessionId;
  }

  /**
   * Resume an existing ACP session.
   * ACP method: "session/resume"
   */
  async resumeSession(sessionId: string, options: HermesAcpSessionOptions): Promise<string> {
    const result = (await this.sendRequestResult("session/resume", {
      session_id: sessionId,
      ...buildSessionParams(options),
    })) as { session_id?: string; sessionId?: string };
    this.sessionId = result.session_id ?? result.sessionId ?? sessionId;
    this.logger.info(`Session resumed: ${this.sessionId}`);
    return this.sessionId;
  }

  /**
   * Send a prompt and collect streaming events.
   * ACP method: "session/prompt"
   * Returns the final response text and emits events along the way.
   */
  async prompt(
    text: string,
    sessionId?: string,
    options?: {
      timeout?: number;
      signal?: AbortSignal;
      onEvent?: (event: AcpSessionEvent) => void | Promise<void>;
    },
  ): Promise<{ text: string; events: AcpSessionEvent[]; usage?: { input_tokens: number; output_tokens: number; total_tokens: number; cache_read_tokens?: number; cache_write_tokens?: number } }> {
    const sid = sessionId ?? this.sessionId;
    if (!sid) {
      throw new Error("No active session. Call newSession() first.");
    }

    const timeout = options?.timeout ?? this.config.timeout * 1000;
    const events: AcpSessionEvent[] = [];
    let finalText = "";
    let usage: { input_tokens: number; output_tokens: number; total_tokens: number; cache_read_tokens?: number; cache_write_tokens?: number } | undefined;

    return new Promise((resolve, reject) => {
      let settled = false;
      let promptAcked = false;
      let promptResponseText = "";
      let idleFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
      let abortHandler: (() => void) | undefined;
      let promptRequestId: number | undefined;
      const clearIdleFinalizeTimer = (): void => {
        if (idleFinalizeTimer) {
          clearTimeout(idleFinalizeTimer);
          idleFinalizeTimer = undefined;
        }
      };
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        clearIdleFinalizeTimer();
        if (abortHandler) {
          options?.signal?.removeEventListener("abort", abortHandler);
          abortHandler = undefined;
        }
        if (promptRequestId !== undefined) {
          this.cancelPendingRequest(promptRequestId, new Error("ACP prompt settled before request response"));
          promptRequestId = undefined;
        }
        this.off("session-event-raw", eventHandler);
        fn();
      };
      const scheduleIdleFinalize = (): void => {
        if (!finalText && !promptResponseText) return;
        clearIdleFinalizeTimer();
        idleFinalizeTimer = setTimeout(() => {
          this.logger.warn(
            `No ACP terminal event received for ${STREAM_IDLE_FINALIZE_MS}ms after stream output; finalizing prompt from accumulated text`,
          );
          settle(() => resolve({ text: finalText || promptResponseText, events, usage }));
        }, STREAM_IDLE_FINALIZE_MS);
      };
      const timeoutTimer = setTimeout(() => {
        settle(() => reject(new Error(`Hermes prompt timed out after ${timeout / 1000}s`)));
      }, timeout);

      // Set up a temporary line handler for streaming events
      const eventHandler = (event: AcpSessionEvent) => {
        events.push(event);
        this.emit("session-event", event);
        try {
          void Promise.resolve(options?.onEvent?.(event)).catch(() => {});
        } catch {
          // Best effort only
        }

        if (event.type === "text" && event.text) {
          finalText += event.text;
          scheduleIdleFinalize();
        } else if (finalText || promptResponseText) {
          scheduleIdleFinalize();
        }
        if (event.type === "done") {
          settle(() => resolve({ text: finalText || promptResponseText, events, usage }));
        }
        if (event.type === "error") {
          settle(() => reject(new Error(event.message ?? "Hermes returned an error")));
        }
      };

      this.on("session-event-raw", eventHandler);

      // Handle abort signal
      if (options?.signal) {
        abortHandler = () => {
          this.cancel(sid).catch(() => {});
          settle(() => reject(new Error("Prompt aborted")));
        };
        if (options.signal.aborted) {
          abortHandler();
          return;
        }
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      // Send the prompt request
      const promptRequest = this.sendRequest("session/prompt", {
        session_id: sid,
        prompt: [{ type: "text", text }],
      }, timeout + 10000);
      promptRequestId = promptRequest.id;
      promptRequest.promise.then((result) => {
        const promptResult = result as Record<string, unknown>;
        promptRequestId = undefined;
        promptAcked = true;
        if (promptResult.usage) {
          const u = promptResult.usage as Record<string, number>;
          const inputTokens = u.input_tokens ?? u.inputTokens ?? 0;
          const outputTokens = u.output_tokens ?? u.outputTokens ?? 0;
          usage = {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: u.total_tokens ?? u.totalTokens ?? (inputTokens + outputTokens),
            cache_read_tokens: u.cache_read_tokens ?? u.cacheReadTokens ?? undefined,
            cache_write_tokens: u.cache_write_tokens ?? u.cacheWriteTokens ?? undefined,
          };
        }
        promptResponseText =
          extractAcpText(promptResult.output) ??
          extractAcpText(promptResult.content) ??
          extractAcpText(promptResult.result) ??
          (typeof promptResult.text === "string" ? promptResult.text : "");
        const stopReason = typeof promptResult.stopReason === "string" ? promptResult.stopReason : "";
        const hasTerminalPayload =
          Boolean(promptResponseText) ||
          promptResult.done === true ||
          isTerminalStopReason(stopReason);
        if (hasTerminalPayload) {
          if (!finalText && promptResponseText) {
            finalText = promptResponseText;
          }
          settle(() => resolve({ text: finalText, events, usage }));
          return;
        }
        // Some Hermes ACP servers ACK session/prompt immediately and stream the
        // actual turn via session updates afterwards. In that case keep the
        // connection open until a terminal event arrives or timeout fires.
      }).catch((err) => {
        promptRequestId = undefined;
        if (promptAcked && !settled && (finalText || promptResponseText)) {
          settle(() => resolve({ text: finalText || promptResponseText, events, usage }));
          return;
        }
        settle(() => reject(err));
      });
    });
  }

  /**
   * Cancel a running session.
   * ACP method: "session/cancel"
   */
  async cancel(sessionId?: string): Promise<void> {
    const sid = sessionId ?? this.sessionId;
    if (!sid) return;
    try {
      await this.sendRequestResult("session/cancel", { session_id: sid });
    } catch {
      // Best-effort cancel
    }
  }

  /**
   * Close the ACP connection.
   */
  async close(): Promise<void> {
    this.closing = true;
    if (this.sessionId && ACP_CLOSE_SESSION_ON_DISCONNECT) {
      try {
        await this.sendRequest("session/close", { session_id: this.sessionId }, ACP_CLOSE_TIMEOUT_MS).promise;
      } catch {
        // Best-effort
      }
    }
    this.connected = false;
    this.readline?.close();
    this.readline = null;

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }

    this.sessionId = null;
    this.rejectAllPending(new Error("ACP client closed"));
  }

  /** Whether the ACP connection is active */
  get isConnected(): boolean {
    return this.connected;
  }

  /** Get the current session ID */
  get currentSessionId(): string | null {
    return this.sessionId;
  }

  /** Get collected stderr (for diagnostics) */
  get stderrOutput(): string {
    return this.stderr;
  }

  // ─── Internal: I/O ──────────────────────────────────────────────────────

  /** Write one NDJSON frame to the active TCP socket. */
  private writeData(data: string): void {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("TCP socket not connected");
    }
    this.socket.write(data);
  }

  private sendRequest(
    method: string,
    params?: Record<string, unknown>,
    timeoutOverrideMs?: number,
  ): { id: number; promise: Promise<unknown> } {
    const id = ++this.requestId;
    const request: AcpJsonRpcRequest = {
      jsonrpc: "2.0",
      method,
      params: params ?? {},
      id,
    };

    const promise = new Promise<unknown>((resolve, reject) => {
      const timeoutMs = timeoutOverrideMs ?? (method === "session/prompt"
        ? (this.config.timeout * 1000 + 10000)
        : 30000);

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`ACP request ${method} (id=${id}) timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      try {
        this.writeData(JSON.stringify(request) + "\n");
      } catch (err) {
        this.pendingRequests.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    return { id, promise };
  }

  private async sendRequestResult(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.sendRequest(method, params).promise;
  }

  private cancelPendingRequest(id: number, error: Error): void {
    const pending = this.pendingRequests.get(id);
    if (!pending) return;
    this.pendingRequests.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.reject(error);
  }

  // ─── Internal: Message Parsing (shared by both transports) ────────────

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.logger.debug?.(`Non-JSON line: ${trimmed}`);
      return;
    }

    // Check if it's a JSON-RPC response (has id field matching a pending request)
    if ("id" in parsed && typeof parsed.id === "number") {
      const pending = this.pendingRequests.get(parsed.id);
      if (pending) {
        this.pendingRequests.delete(parsed.id);
        if (pending.timer) clearTimeout(pending.timer);

        const response = parsed as unknown as AcpJsonRpcResponse;
        if (response.error) {
          pending.reject(new Error(`ACP error [${response.error.code}]: ${response.error.message}`));
        } else {
          pending.resolve(response.result);
        }
        return;
      }
    }

    // Check for JSON-RPC notification (no id, has method — server → client)
    if ("method" in parsed && !("id" in parsed)) {
      this.handleNotification(parsed);
      return;
    }

    // Otherwise treat as a streaming session event
    const event = this.parseSessionEvent(parsed);
    if (event) {
      this.emit("session-event-raw", event);
    }
  }

  private handleNotification(data: Record<string, unknown>): void {
    const method = data.method as string;
    const params = (data.params ?? {}) as Record<string, unknown>;

    if (method === "session/update" || method === "notifications/session") {
      const update = params.update ?? params;
      const event = this.parseSessionEvent(update as Record<string, unknown>);
      if (event) {
        this.emit("session-event-raw", event);
      }
      return;
    }

    if (method === "session/request_permission") {
      const toolCall = (params.toolCall ?? {}) as Record<string, unknown>;
      const event = this.parseSessionEvent({
        ...toolCall,
        sessionUpdate: "tool_call_update",
        status: "pending",
      });
      if (event) {
        this.emit("session-event-raw", event);
      }
    }
  }

  private parseSessionEvent(data: Record<string, unknown>): AcpSessionEvent | null {
    const sessionUpdate = data.sessionUpdate as string | undefined;
    const type = data.type as string | undefined;

    if (sessionUpdate === "agent_message_text" || sessionUpdate === "agentMessageText" || sessionUpdate === "agent_message_chunk") {
      const text = extractAcpText(data.content) ?? (data.text as string) ?? "";
      return { type: "text", text };
    }

    if (sessionUpdate === "agent_thought" || sessionUpdate === "agentThought" ||
        sessionUpdate === "agent_thinking" || sessionUpdate === "agent_thought_chunk" || type === "thinking") {
      const text = extractAcpText(data.content) ?? (data.text as string) ?? "";
      return { type: "thinking", text };
    }

    if (sessionUpdate === "tool_call_begin" || sessionUpdate === "toolCallBegin" || sessionUpdate === "tool_call" || type === "tool_call") {
      return {
        type: "tool_progress",
        toolName: (data.name as string) ?? (data.toolName as string) ?? (data.title as string) ?? "",
        toolCallId: (data.id as string) ?? (data.toolCallId as string) ?? "",
      };
    }

    if (sessionUpdate === "tool_call_end" || sessionUpdate === "toolCallEnd" || sessionUpdate === "tool_call_update" || type === "tool_result") {
      const status = data.status as string | undefined;
      if (status === "pending" || status === "in_progress") {
        return {
          type: "tool_progress",
          toolName: (data.name as string) ?? (data.toolName as string) ?? (data.title as string) ?? "",
          toolCallId: (data.id as string) ?? (data.toolCallId as string) ?? "",
        };
      }
      return {
        type: "tool_result",
        toolName: (data.name as string) ?? (data.toolName as string) ?? (data.title as string) ?? "",
        toolCallId: (data.id as string) ?? (data.toolCallId as string) ?? "",
        text: stringifyAcpToolOutput(data.rawOutput ?? data.output ?? data.content ?? data.text),
      };
    }

    if (sessionUpdate === "done" || type === "done") {
      return { type: "done" };
    }

    if (type === "error" || sessionUpdate === "error") {
      return {
        type: "error",
        message: (data.message as string) ?? (data.error as string) ?? "Unknown error",
      };
    }

    return null;
  }

  private rejectAllPending(error: Error): void {
    for (const [_id, pending] of this.pendingRequests) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}

function buildSessionParams(options: HermesAcpSessionOptions): Record<string, unknown> {
  return {
    cwd: options.cwd,
    mcpServers: normalizeAcpMcpServers(options.mcpServers),
    ...(options.mcpConfigPath ? { mcpConfigPath: options.mcpConfigPath } : {}),
    ...(options.env ? { env: options.env } : {}),
  };
}

function normalizeAcpMcpServers(mcpServers: HermesAcpSessionOptions["mcpServers"]): AcpMcpServer[] {
  if (!mcpServers) return [];
  if (Array.isArray(mcpServers)) {
    return mcpServers
      .map((server) => normalizeAcpMcpServer(undefined, server))
      .filter((server): server is AcpMcpServer => Boolean(server));
  }
  return Object.entries(mcpServers)
    .map(([name, server]) => normalizeAcpMcpServer(name, server))
    .filter((server): server is AcpMcpServer => Boolean(server));
}

function normalizeAcpMcpServer(name: string | undefined, value: unknown): AcpMcpServer | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const server = value as Record<string, unknown>;
  const resolvedName = readNonEmptyString(server.name) ?? name;
  if (!resolvedName) return undefined;

  const type = readNonEmptyString(server.type);
  const url = readNonEmptyString(server.url);
  if (url) {
    const headers = normalizeNameValueList(server.headers);
    return {
      type: type === "sse" ? "sse" : "http",
      name: resolvedName,
      url,
      headers,
      ...normalizeAcpMeta(server._meta),
    };
  }

  const command = readNonEmptyString(server.command);
  if (!command) return undefined;
  return {
    type: "stdio",
    name: resolvedName,
    command,
    args: normalizeStringList(server.args),
    env: normalizeNameValueList(server.env),
    ...normalizeAcpMeta(server._meta),
  };
}

function normalizeAcpMeta(value: unknown): { _meta?: Record<string, unknown> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { _meta: value as Record<string, unknown> };
}

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function normalizeNameValueList(value: unknown): AcpEnvVariable[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const record = entry as Record<string, unknown>;
      const name = readNonEmptyString(record.name);
      const rawValue = typeof record.value === "string" ? record.value : undefined;
      return name && rawValue !== undefined ? [{ name, value: rawValue }] : [];
    });
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([envName, envValue]) => {
    return typeof envValue === "string" ? [{ name: envName, value: envValue }] : [];
  });
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function extractAcpText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .map((entry) => extractAcpText(entry))
      .filter((entry): entry is string => Boolean(entry))
      .join("");
    return text || undefined;
  }
  if (content && typeof content === "object") {
    const block = content as Record<string, unknown>;
    if (typeof block.text === "string") return block.text;
    if (typeof block.content === "string") return block.content;
  }
  return undefined;
}

function stringifyAcpToolOutput(value: unknown): string {
  const text = extractAcpText(value);
  if (text !== undefined) return text;
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isTerminalStopReason(value: string): boolean {
  return value === "end_turn" ||
    value === "stop" ||
    value === "cancelled" ||
    value === "max_tokens";
}
