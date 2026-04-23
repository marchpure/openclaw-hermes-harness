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
import { assembleContext, serializeContextForPrompt } from "./context-assembler.js";
import { injectCredentials } from "./credential-injector.js";
import { processResult, applyWriteback } from "./result-processor.js";
import { inferStrategy, formatStrategy } from "./strategy-engine.js";
import type {
  DispatchRequest,
  DispatchResult,
  HermesPluginConfig,
  StrategyTriple,
  AcpSessionEvent,
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

// ─── Dispatcher ─────────────────────────────────────────────────────────────

export interface DispatcherOptions {
  config: HermesPluginConfig;
  workspaceDir: string;
  logger?: Logger;
  /** Callback for W3 confirmation prompts */
  confirmAction?: (description: string) => Promise<boolean>;
  /** 外部传入的取消信号，用于在用户终止对话时取消 Hermes 任务 */
  signal?: AbortSignal;
  /** Controls whether user/task/tool details can be reported to OTEL */
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

  // Early abort check
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
      // Use explicitly provided strategy
      s = {
        context: request.contextLevel,
        credential: request.credentialScope,
        writeback: request.writeback,
        confidence: 1.0,
        reasoning: "Explicit strategy provided by caller",
      };
    } else if (config.autoStrategy) {
      // Auto-infer strategy
      s = inferStrategy(request.task);
      logger?.info(`Auto-strategy: ${formatStrategy(s)} (confidence: ${s.confidence})`);

      // Apply overrides if any individual dimension is specified
      if (request.contextLevel) s.context = request.contextLevel;
      if (request.credentialScope) s.credential = request.credentialScope;
      if (request.writeback) s.writeback = request.writeback;
    } else {
      // Use defaults from config
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

  let contextPayload;
  try {
    contextPayload = await traceStep("hermes_context_assembly", async (span) => {
      span.setAttribute("hermes_context_level", strategy.context);
      const payload = await assembleContext(request.task, strategy.context, { workspaceDir, config });
      span.setAttribute("hermes_context_model", payload.modelConfig?.model ?? "");
      return payload;
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.error(`Context assembly failed: ${msg}`);
    return makeErrorResult("Context assembly failed: " + msg, strategy, startTime);
  }

  // Override model if specified in request
  if (request.model && contextPayload.modelConfig) {
    contextPayload.modelConfig.model = request.model;
  }

  // Serialize context into a prompt string
  const promptText = serializeContextForPrompt(contextPayload);

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
    // Start ACP connection with injected credentials
    await traceStep("hermes_acp_connect", async (span) => {
      span.setAttribute("hermes_acp_transport", config.transport);
      await acpClient.start(credentialResult.envVars, workspaceDir);
    });

    // Create session
    const sessionId = await traceStep("hermes_session_create", async (span) => {
      const sid = await acpClient.newSession(workspaceDir);
      span.setAttribute(HERMES_SESSION_ID, sid);
      return sid;
    });

    // Wire up abort signal → send cancel notification to Hermes before closing
    const abortHandler = () => {
      logger?.info("Abort signal received — cancelling Hermes session");
      acpClient.cancel(sessionId);  // synchronous notification, fire-and-forget
    };

    if (signal) {
      if (signal.aborted) {
        acpClient.cancel(sessionId);
        await acpClient.close().catch(() => {});
        return makeCancelledResult("Aborted before prompt", strategy, startTime);
      }
      signal.addEventListener("abort", abortHandler, { once: true });
    }

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

      logger?.info(`Hermes completed: ${acpText.length} chars, ${acpEvents.length} events, ${tokensUsed} tokens`);
    } finally {
      if (signal) {
        signal.removeEventListener("abort", abortHandler);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Check if it was an abort
    if (signal?.aborted || msg.includes("aborted") || msg.includes("Prompt aborted")) {
      logger?.info("Hermes task cancelled via abort signal");
      return makeCancelledResult("Task cancelled", strategy, startTime);
    }

    logger?.error(`Hermes execution failed: ${msg}`);
    if (msg.includes("timed out")) {
      return makeTimeoutResult(msg, strategy, startTime);
    }
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
      // Apply writeback changes
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
  return {
    context: request.contextLevel ?? config.defaultContextLevel,
    credential: request.credentialScope ?? { mode: config.defaultCredentialScope },
    writeback: request.writeback ?? config.defaultWriteback,
    confidence: 0,
    reasoning: "Default (cancelled before strategy inference)",
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
  let usageResult: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  } | undefined;

  try {
    await traceStep("hermes_acp_connect", async (span) => {
      span.setAttribute("hermes_acp_transport", config.transport);
      await acpClient.start({}, workspaceDir);
    });

    const sessionId = await traceStep("hermes_session_create", async (span) => {
      const sid = await acpClient.newSession(workspaceDir);
      span.setAttribute(HERMES_SESSION_ID, sid);
      return sid;
    });

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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.error(`Direct dispatch failed: ${msg}`);

    if (msg.includes("timed out")) {
      return makeTimeoutResult(msg, bypassStrategy, startTime);
    }
    if (msg.includes("aborted") || signal?.aborted) {
      return makeCancelledResult("Task cancelled by user", bypassStrategy, startTime);
    }
    return makeErrorResult("Direct dispatch failed: " + msg, bypassStrategy, startTime);
  } finally {
    acpClient.cancel();
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
