import { Tracer, Meter, Counter, Histogram } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { hostname } from "os";
import { _GEN_AI_DURATION_BUCKETS } from "./genaiConst.js";

let providerSingleton: NodeTracerProvider | null = null;
let tracerSingleton: Tracer | null = null;
let meterProviderSingleton: MeterProvider | null = null;
let meterSingleton: Meter | null = null;
let currentEndpoint: string | null = null;
let currentServiceName: string | null = null;

let tokenUsageCounter: Counter | null = null;
let toolDurationHistogram: Histogram | null = null;

export interface OtelProviderOptions {
  endpoint: string;
  serviceName?: string;
}

export function getOrCreateProvider(options: OtelProviderOptions): { 
  provider: NodeTracerProvider; 
  tracer: Tracer; 
  meterProvider: MeterProvider; 
  meter: Meter;
  tokenUsageCounter: Counter;
  toolDurationHistogram: Histogram;
} {
  const resolvedServiceName = options.serviceName || process.env.OTEL_SERVICE_NAME || "openclaw";

  if (
    providerSingleton &&
    tracerSingleton &&
    meterProviderSingleton &&
    meterSingleton &&
    tokenUsageCounter &&
    currentEndpoint === options.endpoint &&
    currentServiceName === resolvedServiceName
  ) {
    return { 
      provider: providerSingleton, 
      tracer: tracerSingleton, 
      meterProvider: meterProviderSingleton, 
      meter: meterSingleton,
      tokenUsageCounter,
      toolDurationHistogram: toolDurationHistogram!,
    };
  }

  if (providerSingleton) {
    providerSingleton.shutdown().catch(() => {});
    providerSingleton = null;
    tracerSingleton = null;
  }
  if (meterProviderSingleton) {
    meterProviderSingleton.shutdown().catch(() => {});
    meterProviderSingleton = null;
    meterSingleton = null;
    tokenUsageCounter = null;
    toolDurationHistogram = null;
  }
  currentEndpoint = null;

  const resource = resourceFromAttributes({
    "service.name":  resolvedServiceName,
    "host.name": hostname(),
  });

  const traceExporter = new OTLPTraceExporter({
    url: options.endpoint + "/v1/traces",
  });

  providerSingleton = new NodeTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(traceExporter)],
  });

  tracerSingleton = providerSingleton.getTracer("openclaw-otel-trace", "1.0.0");

  const metricExporter = new OTLPMetricExporter({
    url: options.endpoint + "/v1/metrics",
  });

  meterProviderSingleton = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: 30000,
      }),
    ],
  });

  meterSingleton = meterProviderSingleton.getMeter("openclaw-otel-trace", "1.0.0");

  tokenUsageCounter = meterSingleton.createCounter("openclaw.tokens", {
      description: "token消耗（由trace中的llm生命周期产生。与原生指标口径不同）",
  });
  toolDurationHistogram = meterSingleton.createHistogram("gen_ai.client.tool.duration", {
    description: "Duration of tool calls",
    unit: "s",
    advice: {
      explicitBucketBoundaries: _GEN_AI_DURATION_BUCKETS,
    },
  });

  currentEndpoint = options.endpoint;
  currentServiceName = resolvedServiceName;

  return { 
    provider: providerSingleton, 
    tracer: tracerSingleton, 
    meterProvider: meterProviderSingleton, 
    meter: meterSingleton,
    tokenUsageCounter,
    toolDurationHistogram,
  };
}

export async function shutdownProvider(): Promise<void> {
  if (providerSingleton) {
    await providerSingleton.shutdown();
    providerSingleton = null;
    tracerSingleton = null;
  }
  if (meterProviderSingleton) {
    await meterProviderSingleton.shutdown();
    meterProviderSingleton = null;
    meterSingleton = null;
    toolDurationHistogram = null;
  }
}

export function isProviderInitialized(): boolean {
  return providerSingleton !== null && meterProviderSingleton !== null;
}

export function getProviderTracer(): Tracer | null {
  return tracerSingleton;
}

export function getToolDurationHistogram(): Histogram | null {
  return toolDurationHistogram;
}
