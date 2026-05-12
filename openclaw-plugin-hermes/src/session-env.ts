import type { HermesPluginConfig } from "./types.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

function parseDotEnvValue(raw: string): string {
  const value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function readOpenClawGatewayEnvFile(): Record<string, string> {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || join(homedir(), ".openclaw");
  const path = join(stateDir, "gateway.systemd.env");
  if (!existsSync(path)) return {};

  const env: Record<string, string> = {};
  try {
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator <= 0) continue;
      const key = trimmed.slice(0, separator).trim();
      if (!WEB_SEARCH_ENV_KEYS.includes(key as (typeof WEB_SEARCH_ENV_KEYS)[number])) continue;
      const value = parseDotEnvValue(trimmed.slice(separator + 1));
      if (value) env[key] = value;
    }
  } catch {
    // Best-effort fallback only. Missing env is surfaced by the skill itself.
  }
  return env;
}

export function resolveContainerSkillEnv(config: HermesPluginConfig): Record<string, string> {
  const env: Record<string, string> = {};
  const configuredEnv = config.mcpBridge.env ?? {};
  const gatewayEnvFile = readOpenClawGatewayEnvFile();
  for (const key of WEB_SEARCH_ENV_KEYS) {
    const value =
      readNonEmptyEnv(key, configuredEnv) ??
      readNonEmptyEnv(key, process.env) ??
      readNonEmptyEnv(key, gatewayEnvFile);
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

export function computeHermesSessionEnvHash(
  config: HermesPluginConfig,
  ...envs: Array<Record<string, string> | undefined>
): string | undefined {
  const env = mergeHermesSessionEnv(config, ...envs);
  if (!env || Object.keys(env).length === 0) return undefined;
  const redactedShape = Object.keys(env)
    .sort()
    .map((key) => [key, createHash("sha256").update(env[key] ?? "").digest("hex")]);
  return createHash("sha256").update(JSON.stringify(redactedShape)).digest("hex");
}
