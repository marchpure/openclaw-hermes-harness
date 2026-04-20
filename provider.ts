import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  normalizeModelCompat,
  type ModelDefinitionConfig,
  type ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";
import { readHermesPluginConfig } from "./src/config.js";

const PROVIDER_ID = "hermes";
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 32_000;
const FALLBACK_HERMES_MODELS = ["default"];

export function buildHermesProvider(options: { pluginConfig?: unknown } = {}): ProviderPlugin {
  return {
    id: PROVIDER_ID,
    label: "Hermes",
    docsPath: "/providers/models",
    auth: [],
    catalog: {
      order: "late",
      run: async () => buildHermesProviderCatalog({ pluginConfig: options.pluginConfig }),
    },
    resolveDynamicModel: (ctx) => resolveHermesDynamicModel(ctx.modelId),
    resolveSyntheticAuth: () => ({
      apiKey: "hermes-runtime",
      source: "hermes-runtime",
      mode: "token",
    }),
    isModernModelRef: () => true,
  };
}

export async function buildHermesProviderCatalog(
  options: { pluginConfig?: unknown } = {},
): Promise<{
  provider: {
    baseUrl: string;
    apiKey: string;
    auth: "token";
    api: "openai-responses";
    models: ModelDefinitionConfig[];
  };
}> {
  const config = readHermesPluginConfig(options.pluginConfig);
  const configuredModels =
    config.discovery?.enabled === false ? config.discovery.models : config.discovery?.models;
  const modelIds =
    configuredModels && configuredModels.length > 0 ? configuredModels : FALLBACK_HERMES_MODELS;
  return {
    provider: {
      baseUrl: "http://127.0.0.1/hermes-runtime",
      apiKey: "hermes-runtime",
      auth: "token",
      api: "openai-responses",
      models: modelIds.map((id) => buildModelDefinition(id)),
    },
  };
}

function resolveHermesDynamicModel(modelId: string): ProviderRuntimeModel | undefined {
  const id = modelId.trim();
  if (!id) {
    return undefined;
  }
  return normalizeModelCompat({
    ...buildModelDefinition(id),
    provider: PROVIDER_ID,
    baseUrl: "http://127.0.0.1/hermes-runtime",
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
