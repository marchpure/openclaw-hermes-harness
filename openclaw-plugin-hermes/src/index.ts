/**
 * openclaw-plugin-hermes — Plugin Entry Point
 *
 * Registers the Hermes Agent integration with OpenClaw:
 * - hermes_dispatch: Delegate a task to Hermes
 * - hermes_status: Check Hermes container health
 * - hermes_cancel: Cancel a running Hermes task
 *
 * OpenClaw is the brain, Hermes is the hands.
 */

import { dispatchToHermes } from "./dispatcher.js";
import { checkHealth, formatHealthReport } from "./health.js";
import { inferStrategy, formatStrategy } from "./strategy-engine.js";
import {
  generateDispatchId,
  registerSession,
  unregisterSession,
  cancelSession,
  cancelAllSessions,
  getActiveSessions,
} from "./session-registry.js";
import type { HermesPluginConfig, DispatchRequest, HealthReport } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

// ─── Config Resolution ──────────────────────────────────────────────────────

function resolveConfig(raw: unknown): HermesPluginConfig {
  const input = (raw ?? {}) as Record<string, unknown>;
  return {
    hermesCommand: (input.hermesCommand as string) ?? undefined,
    hermesContainerName: (input.hermesContainerName as string) ?? DEFAULT_CONFIG.hermesContainerName,
    hermesDataDir: (input.hermesDataDir as string) ?? undefined,
    defaultModel: (input.defaultModel as string) ?? undefined,
    defaultContextLevel:
      (input.defaultContextLevel as HermesPluginConfig["defaultContextLevel"]) ??
      DEFAULT_CONFIG.defaultContextLevel,
    defaultCredentialScope:
      (input.defaultCredentialScope as HermesPluginConfig["defaultCredentialScope"]) ??
      DEFAULT_CONFIG.defaultCredentialScope,
    defaultWriteback:
      (input.defaultWriteback as HermesPluginConfig["defaultWriteback"]) ??
      DEFAULT_CONFIG.defaultWriteback,
    transport:
      (input.transport as HermesPluginConfig["transport"]) ??
      DEFAULT_CONFIG.transport,
    tcpHost: (input.tcpHost as string) ?? DEFAULT_CONFIG.tcpHost,
    tcpPort: (input.tcpPort as number) ?? DEFAULT_CONFIG.tcpPort,
    timeout: (input.timeout as number) ?? DEFAULT_CONFIG.timeout,
    autoStrategy: (input.autoStrategy as boolean) ?? DEFAULT_CONFIG.autoStrategy,
    enableLayeredProtocol: (input.enableLayeredProtocol as boolean) ?? DEFAULT_CONFIG.enableLayeredProtocol,
  };
}

// ─── Plugin Definition ──────────────────────────────────────────────────────

