import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "./test-support/plugin-api.js";
import { createHermesAgentHarness } from "./harness.js";
import plugin from "./index.js";

describe("hermes plugin", () => {
  it("is opt-in by default", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { enabledByDefault?: unknown };

    expect(manifest.enabledByDefault).toBeUndefined();
  });

  it("registers the hermes provider and agent harness", () => {
    const registerAgentHarness = vi.fn();
    const registerProvider = vi.fn();
    const registerTool = vi.fn();

    plugin.register(
      createTestPluginApi({
        id: "hermes",
        name: "Hermes",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: {} as never,
        registerAgentHarness,
        registerProvider,
        registerTool,
      }),
    );

    expect(registerProvider.mock.calls[0]?.[0]).toMatchObject({ id: "hermes", label: "Hermes" });
    expect(registerAgentHarness.mock.calls[0]?.[0]).toMatchObject({
      id: "hermes",
      label: "Hermes agent harness",
    });
    expect(registerTool.mock.calls.map((call) => call[0]?.name)).toEqual([
      "hermes_dispatch",
      "hermes_status",
      "hermes_strategy",
    ]);
  });

  it("only claims the hermes provider by default", () => {
    const harness = createHermesAgentHarness();

    expect(
      harness.supports({ provider: "hermes", modelId: "default", requestedRuntime: "auto" })
        .supported,
    ).toBe(true);
    expect(
      harness.supports({ provider: "codex", modelId: "gpt-5.4", requestedRuntime: "auto" }),
    ).toMatchObject({ supported: false });
  });
});
