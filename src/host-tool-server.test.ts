import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startHermesHostToolServer, stopHermesHostToolServerForTest } from "./host-tool-server.js";
import { DEFAULT_CONFIG } from "./types.js";

describe("host tool server", () => {
  afterEach(async () => {
    await stopHermesHostToolServerForTest();
  });

  it("does not start when host bridge is disabled", async () => {
    await expect(
      startHermesHostToolServer({
        ...DEFAULT_CONFIG,
        hostBridgeEnabled: false,
      }),
    ).resolves.toBeUndefined();
  });

  it("serves structured validation errors on the host tool endpoint", async () => {
    const state = await startHermesHostToolServer({
      ...DEFAULT_CONFIG,
      hostBridgeEnabled: true,
      hostBridgeHost: "127.0.0.1",
      hostBridgePort: 0,
    });
    expect(state).toBeDefined();
    const address = state?.server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const response = await postJson(port, {
      tool: "lark.docs.search",
      arguments: { query: "x".repeat(51) },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({
      ok: false,
      tool: "lark.docs.search",
      error: { code: "invalid_arguments" },
    });
  });
});

async function postJson(port: number, body: unknown): Promise<{ statusCode: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/__openclaw/hermes-host-tool",
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
        });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}
