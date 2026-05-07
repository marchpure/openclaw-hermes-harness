import { DEFAULT_CONFIG, type HermesPluginConfig as HermesAcpPluginConfig } from "./types.js";

export type HermesPluginConfig = Partial<HermesAcpPluginConfig> & {
  discovery?: {
    models?: string[];
  };
};

export function readHermesPluginConfig(value: unknown): HermesPluginConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const input = value as Record<string, unknown>;
  const discovery = readObject(input.discovery);
  return {
    // Keep reading older discovery overrides for config compatibility, but the
    // supported public model surface is now just `hermes/default`.
    ...(discovery
      ? {
          discovery: {
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
    ...readHermesAcpPartialConfig(input),
  };
}

export function resolveHermesAcpConfig(pluginConfig?: unknown): HermesAcpPluginConfig {
  const parsed = readHermesPluginConfig(pluginConfig);
  return {
    ...DEFAULT_CONFIG,
    ...readHermesAcpPartialConfig(parsed),
  };
}

function readHermesAcpPartialConfig(
  input: Record<string, unknown>,
): Partial<HermesAcpPluginConfig> {
  const skillProjection = readObject(input.skillProjection);
  const execEnvCleanup = readObject(input.execEnvCleanup);
  const mcpBridge = readObject(input.mcpBridge);
  const otel = readObject(input.otel);
  return {
    ...(readNonEmptyString(input.hermesContainerName)
      ? { hermesContainerName: readNonEmptyString(input.hermesContainerName) }
      : {}),
    ...(readNonEmptyString(input.hermesDataDir)
      ? { hermesDataDir: readNonEmptyString(input.hermesDataDir) }
      : {}),
    ...(readNonEmptyString(input.execEnvRootDir)
      ? { execEnvRootDir: readNonEmptyString(input.execEnvRootDir) }
      : {}),
    ...(readNonEmptyString(input.runtimeExecEnvRootDir)
      ? { runtimeExecEnvRootDir: readNonEmptyString(input.runtimeExecEnvRootDir) }
      : {}),
    ...(typeof input.mirrorExecEnvToContainer === "boolean"
      ? { mirrorExecEnvToContainer: input.mirrorExecEnvToContainer }
      : {}),
    ...(readNonEmptyString(input.projectionVersion)
      ? { projectionVersion: readNonEmptyString(input.projectionVersion) }
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
    ...(readContextLevel(input.runtimeMinContextLevel)
      ? { runtimeMinContextLevel: readContextLevel(input.runtimeMinContextLevel) }
      : {}),
    ...(typeof input.runtimeProjectWorkspaceSkills === "boolean"
      ? { runtimeProjectWorkspaceSkills: input.runtimeProjectWorkspaceSkills }
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
    ...(skillProjection
      ? {
          skillProjection: {
            hostBackedDenylist: Array.isArray(skillProjection.hostBackedDenylist)
              ? skillProjection.hostBackedDenylist.filter(
                  (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
                )
              : DEFAULT_CONFIG.skillProjection.hostBackedDenylist,
            hostBackedSkillNames: Array.isArray(skillProjection.hostBackedSkillNames)
              ? skillProjection.hostBackedSkillNames.filter(
                  (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
                )
              : DEFAULT_CONFIG.skillProjection.hostBackedSkillNames,
            containerEnvSkillNames: Array.isArray(skillProjection.containerEnvSkillNames)
              ? skillProjection.containerEnvSkillNames.filter(
                  (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
                )
              : DEFAULT_CONFIG.skillProjection.containerEnvSkillNames,
            alwaysExposeSkillNames: Array.isArray(skillProjection.alwaysExposeSkillNames)
              ? skillProjection.alwaysExposeSkillNames.filter(
                  (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
                )
              : DEFAULT_CONFIG.skillProjection.alwaysExposeSkillNames,
          },
        }
      : {}),
    ...(mcpBridge
      ? {
          mcpBridge: {
            enabled:
              typeof mcpBridge.enabled === "boolean"
                ? mcpBridge.enabled
                : DEFAULT_CONFIG.mcpBridge.enabled,
            servers: readRecord(mcpBridge.servers) ?? DEFAULT_CONFIG.mcpBridge.servers,
            env: readStringRecord(mcpBridge.env) ?? DEFAULT_CONFIG.mcpBridge.env,
          },
        }
      : {}),
    ...(execEnvCleanup
      ? {
          execEnvCleanup: {
            enabled:
              typeof execEnvCleanup.enabled === "boolean"
                ? execEnvCleanup.enabled
                : DEFAULT_CONFIG.execEnvCleanup.enabled,
            maxAgeHours:
              readPositiveNumber(execEnvCleanup.maxAgeHours) ??
              DEFAULT_CONFIG.execEnvCleanup.maxAgeHours,
            maxCount:
              readPositiveNumber(execEnvCleanup.maxCount) ?? DEFAULT_CONFIG.execEnvCleanup.maxCount,
          },
        }
      : {}),
    ...(otel
      ? {
          otel: {
            ...(readNonEmptyString(otel.endpoint)
              ? { endpoint: readNonEmptyString(otel.endpoint) }
              : {}),
            ...(readNonEmptyString(otel.serviceName)
              ? { serviceName: readNonEmptyString(otel.serviceName) }
              : {}),
          },
        }
      : {}),
  };
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : undefined;
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  const record = readRecord(value);
  if (!record) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    }),
  );
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
  // The deployed harness only exposes the local TCP bridge. Ignore older transport values.
  return value === "tcp" ? value : undefined;
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
