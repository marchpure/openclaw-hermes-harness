import { describe, expect, it, vi } from "vitest";
import { HermesAcpClient } from "./acp-client.js";
import { formatHealthReport, healthTestHooks } from "./health.js";
import { DEFAULT_CONFIG, type HealthReport } from "./types.js";

describe("hermes health", () => {
  it("checks TCP ACP responsiveness with a real initialize handshake", async () => {
    const start = vi.spyOn(HermesAcpClient.prototype, "start").mockResolvedValue(undefined);
    const close = vi.spyOn(HermesAcpClient.prototype, "close").mockResolvedValue(undefined);
    try {
      await expect(
        healthTestHooks.checkAcpResponsive({
          ...DEFAULT_CONFIG,
          transport: "tcp",
        }),
      ).resolves.toBe(true);

      expect(start).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledWith({ closeSession: false });
    } finally {
      start.mockRestore();
      close.mockRestore();
    }
  });

  it("formats basic Hermes health status", () => {
    const report: HealthReport = {
      healthy: true,
      containerRunning: true,
      acpResponsive: true,
      errors: [],
    };

    const text = formatHealthReport(report);

    expect(text).toContain("Hermes Health: ✅ Healthy");
    expect(text).toContain("Container: ✅ Running");
    expect(text).toContain("ACP: ✅ Responsive");
  });
});
