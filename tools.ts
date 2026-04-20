import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { dispatchToHermes } from "./src/acp/dispatcher.js";
import { checkHealth, formatHealthReport } from "./src/acp/health.js";
import { formatStrategy, inferStrategy } from "./src/acp/strategy-engine.js";
import type { DispatchRequest } from "./src/acp/types.js";
import { resolveHermesAcpConfig } from "./src/config.js";

function textToolResult(text: string, details: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

export function registerHermesTools(api: OpenClawPluginApi): void {
  const config = resolveHermesAcpConfig(api.pluginConfig);
  const workspaceDir = api.config.agents?.defaults?.workspace ?? process.cwd();

  api.registerTool(createHermesDispatchTool({ api, workspaceDir }) as AnyAgentTool);
  api.registerTool(createHermesStatusTool(api) as AnyAgentTool);
  api.registerTool(createHermesStrategyTool() as AnyAgentTool);

  api.logger.info(
    "Hermes Agent tools registered (hermes_dispatch, hermes_status, hermes_strategy)",
  );

  function createHermesDispatchTool(params: {
    api: OpenClawPluginApi;
    workspaceDir: string;
  }): AnyAgentTool {
    return {
      name: "hermes_dispatch",
      label: "Dispatch to Hermes",
      description: [
        "Delegate a task to the containerized Hermes Agent for execution.",
        "Hermes has terminal, browser, code execution, and sub-agent capabilities.",
        "Use for heavy tasks: running commands, browser automation, file operations, code execution.",
        "Context levels: L0 stateless, L1 tools, L2 memory and identity, L3 full sync.",
        "Credential scopes: C0 none, C1 specified keys, C2 all credentials.",
        "Writeback: W0 none, W1 result, W2 memory, W3 skills/cron/config.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "The task to delegate to Hermes.",
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
            description: "Specific credential keys for C1 scope.",
          },
          writeback: {
            type: "string",
            enum: ["W0", "W1", "W2", "W3"],
            description: "Writeback level override. Omit to auto-detect.",
          },
          model: {
            type: "string",
            description: "Override the LLM model Hermes uses for this task.",
          },
          timeout: {
            type: "number",
            description: "Timeout in seconds.",
          },
          enableLayeredProtocol: {
            type: "boolean",
            description: "Override the layered protocol for this dispatch.",
          },
        },
        required: ["task"],
      },
      async execute(_id: string, rawParams: Record<string, unknown>) {
        const task = typeof rawParams.task === "string" ? rawParams.task.trim() : "";
        if (!task) {
          return textToolResult("Error: task is required", {
            ok: false,
            error: "task_required",
          });
        }

        const request = buildDispatchRequest(task, rawParams);
        const effectiveConfig =
          typeof rawParams.enableLayeredProtocol === "boolean"
            ? { ...config, enableLayeredProtocol: rawParams.enableLayeredProtocol }
            : config;

        try {
          const result = await dispatchToHermes(request, {
            config: effectiveConfig,
            workspaceDir: params.workspaceDir,
            logger: params.api.logger,
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
            details: {
              ok: result.status === "success",
              status: result.status,
              strategy: result.strategy,
              duration: result.duration,
              tokensUsed: result.tokensUsed,
            },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          params.api.logger.error(`hermes_dispatch failed: ${message}`);
          return textToolResult(`Hermes dispatch error: ${message}`, {
            ok: false,
            error: message,
          });
        }
      },
    };
  }

  function createHermesStatusTool(api: OpenClawPluginApi): AnyAgentTool {
    return {
      name: "hermes_status",
      label: "Hermes status",
      description: "Check the health status of the Hermes Agent container and ACP bridge.",
      parameters: {
        type: "object",
        properties: {},
      },
      async execute() {
        try {
          const report = await checkHealth(config);
          return textToolResult(formatHealthReport(report), { ok: true, report });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          api.logger.error(`hermes_status failed: ${message}`);
          return textToolResult(`Health check failed: ${message}`, {
            ok: false,
            error: message,
          });
        }
      },
    };
  }

  function createHermesStrategyTool(): AnyAgentTool {
    return {
      name: "hermes_strategy",
      label: "Preview Hermes strategy",
      description:
        "Preview the auto-inferred Hermes L/C/W strategy for a task without executing it.",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "The task to analyze.",
          },
        },
        required: ["task"],
      },
      async execute(_id: string, rawParams: Record<string, unknown>) {
        const task = typeof rawParams.task === "string" ? rawParams.task.trim() : "";
        if (!task) {
          return textToolResult("Error: task is required", {
            ok: false,
            error: "task_required",
          });
        }

        const strategy = inferStrategy(task);
        const credential =
          strategy.credential.mode === "specified"
            ? `C1(${strategy.credential.keys?.join(", ") ?? ""})`
            : strategy.credential.mode === "all"
              ? "C2"
              : "C0";
        const lines = [
          `Strategy: ${formatStrategy(strategy)}`,
          `Confidence: ${(strategy.confidence * 100).toFixed(0)}%`,
          "",
          `Context Level: ${strategy.context}`,
          `Credential Scope: ${credential}`,
          `Writeback: ${strategy.writeback}`,
          "",
          `Reasoning: ${strategy.reasoning}`,
        ];

        return textToolResult(lines.join("\n"), { ok: true, strategy });
      },
    };
  }
}

function buildDispatchRequest(task: string, params: Record<string, unknown>): DispatchRequest {
  const request: DispatchRequest = {
    task,
    ...(typeof params.model === "string" && params.model.trim()
      ? { model: params.model.trim() }
      : {}),
    ...(typeof params.timeout === "number" && Number.isFinite(params.timeout) && params.timeout > 0
      ? { timeout: params.timeout }
      : {}),
  };

  if (
    params.contextLevel === "L0" ||
    params.contextLevel === "L1" ||
    params.contextLevel === "L2" ||
    params.contextLevel === "L3"
  ) {
    request.contextLevel = params.contextLevel;
  }
  if (
    params.writeback === "W0" ||
    params.writeback === "W1" ||
    params.writeback === "W2" ||
    params.writeback === "W3"
  ) {
    request.writeback = params.writeback;
  }
  if (params.credentialScope === "C0") {
    request.credentialScope = { mode: "none" };
  } else if (params.credentialScope === "C2") {
    request.credentialScope = { mode: "all" };
  } else if (params.credentialScope === "C1" || Array.isArray(params.credentialKeys)) {
    request.credentialScope = {
      mode: "specified",
      keys: Array.isArray(params.credentialKeys)
        ? params.credentialKeys.filter((entry): entry is string => typeof entry === "string")
        : [],
    };
  }

  return request;
}