const plugin = {
  id: "openclaw-plugin-hermes",
  name: "Hermes Agent",
  description: "Delegate heavy tasks to a containerized Hermes Agent via ACP.",

  register(api: any) {
    const config = resolveConfig(api.pluginConfig);
    const workspaceDir = api.workspaceDir ?? process.cwd();

    const logger = {
      info: (msg: string, ...args: unknown[]) => api.logger?.info?.(msg, ...args) ?? console.log(`[hermes] ${msg}`),
      warn: (msg: string, ...args: unknown[]) => api.logger?.warn?.(msg, ...args) ?? console.warn(`[hermes] ${msg}`),
      error: (msg: string, ...args: unknown[]) => api.logger?.error?.(msg, ...args) ?? console.error(`[hermes] ${msg}`),
    };

    // ── Tool: hermes_dispatch ───────────────────────────────────────────

    api.registerTool({
      name: "hermes_dispatch",
      description: [
        "Delegate a task to the containerized Hermes Agent for execution.",
        "Hermes has terminal, browser (Playwright), code execution, and sub-agent capabilities.",
        "Use for heavy tasks: running commands, browser automation, file operations, code execution.",
        "",
        "The plugin automatically determines the optimal strategy (context/credentials/writeback)",
        "based on the task description, or you can specify them explicitly.",
        "",
        "Context Levels: L0 (stateless), L1 (tools), L2 (memory+identity), L3 (full sync)",
        "Credential Scopes: C0 (none), C1 (specified keys), C2 (all — requires confirmation)",
        "Writeback: W0 (none), W1 (result), W2 (memory), W3 (skills/cron — requires confirmation)",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "The task to delegate to Hermes (natural language description)",
          },
          contextLevel: {
            type: "string",
            enum: ["L0", "L1", "L2", "L3"],
            description: "Context level override. Omit to auto-detect.",
          },
          credentialScope: {
            type: "string",
            enum: ["C0", "C1", "C2"],
            description: "Credential scope override. Omit to auto-detect.",
          },
          credentialKeys: {
            type: "array",
            items: { type: "string" },
            description: "Specific credential keys for C1 scope (e.g. ['GITHUB_TOKEN'])",
          },
          writeback: {
            type: "string",
            enum: ["W0", "W1", "W2", "W3"],
            description: "Writeback level override. Omit to auto-detect.",
          },
          model: {
            type: "string",
            description: "Override the LLM model Hermes uses for this task",
          },
          timeout: {
            type: "number",
            description: "Timeout in seconds (default: 1800)",
          },
          enableLayeredProtocol: {
            type: "boolean",
            description: "Override: enable/disable layered protocol for this dispatch. When false, task is sent directly without L/C/W strategy, context assembly, or credential injection.",
          },
        },
        required: ["task"],
      },

      /**
       * Execute the dispatch tool.
       *
       * OpenClaw's AgentTool interface passes (toolCallId, params, signal?, onUpdate?).
       * We forward the AbortSignal to the dispatcher so that when the user aborts
       * on the OpenClaw side, we first send session/cancel to Hermes before closing.
       */
      async execute(_id: string, params: Record<string, unknown>, signal?: AbortSignal) {
        const task = params.task as string;
        if (!task?.trim()) {
          return { content: [{ type: "text", text: "Error: task is required" }] };
        }

        const request: DispatchRequest = {
          task,
          model: params.model as string | undefined,
          timeout: params.timeout as number | undefined,
        };

        // Apply overrides
        if (params.contextLevel) {
          request.contextLevel = params.contextLevel as DispatchRequest["contextLevel"];
        }
        if (params.writeback) {
          request.writeback = params.writeback as DispatchRequest["writeback"];
        }
        if (params.credentialScope || params.credentialKeys) {
          const scopeStr = (params.credentialScope as string) ?? "C1";
          if (scopeStr === "C0") {
            request.credentialScope = { mode: "none" };
          } else if (scopeStr === "C2") {
            request.credentialScope = { mode: "all" };
          } else {
            request.credentialScope = {
              mode: "specified",
              keys: (params.credentialKeys as string[]) ?? [],
            };
          }
        }

        try {
          // 单次调用可覆盖 enableLayeredProtocol 配置
          const effectiveConfig = params.enableLayeredProtocol !== undefined
            ? { ...config, enableLayeredProtocol: params.enableLayeredProtocol as boolean }
            : config;

          // 创建 AbortController 并注册到活跃会话表，以便支持外部取消
          const dispatchId = generateDispatchId();
          const abortController = new AbortController();
          registerSession(dispatchId, {
            abortController,
            task,
            startTime: Date.now(),
          });

          // 关联框架 AbortSignal：当 OpenClaw 侧 abort 时，自动触发插件的 AbortController
          if (signal) {
            if (signal.aborted) {
              abortController.abort();
            } else {
              signal.addEventListener("abort", () => abortController.abort(), { once: true });
            }
          }

          try {
            const result = await dispatchToHermes(request, {
              config: effectiveConfig,
              workspaceDir,
              logger,
              signal: abortController.signal,
            });

            const meta = [
              `Strategy: ${formatStrategy(result.strategy)}`,
              `Duration: ${(result.duration / 1000).toFixed(1)}s`,
              `Tokens: ${result.tokensUsed}`,
              `Status: ${result.status}`,
            ].join(" | ");

            return {
              content: [
                { type: "text", text: result.result },
                { type: "text", text: `\n---\n_${meta}_` },
              ],
            };
          } finally {
            unregisterSession(dispatchId);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(`hermes_dispatch failed: ${msg}`);
          return {
            content: [{ type: "text", text: `Hermes dispatch error: ${msg}` }],
          };
        }
      },
    });

    // ── Tool: hermes_status ─────────────────────────────────────────────

    api.registerTool({
      name: "hermes_status",
      description: "Check the health status of the Hermes Agent container (running, responsive, version, resource usage).",
      parameters: {
        type: "object",
        properties: {},
      },

      async execute() {
        try {
          const report = await checkHealth(config);
          return {
            content: [{ type: "text", text: formatHealthReport(report) }],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `Health check failed: ${msg}` }],
          };
        }
      },
    });

    // ── Tool: hermes_strategy ───────────────────────────────────────────

    api.registerTool({
      name: "hermes_strategy",
      description: "Preview the auto-inferred L/C/W strategy for a task without executing it. Useful for understanding what context, credentials, and writeback would be used.",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "The task to analyze",
          },
        },
        required: ["task"],
      },

      async execute(_id: string, params: Record<string, unknown>) {
        const task = params.task as string;
        if (!task?.trim()) {
          return { content: [{ type: "text", text: "Error: task is required" }] };
        }

        const strategy = inferStrategy(task);
        const lines = [
          `**Strategy: ${formatStrategy(strategy)}**`,
          `Confidence: ${(strategy.confidence * 100).toFixed(0)}%`,
          "",
          `**Context Level: ${strategy.context}**`,
          `**Credential Scope: ${strategy.credential.mode === "specified" ? `C1(${strategy.credential.keys?.join(", ")})` : strategy.credential.mode === "all" ? "C2" : "C0"}**`,
          `**Writeback: ${strategy.writeback}**`,
          "",
          `Reasoning: ${strategy.reasoning}`,
        ];

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      },
    });

    // ── Tool: hermes_cancel ────────────────────────────────────────────

    api.registerTool({
      name: "hermes_cancel",
      description: [
        "Cancel a running Hermes task. Sends session/cancel to the Hermes container",
        "to stop the currently executing task.",
        "",
        "With no parameters: cancels ALL active tasks.",
        "With dispatchId: cancels only the specified task.",
        "",
        "Use hermes_cancel (no params) when the user wants to abort all running Hermes work.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          dispatchId: {
            type: "string",
            description: "The specific dispatch ID to cancel. Omit to cancel all active tasks.",
          },
        },
      },

      async execute(_id: string, params: Record<string, unknown>) {
        const dispatchId = params.dispatchId as string | undefined;
        const sessions = getActiveSessions();

        if (sessions.length === 0) {
          return {
            content: [{ type: "text", text: "No active Hermes tasks to cancel." }],
          };
        }

        if (dispatchId) {
          // 取消指定任务
          const found = cancelSession(dispatchId);
          if (found) {
            logger.info(`Cancelled Hermes task: ${dispatchId}`);
            return {
              content: [{ type: "text", text: `Cancelled task ${dispatchId}.` }],
            };
          }
          return {
            content: [{ type: "text", text: `Task ${dispatchId} not found. Active tasks: ${sessions.map(s => s.id).join(", ")}` }],
          };
        }

        // 取消所有活跃任务
        const count = cancelAllSessions();
        logger.info(`Cancelled all ${count} active Hermes task(s)`);
        return {
          content: [{ type: "text", text: `Cancelled ${count} active Hermes task(s).` }],
        };
      },
    });

    // ── Process signal handling ──────────────────────────────────────────
    // 当宿主进程收到 SIGINT/SIGTERM（如用户 Ctrl+C）时，尽力取消所有活跃任务
    const cleanupHandler = () => {
      const count = cancelAllSessions();
      if (count > 0) {
        logger.info(`Process signal received — cancelled ${count} active Hermes task(s)`);
      }
    };
    process.on("SIGINT", cleanupHandler);
    process.on("SIGTERM", cleanupHandler);

    logger.info("Hermes Agent plugin registered (4 tools: hermes_dispatch, hermes_status, hermes_strategy, hermes_cancel)");
  },
};

export default plugin;
