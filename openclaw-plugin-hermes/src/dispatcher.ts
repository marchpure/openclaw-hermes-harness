/**
 * openclaw-plugin-hermes — Task Dispatcher
 *
 * Core orchestrator that ties together all components:
 * 1. Strategy Engine → determine L/C/W
 * 2. Context Assembler → build context payload
 * 3. Credential Injector → prepare env vars
 * 4. ACP Client → spawn Hermes and send task
 * 5. Result Processor → handle output writeback
 */

import { HermesAcpClient } from "./acp-client.js";
import { injectCredentials, buildDockerEnvFlags } from "./credential-injector.js";
import { processResult, applyWriteback, extractTouchedSkillNames } from "./result-processor.js";
import { inferStrategy, formatStrategy } from "./strategy-engine.js";
import {
  mirrorWorkspaceFromContainer,
  mirrorWorkspaceToContainer,
} from "./execenv-builder.js";
import {
  clearSessionBinding,
  prepareProjectedExecutionEnv,
  readSessionBinding,
  writeSessionBinding,
} from "./runtime-client.js";
import type {
  DispatchRequest,
  DispatchResult,
  HermesPluginConfig,
  StrategyTriple,
  ContextLevel,
  CredentialScope,
  WritebackLevel,
  AcpSessionEvent,
  HermesAcpSessionOptions,
} from "./types.js";
import { traceStep, recordEventSpans } from "./observability/index.js";
import {
  GEN_AI_INPUT,
  GEN_AI_OUTPUT,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_TOTAL_TOKENS,
  GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_SPAN_KIND,
  GenAiSpanKind,
} from "./observability/genaiConst.js";

const HERMES_SESSION_ID = "hermes.session.id";

// ─── Logger ─────────────────────────────────────────────────────────────────

interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

async function resumeOrCreateSession(params: {
  acpClient: HermesAcpClient;
  sessionOptions: HermesAcpSessionOptions;
  bindingHash: string;
  logger?: Logger;
}): Promise<string> {
  const existingBinding = readSessionBinding(params.bindingHash);
  if (existingBinding && existingBinding.runtimeExecEnvPath === params.sessionOptions.cwd) {
    try {
      const loaded = await params.acpClient.loadSession(
        existingBinding.sessionId,
        params.sessionOptions,
      );
      writeSessionBinding(params.bindingHash, {
        sessionId: loaded,
        runtimeExecEnvPath: params.sessionOptions.cwd,
        bindingHash: params.bindingHash,
      });
      return loaded;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      params.logger?.warn(`Session resume failed; creating a new session instead: ${msg}`);
      clearSessionBinding(params.bindingHash);
    }
  }

  const created = await params.acpClient.newSession(params.sessionOptions);
  writeSessionBinding(params.bindingHash, {
    sessionId: created,
    runtimeExecEnvPath: params.sessionOptions.cwd,
    bindingHash: params.bindingHash,
  });
  return created;
}

