import { describe, expect, it } from "vitest";
import { buildHermesProvider, buildHermesProviderCatalog } from "./provider.js";

describe("hermes provider", () => {
  it("exposes the configured Hermes model catalog", async () => {
    const result = await buildHermesProviderCatalog({
      pluginConfig: { discovery: { models: ["default", "planning"] } },
    });

    expect(result.provider).toMatchObject({
      auth: "token",
      api: "openai-responses",
      models: [
        { id: "default", name: "default", reasoning: true },
        { id: "planning", name: "planning", reasoning: true },
      ],
    });
  });

  it("falls back to hermes/default", async () => {
    const result = await buildHermesProviderCatalog();

    expect(result.provider.models.map((model) => model.id)).toEqual(["default"]);
  });

  it("resolves arbitrary Hermes model ids", () => {
    const provider = buildHermesProvider();

    const model = provider.resolveDynamicModel?.({
      provider: "hermes",
      modelId: " custom-model ",
      modelRegistry: { find: () => null },
    } as never);

    expect(model).toMatchObject({
      id: "custom-model",
      provider: "hermes",
      api: "openai-responses",
      input: ["text", "image"],
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
