import {
  trace,
  context,
  propagation,
  SpanStatusCode,
  SpanKind,
  TraceFlags,
  ROOT_CONTEXT,
  type Span,
} from "@opentelemetry/api";
import { getOrCreateProvider, isProviderInitialized, getProviderTracer, getToolDurationHistogram } from "./provider.js";
import { safeJSONStringify } from "./utils.js";
import type { DispatchResult, AcpSessionEvent } from "../types.js";
import { GEN_AI_SPAN_KIND, GenAiSpanKind, GEN_AI_INPUT, GEN_AI_OUTPUT, GEN_AI_SESSION_ID } from "./genaiConst.js";

export { getOrCreateProvider, shutdownProvider, isProviderInitialized } from "./provider.js";
export const APMPLUS_INNER_CONTEXT_KEY = "apmplus_inner_context";

export interface ApmplusInnerContext {
  traceId: string;
  spanId: string;
  allowUserDetailInfoReport?: boolean;
  channelId?: string;
  sessionId?: string;
}

function getSessionIdFromContext(): string | undefined {
  const bag = propagation.getBaggage(context.active());
  const value = bag?.getEntry(GEN_AI_SESSION_ID)?.value;
  return typeof value === "string" && value ? value : undefined;
}

export function extractApmplusContext(params: Record<string, unknown>): ApmplusInnerContext | undefined {
  const raw = params[APMPLUS_INNER_CONTEXT_KEY];
  if (!raw || typeof raw !== "object") return undefined;
  const ctx = raw as Record<string, unknown>;
  if (typeof ctx.traceId !== "string" || typeof ctx.spanId !== "string") return undefined;
  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    allowUserDetailInfoReport: typeof ctx.allowUserDetailInfoReport === "boolean" ? ctx.allowUserDetailInfoReport : undefined,
    channelId: typeof ctx.channelId === "string" ? ctx.channelId : undefined,
    sessionId: typeof ctx.sessionId === "string" ? ctx.sessionId : undefined,
  };
}

export function removeApmplusContext(params: Record<string, unknown>): Record<string, unknown> {
  const cleaned = { ...params };
  delete cleaned[APMPLUS_INNER_CONTEXT_KEY];
  return cleaned;
}

export interface TraceDispatchOptions {
  endpoint?: string;
  apmplusCtx?: ApmplusInnerContext;
  task: string;
  params: Record<string, unknown>;
  defaultModel?: string;
  serviceName?: string;
}

export interface TraceSpanOptions {
  endpoint?: string;
  apmplusCtx?: ApmplusInnerContext;
  spanName: string;
  attributes?: Record<string, string | number | boolean>;
  serviceName?: string;
}

const NOOP_SPAN = {
  setAttribute: () => NOOP_SPAN,
  setAttributes: () => NOOP_SPAN,
  setStatus: () => NOOP_SPAN,
  recordException: () => {},
  end: () => {},
} as unknown as Span;

export async function traceWithSpan<T>(
  options: TraceSpanOptions,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const { endpoint, apmplusCtx, spanName, serviceName } = options;
  if (!endpoint) {
    // No OTEL endpoint configured -> run without any tracing.
    return fn(NOOP_SPAN);
  }

  const { tracer } = getOrCreateProvider({ endpoint, serviceName });

  let parentContext = apmplusCtx
    ? trace.setSpanContext(ROOT_CONTEXT, {
        traceId: apmplusCtx.traceId,
        spanId: apmplusCtx.spanId,
        traceFlags: TraceFlags.SAMPLED,
        isRemote: true,
      })
    : ROOT_CONTEXT; // create a local root span (new traceId)

  const sessionId = apmplusCtx?.sessionId;
  if (typeof sessionId === "string" && sessionId) {
    const currentBag = propagation.getBaggage(parentContext) ?? propagation.createBaggage();
    const nextBag = currentBag.setEntry(GEN_AI_SESSION_ID, { value: sessionId });
    parentContext = propagation.setBaggage(parentContext, nextBag);
  }

  return tracer.startActiveSpan(
    spanName,
    {
      kind: SpanKind.INTERNAL,
      attributes: options.attributes ?? {},
    },
    parentContext,
    async (span: Span) => {
      try {
        const sid = apmplusCtx?.sessionId ?? getSessionIdFromContext();
        if (sid) {
          span.setAttribute(GEN_AI_SESSION_ID, sid);
        }
        const result = await fn(span);
        span.end();
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
        span.recordException(err instanceof Error ? err : new Error(msg));
        span.end();
        throw err;
      }
    },
  );
}

