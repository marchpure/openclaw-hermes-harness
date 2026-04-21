/**
 * openclaw-plugin-hermes — ACP Client
 *
 * Lightweight JSON-RPC client that communicates with Hermes Agent via the
 * Agent Client Protocol (ACP). Supports two transports:
 *
 *   - TCP (recommended): connects to a persistent ACP TCP bridge on port 3100
 *   - stdio: spawns `hermes acp` via docker exec and pipes stdin/stdout
 *
 * Both transports use identical NDJSON framing and JSON-RPC protocol.
 *
 * ACP method names use namespace format:
 *   initialize, session/new, session/prompt, session/cancel, session/close
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { EventEmitter } from "node:events";
import type {
  AcpJsonRpcRequest,
  AcpJsonRpcResponse,
  AcpSessionEvent,
  HermesPluginConfig,
  TransportMode,
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

// ─── ACP Client ─────────────────────────────────────────────────────────────

export class HermesAcpClient extends EventEmitter {
  // stdio transport
  private child: ChildProcess | null = null;
  // TCP transport
  private socket: net.Socket | null = null;
  // shared
  private transport: TransportMode;
  private readline: ReadlineInterface | null = null;
  private requestId = 0;
  private pendingRequests = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer?: ReturnType<typeof setTimeout> }
  >();
  private sessionId: string | null = null;
  private stderr = "";
  private connected = false;
  private logger: Logger;

  constructor(
    private config: HermesPluginConfig,
    logger?: Logger,
  ) {
    super();
    this.logger = logger ?? defaultLogger;
    this.transport = config.transport ?? "tcp";
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Connect to Hermes via TCP or spawn a stdio process, then initialize ACP.
   * @param env Extra environment variables to inject (credentials) — stdio only
   * @param cwd Working directory for the Hermes process — stdio only
   */
  async start(env?: Record<string, string>, cwd?: string): Promise<void> {
    if (this.connected) {
      throw new Error("ACP client already connected");
    }

    if (this.transport === "tcp") {
      await this.startTcp();
    } else {
      await this.startStdio(env, cwd);
    }

    // Initialize the ACP connection (same for both transports)
    const initResult = await this.sendRequest("initialize", {
      protocol_version: 1,
      client_info: { name: "openclaw-plugin-hermes", version: "1.0.0" },
      client_capabilities: {},
    });

    this.connected = true;
    this.logger.info(`ACP initialized (${this.transport}): ${JSON.stringify(initResult)}`);
  }

  // ─── TCP Transport ────────────────────────────────────────────────────

  private startTcp(): Promise<void> {
    return new Promise((resolve, reject) => {
      const { tcpHost, tcpPort } = this.config;
      this.logger.info(`TCP connecting: ${tcpHost}:${tcpPort}`);

      this.socket = net.createConnection({ host: tcpHost, port: tcpPort });

      const connectTimeout = setTimeout(() => {
        reject(new Error(`TCP connection to ${tcpHost}:${tcpPort} timed out after 10s`));
        this.socket?.destroy();
      }, 10000);

      this.socket.on("connect", () => {
        clearTimeout(connectTimeout);
        this.logger.info(`TCP connected: ${tcpHost}:${tcpPort}`);

        // Set up line-by-line NDJSON reader on the socket
        this.readline = createInterface({ input: this.socket! });
        this.readline.on("line", (line: string) => this.handleLine(line));

        resolve();
      });

      this.socket.on("error", (err: Error) => {
        clearTimeout(connectTimeout);
        this.logger.error(`TCP error: ${err.message}`);
        if (!this.connected) {
          reject(err);
        } else {
          this.connected = false;
          this.rejectAllPending(err);
          this.emit("error", err);
        }
      });

      this.socket.on("close", () => {
        this.connected = false;
        this.logger.info("TCP connection closed");
        this.rejectAllPending(new Error("TCP connection closed"));
        this.emit("exit", { code: null, signal: null });
      });
    });
  }

  // ─── stdio Transport ──────────────────────────────────────────────────

  private startStdio(env?: Record<string, string>, cwd?: string): Promise<void> {
    return new Promise((resolve) => {
      const { command, args } = this.buildSpawnCommand();
      this.logger.info(`Spawning: ${command} ${args.join(" ")}`);

      const childEnv = {
        ...process.env,
        ...(env ?? {}),
      };

      this.child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnv,
        cwd: cwd ?? undefined,
      });

      // Collect stderr for diagnostics
      this.child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        this.stderr += text;
        if (this.stderr.length > 8192) {
          this.stderr = this.stderr.slice(-4096);
        }
        this.logger.debug?.(`stderr: ${text.trimEnd()}`);
      });

      // Set up line-by-line JSON-RPC reader on stdout
      this.readline = createInterface({ input: this.child.stdout! });
      this.readline.on("line", (line: string) => this.handleLine(line));

      // Handle process exit
      this.child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        this.connected = false;
        this.logger.info(`hermes-acp exited: code=${code} signal=${signal}`);
        this.rejectAllPending(new Error(`hermes-acp exited with code ${code}`));
        this.emit("exit", { code, signal });
      });

      this.child.on("error", (err: Error) => {
        this.connected = false;
        this.logger.error(`hermes-acp spawn error: ${err.message}`);
        this.rejectAllPending(err);
        this.emit("error", err);
      });

      // Suppress EPIPE on stdin
      this.child.stdin?.on("error", () => {});

      resolve();
    });
  }

  // ─── Session Management ─────────────────────────────────────────────────

  /**
   * Create a new ACP session.
   * ACP method: "session/new"
   */
  async newSession(cwd: string): Promise<string> {
    const result = (await this.sendRequest("session/new", { cwd, mcpServers: [] })) as {
      session_id?: string;
      sessionId?: string;
    };
    this.sessionId = result.session_id ?? result.sessionId ?? "";
    this.logger.info(`Session created: ${this.sessionId}`);
    return this.sessionId;
  }

  /**
   * Resume an existing ACP session.
   * ACP method: "session/resume"
   */
  async resumeSession(sessionId: string, cwd: string): Promise<string> {
    const result = (await this.sendRequest("session/resume", {
      session_id: sessionId,
      cwd,
      mcpServers: [],
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
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<{ text: string; events: AcpSessionEvent[]; usage?: { input_tokens: number; output_tokens: number; total_tokens: number } }> {
    const sid = sessionId ?? this.sessionId;
    if (!sid) {
      throw new Error("No active session. Call newSession() first.");
    }

    const timeout = options?.timeout ?? this.config.timeout * 1000;
    const events: AcpSessionEvent[] = [];
    let finalText = "";
    let usage: { input_tokens: number; output_tokens: number; total_tokens: number } | undefined;

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeoutTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`Hermes prompt timed out after ${timeout / 1000}s`));
        }
      }, timeout);

      // Set up a temporary line handler for streaming events
      const eventHandler = (event: AcpSessionEvent) => {
        events.push(event);
        this.emit("session-event", event);

        if (event.type === "text" && event.text) {
          finalText += event.text;
        }
        if (event.type === "done") {
          clearTimeout(timeoutTimer);
          if (!settled) {
            settled = true;
            resolve({ text: finalText, events, usage });
          }
        }
        if (event.type === "error") {
          clearTimeout(timeoutTimer);
          if (!settled) {
            settled = true;
            reject(new Error(event.message ?? "Hermes returned an error"));
          }
        }
      };

      this.on("session-event-raw", eventHandler);

      // Handle abort signal
      if (options?.signal) {
        options.signal.addEventListener("abort", () => {
          clearTimeout(timeoutTimer);
          if (!settled) {
            settled = true;
            this.cancel(sid).catch(() => {});
            reject(new Error("Prompt aborted"));
          }
        }, { once: true });
      }

      // Send the prompt request
      this.sendRequest("session/prompt", {
        session_id: sid,
        prompt: [{ type: "text", text }],
      }).then((result) => {
        const promptResult = result as Record<string, unknown>;
        if (promptResult.usage) {
          const u = promptResult.usage as Record<string, number>;
          usage = {
            input_tokens: u.input_tokens ?? u.inputTokens ?? 0,
            output_tokens: u.output_tokens ?? u.outputTokens ?? 0,
            total_tokens: u.total_tokens ?? u.totalTokens ?? 0,
          };
        }
        if (!settled) {
          clearTimeout(timeoutTimer);
          settled = true;
          resolve({ text: finalText, events, usage });
        }
      }).catch((err) => {
        clearTimeout(timeoutTimer);
        if (!settled) {
          settled = true;
          reject(err);
        }
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
      await this.sendRequest("session/cancel", { session_id: sid });
    } catch {
      // Best-effort cancel
    }
  }

  /**
   * Close the ACP connection.
   */
  async close(): Promise<void> {
    if (this.sessionId) {
      try {
        await this.sendRequest("session/close", { session_id: this.sessionId });
      } catch {
        // Best-effort
      }
    }
    this.connected = false;
    this.readline?.close();
    this.readline = null;

    if (this.transport === "tcp") {
      // TCP cleanup
      if (this.socket) {
        this.socket.destroy();
        this.socket = null;
      }
    } else {
      // stdio cleanup
      if (this.child && !this.child.killed) {
        this.child.stdin?.end();
        this.child.kill("SIGTERM");
        setTimeout(() => {
          if (this.child && !this.child.killed) {
            this.child.kill("SIGKILL");
          }
        }, 5000);
      }
      this.child = null;
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

  /** Get the active transport mode */
  get activeTransport(): TransportMode {
    return this.transport;
  }

  // ─── Internal: I/O ──────────────────────────────────────────────────────

  private buildSpawnCommand(): { command: string; args: string[] } {
    if (this.config.hermesCommand) {
      const parts = this.config.hermesCommand.split(/\s+/);
      return { command: parts[0], args: parts.slice(1) };
    }
    return {
      command: "docker",
      args: [
        "exec", "-i", this.config.hermesContainerName,
        "bash", "-c",
        "source /opt/hermes/.venv/bin/activate && hermes acp",
      ],
    };
  }

  /** Write NDJSON data to the active transport */
  private writeData(data: string): void {
    if (this.transport === "tcp") {
      if (!this.socket || this.socket.destroyed) {
        throw new Error("TCP socket not connected");
      }
      this.socket.write(data);
    } else {
      if (!this.child?.stdin?.writable) {
        throw new Error("ACP client not connected (stdio)");
      }
      this.child.stdin.write(data);
    }
  }

  private async sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = ++this.requestId;
    const request: AcpJsonRpcRequest = {
      jsonrpc: "2.0",
      method,
      params: params ?? {},
      id,
    };

    return new Promise((resolve, reject) => {
      const timeoutMs = method === "session/prompt"
        ? (this.config.timeout * 1000 + 10000)
        : 30000;

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
    }
  }

  private parseSessionEvent(data: Record<string, unknown>): AcpSessionEvent | null {
    const sessionUpdate = data.sessionUpdate as string | undefined;
    const type = data.type as string | undefined;

    if (sessionUpdate === "agent_message_text" || sessionUpdate === "agentMessageText" || sessionUpdate === "agent_message_chunk") {
      const content = data.content as Record<string, unknown> | undefined;
      const text = (content?.text as string) ?? (data.text as string) ?? "";
      return { type: "text", text };
    }

    if (sessionUpdate === "agent_thought" || sessionUpdate === "agentThought" ||
        sessionUpdate === "agent_thinking" || sessionUpdate === "agent_thought_chunk" || type === "thinking") {
      const content = data.content as Record<string, unknown> | undefined;
      const text = (content?.text as string) ?? (data.text as string) ?? "";
      return { type: "thinking", text };
    }

    if (sessionUpdate === "tool_call_begin" || sessionUpdate === "toolCallBegin" || type === "tool_call") {
      return {
        type: "tool_progress",
        toolName: (data.name as string) ?? (data.toolName as string) ?? "",
        toolCallId: (data.id as string) ?? (data.toolCallId as string) ?? "",
      };
    }

    if (sessionUpdate === "tool_call_end" || sessionUpdate === "toolCallEnd" || type === "tool_result") {
      return {
        type: "tool_result",
        toolCallId: (data.id as string) ?? (data.toolCallId as string) ?? "",
        text: (data.output as string) ?? (data.text as string) ?? "",
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
