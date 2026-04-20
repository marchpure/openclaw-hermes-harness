import { describe, expect, it, vi } from "vitest";
import { createHermesAgentHarness } from "./harness.js";

function createAttemptParams() {
  return {
    sessionId: "session-1",
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp/workspace",
    provider: "hermes",
    modelId: "default",
    prompt: "hello",
    runId: "run-1",
    timeoutMs: 1000,
    thinkLevel: "medium",
    model: {} as never,
    authStorage: {} as never,
    modelRegistry: {} as never,
  };
}

describe("hermes harness", () => {
  it("maps a Hermes runtime response to an agent harness result", async () => {
    const client = {
      runAttempt: vi.fn(async () => ({
        assistantText: "hello from hermes",
        usage: { input: 1, output: 2, total: 3 },
      })),
    };
    const harness = createHermesAgentHarness({ client });

    const result = await harness.runAttempt(createAttemptParams() as never);

    expect(client.runAttempt).toHaveBeenCalledWith(expect.objectContaining({ prompt: "hello" }));
    expect(result).toMatchObject({
      promptError: null,
      sessionIdUsed: "session-1",
      assistantTexts: ["hello from hermes"],
      attemptUsage: { input: 1, output: 2, total: 3 },
      replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
  });
});
