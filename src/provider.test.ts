import { describe, expect, it } from "vitest";
import { buildHermesProvider, buildHermesProviderCatalog } from "./provider.js";

describe("hermes provider", () => {
  it("exposes the configured Hermes model catalog", async () => {
    const result = await buildHermesProviderCatalog({
      pluginConfig: {
        discovery: {
          models: ["hermes-agent", "hermes-planner"],
        },
      },
    });

    expect(result.provider.models.map((model) => model.id)).toEqual([
      "hermes-agent",
      "hermes-planner",
    ]);
  });

  it("falls back to the Hermes container default model", async () => {
    const result = await buildHermesProviderCatalog();

    expect(result.provider.models.map((model) => model.id)).toEqual([
      "doubao-seed-2-0-pro-260215",
    ]);
  });

  it("resolves arbitrary Hermes model ids", () => {
    const provider = buildHermesProvider();
    const resolved = provider.resolveDynamicModel?.({
      provider: "hermes",
      modelId: "deep-research",
      modelRegistry: {} as never,
    });

    expect(resolved).toMatchObject({
      provider: "hermes",
      id: "deep-research",
    });
  });

  it("declares synthetic auth because the harness owns Hermes credentials", () => {
    const provider = buildHermesProvider();

    expect(provider.resolveSyntheticAuth?.({ provider: "hermes" })).toEqual({
      apiKey: "hermes-runtime",
      source: "hermes-runtime",
      mode: "token",
    });
  });
});