export async function traceDispatch(
  options: TraceDispatchOptions,
  fn: () => Promise<DispatchResult>,
): Promise<DispatchResult> {
  const { endpoint, apmplusCtx, task, serviceName } = options;

  // No OTEL endpoint configured -> no tracing, no metrics.
  if (!endpoint) {
    return fn();
  }

  // Ensure provider is initialized and get metrics instruments.
  const { tokenUsageCounter } = getOrCreateProvider({ endpoint, serviceName });

  const allowDetail = apmplusCtx?.allowUserDetailInfoReport === true;

  const baseAttrs: Record<string, string | number | boolean> = {
    [GEN_AI_SPAN_KIND]: GenAiSpanKind.Agent,
    "hermes_has_upstream_context": Boolean(apmplusCtx),
  };
  if (apmplusCtx?.sessionId) {
    baseAttrs[GEN_AI_SESSION_ID] = apmplusCtx.sessionId;
  }
  if (allowDetail) {
    baseAttrs[GEN_AI_INPUT] = task;
    baseAttrs["hermes_task"] = task;
  }

  return traceWithSpan(
    {
      endpoint,
      apmplusCtx,
      spanName: "hermes_agent_call",
      attributes: baseAttrs,
      serviceName,
    },
    async (span) => {
      const result = await fn();

      const attrs: Record<string, string | number | boolean> = {
        "hermes_status": result.status,
        "hermes_duration_ms": result.duration,
        "hermes_tokens_used": result.tokensUsed,
        "hermes_strategy_context": result.strategy.context,
        "hermes_strategy_writeback": result.strategy.writeback,
        "hermes_strategy_credential_mode": result.strategy.credential.mode,
      };
      if (allowDetail) {
        attrs[GEN_AI_OUTPUT] = result.result;
      }

      span.setAttributes(attrs);

      if (result.status === "error" || result.status === "timeout") {
        span.setStatus({ code: SpanStatusCode.ERROR, message: "Hermes " + result.status });
      }

      // Metrics: token usage (only when we have a channelId to attribute).
      if (apmplusCtx?.channelId && (result.tokensUsed || result.usage)) {
      //  const model = defaultModel || "hermes";
        const baseAttributes = {
          from: "hermes",
          "openclaw.channel": apmplusCtx.channelId,
          "openclaw.model": "hermes",
        };

        if (result.usage) {
          if (typeof result.usage.input_tokens === "number") {
            tokenUsageCounter.add(result.usage.input_tokens, { ...baseAttributes, "openclaw.token": "input" });
          }
          if (typeof result.usage.output_tokens === "number") {
            tokenUsageCounter.add(result.usage.output_tokens, { ...baseAttributes, "openclaw.token": "output" });
          }
          if (typeof result.usage.cache_read_tokens === "number") {
            tokenUsageCounter.add(result.usage.cache_read_tokens, { ...baseAttributes, "openclaw.token": "cache_read" });
          }
          if (typeof result.usage.cache_write_tokens === "number") {
            tokenUsageCounter.add(result.usage.cache_write_tokens, { ...baseAttributes, "openclaw.token": "cache_write" });
          }
          if (typeof result.usage.total_tokens === "number") {
            tokenUsageCounter.add(result.usage.total_tokens, { ...baseAttributes, "openclaw.token": "total" });
          }
        } else if (result.tokensUsed) {
          tokenUsageCounter.add(result.tokensUsed, { ...baseAttributes, "openclaw.token": "total" });
        }
      }

      return result;
    },
  );
}

export async function traceStep<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getProviderTracer();
  if (!isProviderInitialized() || !tracer) {
    return fn(NOOP_SPAN);
  }
  return tracer.startActiveSpan(name, { kind: SpanKind.INTERNAL }, async (span: Span) => {
    try {
      const sid = getSessionIdFromContext();
      if (sid) {
        span.setAttribute(GEN_AI_SESSION_ID, sid);
      }
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
      span.recordException(err instanceof Error ? err : new Error(msg));
      span.end();
      throw err;
    }
  });
}

