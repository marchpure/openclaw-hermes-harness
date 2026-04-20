import { DEFAULT_CONFIG, type HermesPluginConfig as HermesAcpPluginConfig } from "./types.js";

export type HermesPluginConfig = {
  runtimeMode?: "app-server" | "acp";
  discovery?: {
    enabled?: boolean;
    models?: string[];
  };
  acp?: Partial<HermesAcpPluginConfig>;
  runtime?: Partial<HermesAcpPluginConfig>;
} & Partial<HermesAcpPluginConfig>;

export function readHermesPluginConfig(value: unknown): HermesPluginConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const input = value as Record<string, unknown>;
  const discovery = readObject(input.discovery);
  const acp = readObject(input.acp);
  const runtime = readObject(input.runtime);
  return {
    ...(input.runtimeMode === "app-server" || input.runtimeMode === "acp"
      ? { runtimeMode: input.runtimeMode }
      : {}),
    ...(discovery
      ? {
          discovery: {
            ...(typeof discovery.enabled === "boolean" ? { enabled: discovery.enabled } : {}),
            ...(Array.isArray(discovery.models)
              ? {
                  models: discovery.models
                    .map((entry) => readNonEmptyString(entry))
                    .filter((entry): entry is string => Boolean(entry)),
                }
              : {}),
          },
        }
      : {}),
    ...(acp ? { acp: readHermesAcpPartialConfig(acp) } : {}),
    ...(runtime ? { runtime: readHermesAcpPartialConfig(runtime) } : {}),
    ...readHermesAcpPartialConfig(input),
  };
}

export function resolveHermesAcpConfig(pluginConfig?: unknown): HermesAcpPluginConfig {
  const parsed = readHermesPluginConfig(pluginConfig);
  return {
    ...DEFAULT_CONFIG,
    ...(parsed.runtime ?? {}),
    ...(parsed.acp ?? {}),
    ...readHermesAcpPartialConfig(parsed),
  };
}

function readHermesAcpPartialConfig(
  input: Record<string, unknown>,
): Partial<HermesAcpPluginConfig> {
  return {
    ...(readNonEmptyString(input.hermesCommand)
      ? { hermesCommand: readNonEmptyString(input.hermesCommand) }
      : {}),
    ...(readNonEmptyString(input.hermesContainerName)
      ? { hermesContainerName: readNonEmptyString(input.hermesContainerName) }
      : {}),
    ...(readNonEmptyString(input.hermesDataDir)
      ? { hermesDataDir: readNonEmptyString(input.hermesDataDir) }
      : {}),
    ...(readTransport(input.transport) ? { transport: readTransport(input.transport) } : {}),
    ...(readNonEmptyString(input.tcpHost) ? { tcpHost: readNonEmptyString(input.tcpHost) } : {}),
    ...(readPort(input.tcpPort) ? { tcpPort: readPort(input.tcpPort) } : {}),
    ...(readNonEmptyString(input.defaultModel)
      ? { defaultModel: readNonEmptyString(input.defaultModel) }
      : {}),
    ...(readContextLevel(input.defaultContextLevel)
      ? { defaultContextLevel: readContextLevel(input.defaultContextLevel) }
      : {}),
    ...(readCredentialScopeMode(input.defaultCredentialScope)
      ? { defaultCredentialScope: readCredentialScopeMode(input.defaultCredentialScope) }
      : {}),
    ...(readWriteback(input.defaultWriteback)
      ? { defaultWriteback: readWriteback(input.defaultWriteback) }
      : {}),
    ...(readPositiveNumber(input.timeout) ? { timeout: readPositiveNumber(input.timeout) } : {}),
    ...(typeof input.autoStrategy === "boolean" ? { autoStrategy: input.autoStrategy } : {}),
    ...(typeof input.enableLayeredProtocol === "boolean"
      ? { enableLayeredProtocol: input.enableLayeredProtocol }
      : {}),
  };
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readPort(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535
    ? value
    : undefined;
}

function readTransport(value: unknown): HermesAcpPluginConfig["transport"] | undefined {
  return value === "tcp" || value === "stdio" ? value : undefined;
}

function readContextLevel(
  value: unknown,
): HermesAcpPluginConfig["defaultContextLevel"] | undefined {
  return value === "L0" || value === "L1" || value === "L2" || value === "L3" ? value : undefined;
}

function readCredentialScopeMode(
  value: unknown,
): HermesAcpPluginConfig["defaultCredentialScope"] | undefined {
  if (value === "C0") {
    return "none";
  }
  if (value === "C1") {
    return "specified";
  }
  if (value === "C2") {
    return "all";
  }
  return value === "none" || value === "specified" || value === "all" ? value : undefined;
}

function readWriteback(value: unknown): HermesAcpPluginConfig["defaultWriteback"] | undefined {
  return value === "W0" || value === "W1" || value === "W2" || value === "W3" ? value : undefined;
}
