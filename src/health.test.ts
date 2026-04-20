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

  it("formats host bridge and lark docs capability status", () => {
    const report: HealthReport = {
      healthy: true,
      containerRunning: true,
      acpResponsive: true,
      hostBridgeAvailable: true,
      larkDocsSearchAvailable: true,
      larkDocsFetchAvailable: true,
      errors: [],
    };

    const text = formatHealthReport(report);

    expect(text).toContain("Host Bridge: ✅ Available");
    expect(text).toContain("Lark Docs Search: ✅ Available");
    expect(text).toContain("Lark Docs Fetch: ✅ Available");
  });
});
