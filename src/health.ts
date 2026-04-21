/**
 * openclaw-plugin-hermes — Health Check
 *
 * Verifies Hermes container status, ACP responsiveness, and version compatibility.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HermesAcpClient } from "./acp-client.js";
import type { HermesPluginConfig, HealthReport } from "./types.js";

const execFileAsync = promisify(execFile);
const EXEC_TIMEOUT = 10_000; // 10s timeout for health checks

/** hermes 安装在容器内的 venv 中，需要先激活才能使用 */
const HERMES_VENV_ACTIVATE = "source /opt/hermes/.venv/bin/activate";

/** 构建容器内 hermes 命令：激活 venv 后执行指定子命令 */
function buildHermesExecArgs(containerName: string, hermesArgs: string[]): string[] {
  const cmd = `${HERMES_VENV_ACTIVATE} && hermes ${hermesArgs.join(" ")}`;
  return ["exec", containerName, "bash", "-c", cmd];
}

// ─── Health Check ───────────────────────────────────────────────────────────

/**
 * Run a comprehensive health check on the Hermes container.
 */
export async function checkHealth(config: HermesPluginConfig): Promise<HealthReport> {
  const report: HealthReport = {
    healthy: false,
    containerRunning: false,
    acpResponsive: false,
    errors: [],
  };

  // 1. Check if Docker container is running
  try {
    const containerStatus = await checkContainerRunning(config.hermesContainerName);
    report.containerRunning = containerStatus.running;
    if (!containerStatus.running) {
      report.errors.push(`Container '${config.hermesContainerName}' is not running: ${containerStatus.status}`);
      return report;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    report.errors.push(`Docker check failed: ${msg}`);
    return report;
  }

  // 2. Check container resource usage
  try {
    report.containerStats = await getContainerStats(config.hermesContainerName);
  } catch {
    // Non-critical
  }

  // 3. Check hermes version inside container
  try {
    const version = await getHermesVersion(config);
    report.hermesVersion = version;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    report.errors.push(`Version check failed: ${msg}`);
  }

  // 4. Check ACP responsiveness
  try {
    report.acpResponsive = await checkAcpResponsive(config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    report.errors.push(`ACP check failed: ${msg}`);
  }

  report.healthy = report.containerRunning && report.acpResponsive && report.errors.length === 0;
  return report;
}

// ─── Individual Checks ──────────────────────────────────────────────────────

async function checkContainerRunning(
  containerName: string,
): Promise<{ running: boolean; status: string }> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["inspect", "--format", "{{.State.Status}}", containerName],
      { timeout: EXEC_TIMEOUT },
    );
    const status = stdout.trim();
    return { running: status === "running", status };
  } catch (err) {
    // Container doesn't exist
    return { running: false, status: "not found" };
  }
}

async function getContainerStats(
  containerName: string,
): Promise<{ cpuPercent: string; memUsage: string; memLimit: string }> {
  const { stdout } = await execFileAsync(
    "docker",
    ["stats", "--no-stream", "--format", "{{.CPUPerc}}\t{{.MemUsage}}", containerName],
    { timeout: EXEC_TIMEOUT },
  );
  const parts = stdout.trim().split("\t");
  const cpuPercent = parts[0] ?? "N/A";
  const memParts = (parts[1] ?? "N/A / N/A").split("/").map((s) => s.trim());
  return {
    cpuPercent,
    memUsage: memParts[0] ?? "N/A",
    memLimit: memParts[1] ?? "N/A",
  };
}

async function getHermesVersion(config: HermesPluginConfig): Promise<string> {
  if (config.hermesCommand) {
    const parts = config.hermesCommand.split(/\s+/);
    const versionCmd = parts[0];
    const versionArgs = [...parts.slice(1).filter((a) => a !== "acp"), "version"];
    const { stdout } = await execFileAsync(versionCmd, versionArgs, {
      timeout: EXEC_TIMEOUT,
    });
    return stdout.trim();
  }

  const { stdout } = await execFileAsync(
    "docker",
    buildHermesExecArgs(config.hermesContainerName, ["version"]),
    { timeout: EXEC_TIMEOUT },
  );
  return stdout.trim();
}

async function checkAcpResponsive(config: HermesPluginConfig): Promise<boolean> {
  try {
    if (config.transport === "tcp") {
      const client = new HermesAcpClient(config, {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      });
      await client.start();
      await client.close({ closeSession: false });
      return true;
    }

    if (config.hermesCommand) {
      const parts = config.hermesCommand.split(/\s+/);
      await execFileAsync(parts[0], [...parts.slice(1), "--help"], {
        timeout: EXEC_TIMEOUT,
      });
    } else {
      await execFileAsync(
        "docker",
        buildHermesExecArgs(config.hermesContainerName, ["acp", "--help"]),
        { timeout: EXEC_TIMEOUT },
      );
    }
    return true;
  } catch {
    return false;
  }
}

export const healthTestHooks = {
  checkAcpResponsive,
};

/**
 * Format a health report as a human-readable string.
 */
export function formatHealthReport(report: HealthReport): string {
  const lines: string[] = [];
  lines.push(`Hermes Health: ${report.healthy ? "✅ Healthy" : "❌ Unhealthy"}`);
  lines.push(`  Container: ${report.containerRunning ? "✅ Running" : "❌ Not Running"}`);
  lines.push(`  ACP: ${report.acpResponsive ? "✅ Responsive" : "❌ Not Responsive"}`);

  if (report.hermesVersion) {
    lines.push(`  Version: ${report.hermesVersion}`);
  }

  if (report.containerStats) {
    lines.push(`  CPU: ${report.containerStats.cpuPercent}`);
    lines.push(`  Memory: ${report.containerStats.memUsage} / ${report.containerStats.memLimit}`);
  }

  if (report.errors.length > 0) {
    lines.push("  Errors:");
    for (const err of report.errors) {
      lines.push(`    - ${err}`);
    }
  }

  return lines.join("\n");
}
