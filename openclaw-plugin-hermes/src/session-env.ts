import type { HermesPluginConfig } from "./types.js";

const WEB_SEARCH_ENV_KEYS = [
  "WEB_SEARCH_API_KEY",
  "VOLCENGINE_ACCESS_KEY",
  "VOLCENGINE_SECRET_KEY",
  "VOLCENGINE_SESSION_TOKEN",
  "VOLCENGINE_REGION",
] as const;

function readNonEmptyEnv(key: string, source: Record<string, string | undefined>): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function resolveContainerSkillEnv(config: HermesPluginConfig): Record<string, string> {
  const env: Record<string, string> = {};
  const configuredEnv = config.mcpBridge.env ?? {};
  for (const key of WEB_SEARCH_ENV_KEYS) {
    const value = readNonEmptyEnv(key, configuredEnv) ?? readNonEmptyEnv(key, process.env);
    if (value) env[key] = value;
  }
  return env;
}

export function mergeHermesSessionEnv(
  config: HermesPluginConfig,
  ...envs: Array<Record<string, string> | undefined>
): Record<string, string> | undefined {
  const merged = {
    ...resolveContainerSkillEnv(config),
    ...(config.mcpBridge.enabled ? config.mcpBridge.env : {}),
  };
  for (const env of envs) {
    if (env) Object.assign(merged, env);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}
