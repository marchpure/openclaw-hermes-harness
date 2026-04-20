/**
 * openclaw-plugin-hermes — Health Check
 *
 * Verifies Hermes container status, ACP responsiveness, and version compatibility.
 */

import { execFile } from "node:child_process";
import { request } from "node:http";
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
    hostBridgeAvailable: false,
    larkDocsSearchAvailable: false,
    larkDocsFetchAvailable: false,
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

  // 5. Check the host capability bridge wrapper inside Hermes.
  try {
    report.hostBridgeAvailable = await checkHostBridgeAvailable(config);
    report.larkDocsSearchAvailable = report.hostBridgeAvailable;
    report.larkDocsFetchAvailable = report.hostBridgeAvailable;
    if (!report.hostBridgeAvailable) {
      report.errors.push("Host bridge check failed: openclaw-host-tool is not available in Hermes container");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    report.errors.push(`Host bridge check failed: ${msg}`);
  }

  report.healthy =
    report.containerRunning &&
    report.acpResponsive &&
    report.hostBridgeAvailable &&
    report.larkDocsSearchAvailable &&
    report.larkDocsFetchAvailable &&
    report.errors.length === 0;
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

async function checkHostBridgeAvailable(config: HermesPluginConfig): Promise<boolean> {
  if (!config.hostBridgeEnabled) {
    return false;
  }
  try {
    const bridgeHost = config.hostBridgeHost === "0.0.0.0" ? "127.0.0.1" : config.hostBridgeHost;
    const endpoint = `http://${bridgeHost}:${config.hostBridgePort}/__openclaw/hermes-host-tool`;
    const checkScript = [
      "command -v openclaw-host-tool >/dev/null 2>&1",
      `test -n ${JSON.stringify(endpoint)}`,
    ].join(" && ");
    await execFileAsync(
      "docker",
      ["exec", "-e", `OPENCLAW_HOST_TOOL_URL=${endpoint}`, config.hermesContainerName, "sh", "-c", checkScript],
      { timeout: EXEC_TIMEOUT },
    );
    return checkHostBridgeEndpoint(bridgeHost, config.hostBridgePort);
  } catch {
    return false;
  }
}

async function checkHostBridgeEndpoint(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      {
        hostname: host,
        port,
        path: "/__openclaw/hermes-host-tool",
        method: "POST",
        timeout: EXEC_TIMEOUT,
        headers: {
          "content-type": "application/json",
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          resolve(res.statusCode === 400 || res.statusCode === 404);
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end(JSON.stringify({ tool: "lark.docs.search", arguments: { query: "" } }));
  });
}

export const healthTestHooks = {
  checkAcpResponsive,
  checkHostBridgeAvailable,
};

/**
 * Format a health report as a human-readable string.
 */
export function formatHealthReport(report: HealthReport): string {
  const lines: string[] = [];
  lines.push(`Hermes Health: ${report.healthy ? "✅ Healthy" : "❌ Unhealthy"}`);
  lines.push(`  Container: ${report.containerRunning ? "✅ Running" : "❌ Not Running"}`);
  lines.push(`  ACP: ${report.acpResponsive ? "✅ Responsive" : "❌ Not Responsive"}`);
  lines.push(`  Host Bridge: ${report.hostBridgeAvailable ? "✅ Available" : "❌ Unavailable"}`);
  lines.push(`  Lark Docs Search: ${report.larkDocsSearchAvailable ? "✅ Available" : "❌ Unavailable"}`);
  lines.push(`  Lark Docs Fetch: ${report.larkDocsFetchAvailable ? "✅ Available" : "❌ Unavailable"}`);

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
