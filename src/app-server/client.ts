import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type {
  HermesServerNotification,
  JsonValue,
  RpcMessage,
  RpcRequest,
  RpcResponse,
} from "./protocol.js";
import { isRpcResponse } from "./protocol.js";

type PendingRequest = {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
};

export type HermesServerRequestHandler = (
  request: Required<Pick<RpcRequest, "id" | "method">> & { params?: JsonValue },
) => Promise<JsonValue | undefined> | JsonValue | undefined;

export type HermesServerNotificationHandler = (
  notification: HermesServerNotification,
) => Promise<void> | void;

export class HermesAppServerClient {
  private readonly child: ChildProcess;
  private readonly lines: ReadlineInterface;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly requestHandlers = new Set<HermesServerRequestHandler>();
  private readonly notificationHandlers = new Set<HermesServerNotificationHandler>();
  private nextId = 1;
  private closed = false;

  constructor(command: string, args: string[]) {
    this.child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.lines = createInterface({ input: this.child.stdout! });
    this.lines.on("line", (line) => this.handleLine(line));
    this.child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString().trim();
      if (text) {
        console.debug(`[hermes-app-server] ${text}`);
      }
    });
    this.child.once("error", (error) => this.closeWithError(error));
    this.child.once("exit", (code, signal) => {
      this.closeWithError(new Error(`hermes app-server exited: code=${code} signal=${signal}`));
    });
  }

  async initialize(timeoutMs: number): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "openclaw-plugin-hermes" } }, { timeoutMs });
  }

  request<T = JsonValue | undefined>(
    method: string,
    params?: JsonValue,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("hermes app-server client is closed"));
    }
    const id = this.nextId++;
    const message: RpcRequest = { id, method, params };
    return new Promise<T>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let cleanupAbort: (() => void) | undefined;
      const cleanup = () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        cleanupAbort?.();
        cleanupAbort = undefined;
      };
      const rejectPending = (error: Error) => {
        if (!this.pending.has(id)) {
          return;
        }
        this.pending.delete(id);
        cleanup();
        reject(error);
      };
      if (options.timeoutMs && options.timeoutMs > 0) {
        timeout = setTimeout(
          () => rejectPending(new Error(`${method} timed out`)),
          Math.max(100, options.timeoutMs),
        );
        timeout.unref?.();
      }
      if (options.signal) {
        const abortListener = () => rejectPending(new Error(`${method} aborted`));
        options.signal.addEventListener("abort", abortListener, { once: true });
        cleanupAbort = () => options.signal?.removeEventListener("abort", abortListener);
      }
      this.pending.set(id, {
        method,
        resolve: (value) => {
          cleanup();
          resolve(value as T);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        cleanup,
      });
      if (options.signal?.aborted) {
        rejectPending(new Error(`${method} aborted`));
        return;
      }
      this.writeMessage(message);
    });
  }

  addRequestHandler(handler: HermesServerRequestHandler): () => void {
    this.requestHandlers.add(handler);
    return () => this.requestHandlers.delete(handler);
  }

  addNotificationHandler(handler: HermesServerNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.lines.close();
    this.rejectPendingRequests(new Error("hermes app-server client is closed"));
    this.child.kill("SIGTERM");
  }

  private writeMessage(message: RpcRequest | RpcResponse): void {
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let message: RpcMessage;
    try {
      message = JSON.parse(trimmed) as RpcMessage;
    } catch {
      console.debug(`[hermes-app-server] non-json stdout: ${trimmed}`);
      return;
    }
    if (isRpcResponse(message)) {
      this.handleResponse(message);
      return;
    }
    void this.handleRequestOrNotification(message);
  }

  private handleResponse(response: RpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    this.pending.delete(response.id);
    if (response.error) {
      pending.reject(new Error(response.error.message || `${pending.method} failed`));
      return;
    }
    pending.resolve(response.result);
  }

  private async handleRequestOrNotification(message: RpcRequest): Promise<void> {
    if (message.id === undefined) {
      const notification = { method: message.method, params: message.params };
      for (const handler of this.notificationHandlers) {
        await handler(notification);
      }
      return;
    }
    for (const handler of this.requestHandlers) {
      const result = await handler({
        id: message.id,
        method: message.method,
        params: message.params,
      });
      if (result !== undefined) {
        this.writeMessage({ id: message.id, result });
        return;
      }
    }
    this.writeMessage({
      id: message.id,
      error: { code: -32601, message: `No handler for ${message.method}` },
    });
  }

  private closeWithError(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.lines.close();
    this.rejectPendingRequests(error);
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }
}