export function recordEventSpans(
  events: AcpSessionEvent[],
  opts?: { allowDetail?: boolean; hermesSessionId?: string },
): void {
  const tracer = getProviderTracer();
  const toolDurationHistogram = getToolDurationHistogram();
  if (!isProviderInitialized() || !tracer) return;
  const allowDetail = opts?.allowDetail === true;
  const sid = getSessionIdFromContext();
  const hermesSessionId = opts?.hermesSessionId;

  const typeCounts = new Map<string, number>();
  for (const e of events) {
    typeCounts.set(e.type, (typeCounts.get(e.type) ?? 0) + 1);
  }
  console.log(`[recordEventSpans] events=${events.length}, types=${safeJSONStringify(Object.fromEntries(typeCounts))}`);

  const pendingTools = new Map<string, { span: Span; name: string; input: string; startTime: number }>();

  let currentThinkingText = "";
  let thinkingStartTime = 0;

  const flushThinking = (endTime: number) => {
    if (currentThinkingText.length > 0) {
      const span = tracer.startSpan("hermes_thinking", {
        kind: SpanKind.INTERNAL,
        startTime: thinkingStartTime || endTime,
        attributes: {
          ...(sid ? { [GEN_AI_SESSION_ID]: sid } : {}),
          ...(hermesSessionId ? { hermes_session_id: hermesSessionId } : {}),
          ...(allowDetail ? { [GEN_AI_OUTPUT]: currentThinkingText } : {}),
        },
      });
      span.setStatus({ code: SpanStatusCode.OK });
      span.end(endTime);
      currentThinkingText = "";
      thinkingStartTime = 0;
    }
  };

  for (const event of events) {
    if (event.type === "thinking") {
      if (currentThinkingText.length === 0) {
        thinkingStartTime = event.timestamp ?? Date.now();
      }
      currentThinkingText += event.text ?? "";
    } else if (currentThinkingText.length > 0) {
      flushThinking(event.timestamp ?? Date.now());
    }

    if (event.type === "tool_progress" && event.toolCallId) {
      const inputStr = typeof event.toolInput === "string" ? event.toolInput : safeJSONStringify(event.toolInput ?? {});
      const span = tracer.startSpan("hermes_tool_call", {
        kind: SpanKind.INTERNAL,
        startTime: event.timestamp,
        attributes: {
          [GEN_AI_SPAN_KIND]: GenAiSpanKind.Tool,
          ...(sid ? { [GEN_AI_SESSION_ID]: sid } : {}),
          ...(hermesSessionId ? { hermes_session_id: hermesSessionId } : {}),
          "hermes_tool_kind": event.toolName ?? "",
          "hermes_tool_title": event.toolTitle ?? "",
          "hermes_tool_call_id": event.toolCallId,
          ...(allowDetail ? { [GEN_AI_INPUT]: inputStr } : {}),
        },
      });

      pendingTools.set(event.toolCallId, {
        span,
        name: event.toolName ?? "",
        input: inputStr,
        startTime: event.timestamp ?? Date.now(),
      });
    }

    if (event.type === "tool_result" && event.toolCallId) {
      const pending = pendingTools.get(event.toolCallId);
      if (pending) {
        const outText = event.message ?? event.text ?? "";
        const endTime = event.timestamp ?? Date.now();
        pending.span.setAttributes({
          ...(allowDetail ? { [GEN_AI_OUTPUT]: outText } : {}),
        });
        pending.span.setStatus({ code: SpanStatusCode.OK });
        pending.span.end(endTime);

        if (toolDurationHistogram) {
          const durationS = Math.max(0, (endTime - pending.startTime) / 1000);
          toolDurationHistogram.record(durationS, {
            from: "hermes",
            tool_name: pending.name,
            error_type: false,  // 如何判断是否失败？
          });
        }

        pendingTools.delete(event.toolCallId);
      }
    }
  }

  // Flush any remaining thinking chunks
  flushThinking(Date.now());
}