function buildDispatchSessionOptions(params: {
  cwd: string;
  config: HermesPluginConfig;
  env?: Record<string, string>;
}): HermesAcpSessionOptions {
  const mcpServers =
    params.config.mcpBridge.enabled && Object.keys(params.config.mcpBridge.servers).length > 0
      ? params.config.mcpBridge.servers
      : undefined;
  return {
    cwd: params.cwd,
    ...(mcpServers ? { mcpServers } : {}),
    ...(params.env && Object.keys(params.env).length > 0 ? { env: params.env } : {}),
  };
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

export interface DispatcherOptions {
  config: HermesPluginConfig;
  workspaceDir: string;
  logger?: Logger;
  /** Callback for W3 confirmation prompts */
  confirmAction?: (description: string) => Promise<boolean>;
  /** External cancellation signal from OpenClaw tool execution. */
  signal?: AbortSignal;
  /** Controls whether user/task/tool details can be reported to OTEL. */
  allowUserDetailInfoReport?: boolean;
}

/**
 * Dispatch a task to Hermes Agent.
 *
 * This is the main entry point that orchestrates the full pipeline:
 * strategy → context → credentials → ACP → results
 */
export async function dispatchToHermes(
  request: DispatchRequest,
  options: DispatcherOptions,
): Promise<DispatchResult> {
  const { config, workspaceDir, logger, signal } = options;
  const allowDetail = options.allowUserDetailInfoReport === true;
  const startTime = Date.now();

  if (signal?.aborted) {
    return makeCancelledResult("Aborted before dispatch", inferDefaultStrategy(request, config), startTime);
  }

  // 当分层协议关闭时，直接派发原始任务给 Hermes，跳过策略/上下文/凭证/回写
  if (!config.enableLayeredProtocol) {
    return dispatchDirectly(request, config, workspaceDir, logger, startTime, signal, allowDetail);
  }

  // ── Step 1: Determine Strategy ──────────────────────────────────────

  const strategy = await traceStep("hermes_strategy_inference", async (span) => {
    let s: StrategyTriple;
    if (request.explicitStrategy && request.contextLevel && request.credentialScope && request.writeback) {
      s = {
        context: request.contextLevel,
        credential: request.credentialScope,
        writeback: request.writeback,
        confidence: 1.0,
        reasoning: "Explicit strategy provided by caller",
      };
    } else if (config.autoStrategy) {
      s = inferStrategy(request.task);
      logger?.info(`Auto-strategy: ${formatStrategy(s)} (confidence: ${s.confidence})`);
      if (request.contextLevel) s.context = request.contextLevel;
      if (request.credentialScope) s.credential = request.credentialScope;
      if (request.writeback) s.writeback = request.writeback;
    } else {
      s = {
        context: request.contextLevel ?? config.defaultContextLevel,
        credential: request.credentialScope ?? { mode: config.defaultCredentialScope },
        writeback: request.writeback ?? config.defaultWriteback,
        confidence: 0.5,
        reasoning: "Using config defaults (autoStrategy disabled)",
      };
    }
    span.setAttributes({
      "hermes_strategy_context": s.context,
      "hermes_strategy_writeback": s.writeback,
      "hermes_strategy_credential_mode": s.credential.mode,
      "hermes_strategy_confidence": s.confidence,
      "hermes_strategy_auto": config.autoStrategy,
    });
    return s;
  });

  logger?.info(`Dispatching to Hermes: ${formatStrategy(strategy)}`);

  // ── Step 2: Assemble Context ────────────────────────────────────────

  let execution;
  try {
    execution = await traceStep("hermes_context_assembly", async (span) => {
      span.setAttribute("hermes_context_level", strategy.context);
      const exec = await prepareProjectedExecutionEnv({
        task: request.task,
        taskId: `task-${Date.now()}`,
        workspaceDir,
        contextLevel: strategy.context,
        model: request.model,
        config,
      });
      span.setAttribute("hermes_context_model", request.model ?? config.defaultModel ?? "");
      return exec;
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.error(`Context assembly failed: ${msg}`);
    return makeErrorResult("Context assembly failed: " + msg, strategy, startTime);
  }

  const promptText = execution.bootstrapPrompt;

  // ── Step 3: Inject Credentials ──────────────────────────────────────

  const credentialResult = await traceStep("hermes_credential_injection", async (span) => {
    const res = injectCredentials(strategy.credential);
    span.setAttributes({
      "hermes_credential_mode": strategy.credential.mode,
      "hermes_credential_injected_count": res.injected.length,
    });
    return res;
  });

  for (const logLine of credentialResult.auditLog) {
    logger?.info(logLine);
  }

  // ── Step 4: Execute via ACP ─────────────────────────────────────────

  const acpClient = new HermesAcpClient(config, logger as any);
  let acpText = "";
  let acpEvents: AcpSessionEvent[] = [];
  let tokensUsed = 0;
  let usageResult: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  } | undefined;

  try {
    await mirrorWorkspaceToContainer(config, workspaceDir);

    await traceStep("hermes_acp_connect", async (span) => {
      span.setAttribute("hermes_acp_transport", config.transport);
      await acpClient.start();
    });

    const sessionId = await traceStep("hermes_session_create", async (span) => {
      const sid = await resumeOrCreateSession({
        acpClient,
        sessionOptions: buildDispatchSessionOptions({
          cwd: execution.execEnv.runtimeExecEnvPath,
          config,
          env: {
            ...credentialResult.envVars,
            ...(config.mcpBridge.enabled ? config.mcpBridge.env : {}),
          },
        }),
        bindingHash: execution.sessionBindingHash,
        logger,
      });
      span.setAttribute(HERMES_SESSION_ID, sid);
      return sid;
    });

    const abortHandler = () => {
      logger?.info("Abort signal received - cancelling Hermes session");
      void acpClient.cancel(sessionId).catch(() => {});
    };

    if (signal) {
      if (signal.aborted) {
        await acpClient.cancel(sessionId).catch(() => {});
        return makeCancelledResult("Aborted before prompt", strategy, startTime);
      }
      signal.addEventListener("abort", abortHandler, { once: true });
    }

    // Send the prompt
    try {
      const timeout = (request.timeout ?? config.timeout) * 1000;
      const result = await traceStep("hermes_llm_loop", async (span) => {
        span.setAttributes({
          [GEN_AI_SPAN_KIND]: GenAiSpanKind.LLMLoop,
          [HERMES_SESSION_ID]: sessionId,
          ...(allowDetail ? { [GEN_AI_INPUT]: request.task } : {}),
          "hermes_llm_timeout_ms": timeout,
        });
        const r = await acpClient.prompt(promptText, sessionId, { timeout, signal });
        span.setAttributes({
          ...(allowDetail ? { [GEN_AI_OUTPUT]: r.text } : {}),
          [GEN_AI_USAGE_INPUT_TOKENS]: r.usage?.input_tokens ?? 0,
          [GEN_AI_USAGE_OUTPUT_TOKENS]: r.usage?.output_tokens ?? 0,
          [GEN_AI_USAGE_TOTAL_TOKENS]: r.usage?.total_tokens ?? 0,
          [GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]: r.usage?.cache_read_tokens ?? 0,
          [GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS]: r.usage?.cache_write_tokens ?? 0,
          "hermes_llm_event_count": r.events.length,
        });
        recordEventSpans(r.events, { allowDetail, hermesSessionId: sessionId });
        return r;
      });

      acpText = result.text;
      acpEvents = result.events;
      tokensUsed = result.usage?.total_tokens ?? 0;
      usageResult = result.usage;
      const touchedSkillNames = extractTouchedSkillNames(acpEvents);

      logger?.info(`Hermes completed: ${acpText.length} chars, ${acpEvents.length} events, ${tokensUsed} tokens`);
      await mirrorWorkspaceFromContainer(
        config,
        workspaceDir,
        [],
        execution.execEnv.runtimeExecEnvPath,
        touchedSkillNames,
      );
    } finally {
      signal?.removeEventListener("abort", abortHandler);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    if (signal?.aborted || msg.includes("aborted") || msg.includes("Prompt aborted")) {
      logger?.info("Hermes task cancelled via abort signal");
      return makeCancelledResult("Task cancelled", strategy, startTime);
    }

    logger?.error(`Hermes execution failed: ${msg}`);

    // Check if it's a timeout
    if (msg.includes("timed out")) {
      return makeTimeoutResult(msg, strategy, startTime);
    }
    clearSessionBinding(execution.sessionBindingHash);
    return makeErrorResult("Hermes execution failed: " + msg, strategy, startTime);
  } finally {
    await traceStep("hermes_session_close", async (span) => {
      span.setAttribute(HERMES_SESSION_ID, acpClient.currentSessionId ?? "");
      await acpClient.close().catch(() => {});
    });
  }

  // ── Step 5: Process Results ─────────────────────────────────────────

  let processed;
  try {
    const doProcess = async () => {
      const p = await processResult(acpText, acpEvents, strategy.writeback, {
        workspaceDir,
        confirmAction: options.confirmAction,
      });
      if (p.memoryUpdates.length > 0 || p.skillsCreated.length > 0) {
        const applied = await applyWriteback(p, { workspaceDir });
        for (const action of applied) {
          logger?.info(`Writeback: ${action}`);
        }
      }
      return p;
    };

    processed = await traceStep("hermes_result_processing", async (span) => {
      span.setAttribute("hermes_writeback_level", strategy.writeback);
      const p = await doProcess();
      span.setAttributes({
        "hermes_writeback_memory_updates": p.memoryUpdates.length,
        "hermes_writeback_skills_created": p.skillsCreated.length,
      });
      return p;
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.warn(`Result processing failed (non-fatal): ${msg}`);
    processed = { text: acpText, memoryUpdates: [], skillsCreated: [], warnings: [msg] };
  }

  // ── Step 6: Build Final Result ──────────────────────────────────────

  const duration = Date.now() - startTime;

  return {
    status: "success",
    result: processed.text,
    memoryUpdates: processed.memoryUpdates,
    skillsCreated: processed.skillsCreated,
    tokensUsed,
    usage: usageResult,
    duration,
    strategy,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeErrorResult(
  message: string,
  strategy: StrategyTriple,
  startTime: number,
): DispatchResult {
  return {
    status: "error",
    result: message,
    tokensUsed: 0,
    duration: Date.now() - startTime,
    strategy,
  };
}

function makeTimeoutResult(
  message: string,
  strategy: StrategyTriple,
  startTime: number,
): DispatchResult {
  return {
    status: "timeout",
    result: message,
    tokensUsed: 0,
    duration: Date.now() - startTime,
    strategy,
  };
}

function makeCancelledResult(
  message: string,
  strategy: StrategyTriple,
  startTime: number,
): DispatchResult {
  return {
    status: "cancelled",
    result: message,
    tokensUsed: 0,
    duration: Date.now() - startTime,
    strategy,
  };
}

function inferDefaultStrategy(request: DispatchRequest, config: HermesPluginConfig): StrategyTriple {
  if (request.explicitStrategy && request.contextLevel && request.credentialScope && request.writeback) {
    return {
      context: request.contextLevel,
      credential: request.credentialScope,
      writeback: request.writeback,
      confidence: 1,
      reasoning: "Explicit strategy provided by caller",
    };
  }
  if (config.autoStrategy) {
    const strategy = inferStrategy(request.task);
    if (request.contextLevel) strategy.context = request.contextLevel;
    if (request.credentialScope) strategy.credential = request.credentialScope;
    if (request.writeback) strategy.writeback = request.writeback;
    return strategy;
  }
  return {
    context: request.contextLevel ?? config.defaultContextLevel,
    credential: request.credentialScope ?? { mode: config.defaultCredentialScope },
    writeback: request.writeback ?? config.defaultWriteback,
    confidence: 0.5,
    reasoning: "Using config defaults (autoStrategy disabled)",
  };
}

/**
 * 直接派发模式：跳过分层协议，将原始 task 文本直接发送给 Hermes。
 * 不执行策略推断、上下文组装、凭证注入和结果回写。
 */
async function dispatchDirectly(
  request: DispatchRequest,
  config: HermesPluginConfig,
  workspaceDir: string,
  logger: Logger | undefined,
  startTime: number,
  signal?: AbortSignal,
  allowDetail: boolean = false,
): Promise<DispatchResult> {
  const bypassStrategy: StrategyTriple = {
    context: "L0",
    credential: { mode: "none" },
    writeback: "W0",
    confidence: 0,
    reasoning: "Layered protocol disabled — direct dispatch",
  };

  logger?.info("Direct dispatch mode (layered protocol disabled)");

  const acpClient = new HermesAcpClient(config, logger as any);
  let acpText = "";
  let tokensUsed = 0;
  let bindingHash: string | null = null;
  let usageResult: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  } | undefined;

  try {
    if (signal?.aborted) {
      return makeCancelledResult("Aborted before direct dispatch", bypassStrategy, startTime);
    }
    const execution = await prepareProjectedExecutionEnv({
      task: request.task,
      taskId: `task-${Date.now()}`,
      workspaceDir,
      contextLevel: "L0",
      model: request.model,
      config,
    });
    bindingHash = execution.sessionBindingHash;
    await mirrorWorkspaceToContainer(config, workspaceDir);

    await traceStep("hermes_acp_connect", async (span) => {
      span.setAttribute("hermes_acp_transport", config.transport);
      await acpClient.start();
    });

    const sessionId = await traceStep("hermes_session_create", async (span) => {
      const sid = await resumeOrCreateSession({
        acpClient,
        sessionOptions: buildDispatchSessionOptions({
          cwd: execution.execEnv.runtimeExecEnvPath,
          config,
          env: config.mcpBridge.enabled ? config.mcpBridge.env : undefined,
        }),
        bindingHash: execution.sessionBindingHash,
        logger,
      });
      span.setAttribute(HERMES_SESSION_ID, sid);
      return sid;
    });

    const abortHandler = () => {
      logger?.info("Abort signal received - cancelling direct Hermes session");
      void acpClient.cancel(sessionId).catch(() => {});
    };
    if (signal) {
      if (signal.aborted) {
        await acpClient.cancel(sessionId).catch(() => {});
        return makeCancelledResult("Aborted before direct prompt", bypassStrategy, startTime);
      }
      signal.addEventListener("abort", abortHandler, { once: true });
    }
    const timeout = (request.timeout ?? config.timeout) * 1000;

    const result = await traceStep("hermes_llm_loop", async (span) => {
      span.setAttributes({
        [GEN_AI_SPAN_KIND]: GenAiSpanKind.LLMLoop,
        [HERMES_SESSION_ID]: sessionId,
        ...(allowDetail ? { [GEN_AI_INPUT]: request.task } : {}),
        "hermes_llm_timeout_ms": timeout,
      });
      const r = await acpClient.prompt(request.task, sessionId, { timeout, signal });
      span.setAttributes({
        ...(allowDetail ? { [GEN_AI_OUTPUT]: r.text } : {}),
        [GEN_AI_USAGE_INPUT_TOKENS]: r.usage?.input_tokens ?? 0,
        [GEN_AI_USAGE_OUTPUT_TOKENS]: r.usage?.output_tokens ?? 0,
        [GEN_AI_USAGE_TOTAL_TOKENS]: r.usage?.total_tokens ?? 0,
        [GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]: r.usage?.cache_read_tokens ?? 0,
        [GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS]: r.usage?.cache_write_tokens ?? 0,
      });
      recordEventSpans(r.events, { allowDetail, hermesSessionId: sessionId });
      return r;
    });

    acpText = result.text;
    tokensUsed = result.usage?.total_tokens ?? 0;
    usageResult = result.usage;

    logger?.info(`Direct dispatch completed: ${acpText.length} chars, ${tokensUsed} tokens`);
    await mirrorWorkspaceFromContainer(config, workspaceDir, [], execution.execEnv.runtimeExecEnvPath, []);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    if (signal?.aborted || msg.includes("aborted") || msg.includes("Prompt aborted")) {
      logger?.info("Direct Hermes task cancelled via abort signal");
      return makeCancelledResult("Task cancelled", bypassStrategy, startTime);
    }

    logger?.error(`Direct dispatch failed: ${msg}`);

    if (msg.includes("timed out")) {
      return makeTimeoutResult(msg, bypassStrategy, startTime);
    }
    if (bindingHash) clearSessionBinding(bindingHash);
    return makeErrorResult("Direct dispatch failed: " + msg, bypassStrategy, startTime);
  } finally {
    await traceStep("hermes_session_close", async (span) => {
      span.setAttribute(HERMES_SESSION_ID, acpClient.currentSessionId ?? "");
      await acpClient.close().catch(() => {});
    });
  }

  return {
    status: "success",
    result: acpText,
    tokensUsed,
    usage: usageResult,
    duration: Date.now() - startTime,
    strategy: bypassStrategy,
  };
}
