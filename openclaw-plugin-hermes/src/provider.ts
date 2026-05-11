import type {
  ProviderRuntimeModel,
  UnifiedModelCatalogProviderPlugin,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  normalizeModelCompat,
  type ModelDefinitionConfig,
  type ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";

const PROVIDER_ID = "hermes";
const HERMES_PROVIDER_BASE_URL = "http://127.0.0.1/hermes-runtime";
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 32_000;
const DEFAULT_CATALOG_MODELS = ["default"];

export function buildHermesProvider(options: { pluginConfig?: unknown } = {}): ProviderPlugin {
  return {
    id: PROVIDER_ID,
    label: "Hermes",
    docsPath: "/providers/models",
    auth: [],
    staticCatalog: {
      order: "late",
      run: async () => buildHermesProviderCatalog({ pluginConfig: options.pluginConfig }),
    },
    catalog: {
      order: "late",
      run: async () => buildHermesProviderCatalog({ pluginConfig: options.pluginConfig }),
    },
    resolveDynamicModel: (ctx: { modelId: string }) => resolveHermesDynamicModel(ctx.modelId),
    // Hermes provider 不直接持有真实上游 API 凭证；它只是给 OpenClaw 一个
    // 可路由的 provider/model 外壳，真正执行发生在 agent harness 内。
    resolveSyntheticAuth: () => ({
      apiKey: "hermes-runtime",
      source: "hermes-runtime",
      mode: "token",
    }),
    isModernModelRef: () => true,
  };
}

export async function buildHermesProviderCatalog(
  _options: { pluginConfig?: unknown } = {},
): Promise<{
  provider: {
    baseUrl: string;
    apiKey: string;
    auth: "token";
    api: "openai-responses";
    models: ModelDefinitionConfig[];
  };
}> {
  return {
    provider: {
      baseUrl: HERMES_PROVIDER_BASE_URL,
      apiKey: "hermes-runtime",
      auth: "token",
      api: "openai-responses",
      // Keep the public catalog intentionally minimal: Hermes is officially
      // configured through `hermes/default`, while dynamic ids remain an
      // internal compatibility path handled by the harness/runtime bridge.
      models: DEFAULT_CATALOG_MODELS.map((id) => buildModelDefinition(id)),
    },
  };
}

export function buildHermesModelCatalogProvider(): UnifiedModelCatalogProviderPlugin {
  return {
    provider: PROVIDER_ID,
    kinds: ["text"],
    staticCatalog: () =>
      DEFAULT_CATALOG_MODELS.map((id) => ({
        kind: "text",
        provider: PROVIDER_ID,
        model: id,
        label: id,
        source: "static",
      })),
  };
}

function resolveHermesDynamicModel(modelId: string): ProviderRuntimeModel | undefined {
  const id = modelId.trim();
  if (!id) {
    return undefined;
  }
  // Dynamic resolution keeps custom ids routable without needing a full remote
  // model discovery round-trip.
  return normalizeModelCompat({
    ...buildModelDefinition(id),
    provider: PROVIDER_ID,
    baseUrl: HERMES_PROVIDER_BASE_URL,
  } as ProviderRuntimeModel);
}

function buildModelDefinition(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    api: "openai-responses",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    compat: {
      supportsReasoningEffort: true,
      supportsUsageInStreaming: true,
    },
  };
}
