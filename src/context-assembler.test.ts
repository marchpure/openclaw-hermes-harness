import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { assembleContext, serializeContextForPrompt } from "./context-assembler.js";
import { DEFAULT_CONFIG } from "./types.js";

describe("context assembler", () => {
  it("keeps ordinary L0 stateless but preserves prepared agent context for harness L0", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "hermes-context-"));
    try {
      await writeFile(join(workspaceDir, "SOUL.md"), "I am the workspace agent.", "utf8");

      const ordinary = await assembleContext("hello", "L0", {
        workspaceDir,
        config: DEFAULT_CONFIG,
      });
      expect(serializeContextForPrompt(ordinary)).not.toContain("I am the workspace agent.");

      const harness = await assembleContext("hello", "L0", {
        workspaceDir,
        config: DEFAULT_CONFIG,
        openClawContext: {
          agentId: "researcher",
          skillsSnapshot: {
            prompt: "- **research**: use the agent-specific research skill",
            skills: [{ name: "research" }],
          },
        },
      });

      const prompt = serializeContextForPrompt(harness);
      expect(prompt).toContain("agentId: researcher");
      expect(prompt).toContain("I am the workspace agent.");
      expect(prompt).toContain("agent-specific research skill");
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
