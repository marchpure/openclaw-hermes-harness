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

export function mapHostWorkspaceToRuntimeWorkspace(
  config: HermesPluginConfig,
  hostPath: string,
  taskId: string,
): string {
  const hostExecEnv = resolveExecEnvHostPath(config, taskId);
  if (hostPath === hostExecEnv) {
    return resolveExecEnvRuntimePath(config, taskId);
  }
  return hostPath;
}
