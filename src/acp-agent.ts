import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import type { HermesPluginConfig } from "./types.js";

const ACPX_CONFIG_PATH = "/root/.acpx/config.json";

export function resolveHermesAcpAgentAlias(config: HermesPluginConfig): string {
  return config.acpAgentAlias?.trim() || "hermes";
}

export function resolveHermesAcpAgentCommand(config: HermesPluginConfig): string {
  if (config.acpAgentCommand?.trim()) {
    return config.acpAgentCommand.trim();
  }
  if (config.hermesCommand?.trim()) {
    return config.hermesCommand.trim();
  }
  return `docker exec -i ${config.hermesContainerName} hermes acp`;
}

export function buildAcpxConfigFragment(config: HermesPluginConfig): Record<string, unknown> {
  const alias = resolveHermesAcpAgentAlias(config);
  return {
    agents: {
      [alias]: {
        command: resolveHermesAcpAgentCommand(config),
      },
    },
  };
}

export function buildOpenClawConfigFragment(config: HermesPluginConfig): Record<string, unknown> {
  const alias = resolveHermesAcpAgentAlias(config);
  return {
    acp: {
      enabled: true,
      dispatch: { enabled: true },
      backend: "acpx",
      allowedAgents: [alias],
    },
    session: {
      threadBindings: {
        enabled: true,
        idleHours: 24,
        maxAgeHours: 0,
      },
    },
    channels: {
      discord: {
        threadBindings: {
          enabled: true,
          spawnAcpSessions: true,
        },
      },
      telegram: {
        threadBindings: {
          enabled: true,
          spawnAcpSessions: true,
        },
      },
    },
    plugins: {
      entries: {
        acpx: {
          enabled: true,
          config: {
            permissionMode: "approve-all",
            nonInteractivePermissions: "deny",
          },
        },
      },
    },
  };
}

export async function inspectHermesAcpAgent(config: HermesPluginConfig): Promise<{
  alias: string;
  command: string;
  acpxConfigPath: string;
  acpxConfigPresent: boolean;
  aliasConfigured: boolean;
}> {
  const alias = resolveHermesAcpAgentAlias(config);
  const command = resolveHermesAcpAgentCommand(config);

  let acpxConfigPresent = false;
  let aliasConfigured = false;

  try {
    await access(ACPX_CONFIG_PATH, fsConstants.R_OK);
    acpxConfigPresent = true;
    const raw = await readFile(ACPX_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const agents = parsed.agents as Record<string, { command?: string }> | undefined;
    if (agents?.[alias]?.command?.trim()) {
      aliasConfigured = true;
    }
  } catch {
    // Best-effort inspection only.
  }

  return {
    alias,
    command,
    acpxConfigPath: ACPX_CONFIG_PATH,
    acpxConfigPresent,
    aliasConfigured,
  };
}

export function formatHermesAcpAgentHelp(config: HermesPluginConfig): string {
  const alias = resolveHermesAcpAgentAlias(config);
  return [
    `ACP agent alias: ${alias}`,
    `Spawn from chat: /acp spawn ${alias} --bind here`,
    `Spawn in thread: /acp spawn ${alias} --thread auto`,
    `Tool API: sessions_spawn({ runtime: "acp", agentId: "${alias}", thread: true, mode: "session" })`,
    `Note: bind/thread behavior still depends on channel adapter support and ACP being enabled.`,
  ].join("\n");
}
