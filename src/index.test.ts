import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { createPluginApiStub } from "./test-support/plugin-api.js";

describe("hermes plugin", () => {
  it("registers the hermes provider, harness, and tools", () => {
    const registerProvider = vi.fn();
    const registerAgentHarness = vi.fn();
    const registerTool = vi.fn();

    plugin.register({
      ...createPluginApiStub(),
      registerProvider,
      registerAgentHarness,
      registerTool,
    });

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
});
