import { describe, expect, it } from "vitest";
import { createHermesAgentHarness } from "./harness.js";

describe("hermes harness", () => {
  it("maps a Hermes runtime response to an agent harness result", async () => {
    const harness = createHermesAgentHarness({
      client: {
        async runAttempt() {
          return {
            assistantText: "hello from hermes",
            sessionId: "session-123",
            usage: { input: 1, output: 2, total: 3 },
            hadPotentialSideEffects: true,
            replaySafe: false,
          };
        },
      },
    });

    const result = await harness.runAttempt({
      provider: "hermes",
      modelId: "default",
      prompt: "test prompt",
      runId: "run-123",
      sessionId: "fallback-session",
      sessionFile: "/tmp/hermes/session.json",
      timeoutMs: 30_000,
      workspaceDir: "/tmp/hermes",
      bootstrapPromptWarningSignaturesSeen: [],
      bootstrapPromptWarningSignature: undefined,
    } as unknown as Parameters<typeof harness.runAttempt>[0]);

    expect(result.assistantTexts).toEqual(["hello from hermes"]);
    expect(result.sessionIdUsed).toBe("session-123");
    expect(result.attemptUsage).toEqual({ input: 1, output: 2, total: 3 });
    expect(result.replayMetadata).toEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("only claims the hermes provider by default", () => {
    const harness = createHermesAgentHarness();

    expect(
      harness.supports({ provider: "hermes", modelId: "default", requestedRuntime: "auto" }),
    ).toEqual({
      supported: true,
      priority: 100,
    });
    expect(
      harness.supports({ provider: "openai", modelId: "gpt-5.4", requestedRuntime: "auto" }),
    ).toMatchObject({
      supported: false,
    });
  });
});
