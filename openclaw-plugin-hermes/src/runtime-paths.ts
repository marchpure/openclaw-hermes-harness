import { join } from "node:path";
import type { HermesPluginConfig } from "./types.js";

export function resolveExecEnvHostRoot(config: HermesPluginConfig): string {
  const configured = config.execEnvRootDir?.trim();
  if (configured) return configured;
  const dataDir = config.hermesDataDir?.trim();
  if (dataDir) return join(dataDir, "execenv");
  return "/var/cache/hermes-agent/execenv";
}

export function resolveExecEnvRuntimeRoot(config: HermesPluginConfig): string {
  const configured = config.runtimeExecEnvRootDir?.trim();
  if (configured) return configured;
  return resolveExecEnvHostRoot(config);
}

export function resolveExecEnvHostPath(config: HermesPluginConfig, taskId: string): string {
  return join(resolveExecEnvHostRoot(config), taskId);
}

export function resolveExecEnvRuntimePath(config: HermesPluginConfig, taskId: string): string {
  return join(resolveExecEnvRuntimeRoot(config), taskId);
}

export function resolveHostExecEnvPathFromRuntimePath(
  config: HermesPluginConfig,
  runtimeExecEnvPath: string,
): string {
  const runtimeRoot = resolveExecEnvRuntimeRoot(config);
  if (runtimeExecEnvPath === runtimeRoot) {
    return resolveExecEnvHostRoot(config);
  }
  if (runtimeExecEnvPath.startsWith(`${runtimeRoot}/`)) {
    const suffix = runtimeExecEnvPath.slice(runtimeRoot.length + 1);
    return join(resolveExecEnvHostRoot(config), suffix);
  }
  return resolveExecEnvHostPath(config, runtimeExecEnvPath.split("/").pop() ?? "");
}
