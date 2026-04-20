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
import { injectCredentials, buildDockerEnvFlags } from "./credential-injector.js";
import { processResult, applyWriteback } from "./result-processor.js";
import { inferStrategy, formatStrategy } from "./strategy-engine.js";
import type {
  DispatchRequest,
  DispatchResult,
  HermesPluginConfig,
  StrategyTriple,
  ContextLevel,
  CredentialScope,
  WritebackLevel,
  AcpSessionEvent,
} from "./types.js";

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
  const { config, workspaceDir, logger } = options;
  const startTime = Date.now();

  // 当分层协议关闭时，直接派发原始任务给 Hermes，跳过策略/上下文/凭证/回写
  if (!config.enableLayeredProtocol) {
    return dispatchDirectly(request, config, workspaceDir, logger, startTime);
  }

  // ── Step 1: Determine Strategy ──────────────────────────────────────

  let strategy: StrategyTriple;

  if (
    request.explicitStrategy &&
    request.contextLevel &&
    request.credentialScope &&
    request.writeback
  ) {
    // Use explicitly provided strategy
    strategy = {
      context: request.contextLevel,
      credential: request.credentialScope,
      writeback: request.writeback,
      confidence: 1.0,
      reasoning: "Explicit strategy provided by caller",
    };
  } else if (config.autoStrategy) {
    // Auto-infer strategy
    strategy = inferStrategy(request.task);
    logger?.info(`Auto-strategy: ${formatStrategy(strategy)} (confidence: ${strategy.confidence})`);

    // Apply overrides if any individual dimension is specified
    if (request.contextLevel) strategy.context = request.contextLevel;
    if (request.credentialScope) strategy.credential = request.credentialScope;
    if (request.writeback) strategy.writeback = request.writeback;
  } else {
    // Use defaults from config
    strategy = {
      context: request.contextLevel ?? config.defaultContextLevel,
      credential: request.credentialScope ?? { mode: config.defaultCredentialScope },
      writeback: request.writeback ?? config.defaultWriteback,
      confidence: 0.5,
      reasoning: "Using config defaults (autoStrategy disabled)",
    };
  }

  logger?.info(`Dispatching to Hermes: ${formatStrategy(strategy)}`);

  // ── Step 2: Assemble Context ────────────────────────────────────────

  let contextPayload;
  try {
    contextPayload = await assembleContext(request.task, strategy.context, {
      workspaceDir,
      config,
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

  const credentialResult = injectCredentials(strategy.credential);

  for (const logLine of credentialResult.auditLog) {
    logger?.info(logLine);
  }

  // ── Step 4: Execute via ACP ─────────────────────────────────────────

  const acpClient = new HermesAcpClient(config, logger as any);
  let acpText = "";
  let acpEvents: AcpSessionEvent[] = [];
  let tokensUsed = 0;

  try {
    // Start ACP connection with injected credentials
    await acpClient.start(credentialResult.envVars, workspaceDir);

    // Create session
    const sessionId = await acpClient.newSession(workspaceDir);

    // Send the prompt
    const timeout = (request.timeout ?? config.timeout) * 1000;
    const result = await acpClient.prompt(promptText, sessionId, { timeout });

    acpText = result.text;
    acpEvents = result.events;
    tokensUsed = result.usage?.total_tokens ?? 0;

    logger?.info(
      `Hermes completed: ${acpText.length} chars, ${acpEvents.length} events, ${tokensUsed} tokens`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.error(`Hermes execution failed: ${msg}`);

    // Check if it's a timeout
    if (msg.includes("timed out")) {
      return makeTimeoutResult(msg, strategy, startTime);
    }
    return makeErrorResult("Hermes execution failed: " + msg, strategy, startTime);
  } finally {
    await acpClient.close().catch(() => {});
  }

  // ── Step 5: Process Results ─────────────────────────────────────────

  let processed;
  try {
    processed = await processResult(acpText, acpEvents, strategy.writeback, {
      workspaceDir,
      confirmAction: options.confirmAction,
    });

    // Apply writeback changes
    if (processed.memoryUpdates.length > 0 || processed.skillsCreated.length > 0) {
      const applied = await applyWriteback(processed, { workspaceDir });
      for (const action of applied) {
        logger?.info(`Writeback: ${action}`);
      }
    }
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

  try {
    await acpClient.start({}, workspaceDir);
    const sessionId = await acpClient.newSession(workspaceDir);
    const timeout = (request.timeout ?? config.timeout) * 1000;
    const result = await acpClient.prompt(request.task, sessionId, { timeout });

    acpText = result.text;
    tokensUsed = result.usage?.total_tokens ?? 0;

    logger?.info(`Direct dispatch completed: ${acpText.length} chars, ${tokensUsed} tokens`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.error(`Direct dispatch failed: ${msg}`);

    if (msg.includes("timed out")) {
      return makeTimeoutResult(msg, bypassStrategy, startTime);
    }
    return makeErrorResult("Direct dispatch failed: " + msg, bypassStrategy, startTime);
  } finally {
    await acpClient.close().catch(() => {});
  }

  return {
    status: "success",
    result: acpText,
    tokensUsed,
    duration: Date.now() - startTime,
    strategy: bypassStrategy,
  };
}
