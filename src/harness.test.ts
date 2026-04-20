import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHermesAgentHarness } from "./harness.js";
import {
  buildHermesHarnessBootstrapHash,
  buildHermesHarnessPromptBlocks,
} from "./runtime-client.js";

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

  it("declares compaction unsupported instead of silently inheriting PI semantics", async () => {
    const harness = createHermesAgentHarness();

    const result = await harness.compact?.({
      sessionId: "session-123",
      sessionFile: "/tmp/hermes/session.json",
      workspaceDir: "/tmp/hermes",
    } as unknown as Parameters<NonNullable<typeof harness.compact>>[0]);

    expect(result).toMatchObject({
      ok: false,
      compacted: false,
    });
    expect(result?.reason).toContain("does not expose");
  });

  it("builds harness prompt blocks from prepared OpenClaw attempt context", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "hermes-harness-"));
    try {
      await writeFile(join(workspaceDir, "SOUL.md"), "I am the researcher workspace identity.", "utf8");
      await writeFile(join(workspaceDir, "AGENTS.md"), "Preserve the researcher runtime identity.", "utf8");

      const blocks = await buildHermesHarnessPromptBlocks({
        provider: "hermes",
        modelId: "default",
        prompt: "do the work",
        runId: "run-123",
        sessionId: "session-123",
        sessionFile: "/tmp/hermes/session.json",
        timeoutMs: 30_000,
        workspaceDir,
        agentId: "researcher",
        extraSystemPrompt: "Use the researcher identity.",
        skillsSnapshot: {
          prompt: "- **research**: agent-specific research skill",
          skills: [{ name: "research" }],
        },
        images: [{ mimeType: "image/png", data: "ZmFrZQ==" }],
      } as unknown as Parameters<typeof buildHermesHarnessPromptBlocks>[0]);

      expect(blocks[0]).toMatchObject({ type: "text" });
      expect(String(blocks[0].text)).toContain("agentId: researcher");
      expect(String(blocks[0].text)).toContain("I am the researcher workspace identity.");
      expect(String(blocks[0].text)).toContain("Preserve the researcher runtime identity.");
      expect(String(blocks[0].text)).toContain("Use the researcher identity.");
      expect(String(blocks[0].text)).toContain("- research");
      expect(String(blocks[0].text)).toContain("Available OpenClaw Skills");
      expect(String(blocks[0].text)).toContain("Do not enumerate Hermes image/container built-in skills");
      expect(String(blocks[0].text)).toContain("do the work");
      expect(String(blocks[0].text)).not.toContain("Context Level");
      expect(blocks[1]).toMatchObject({
        type: "image",
        mimeType: "image/png",
        data: "ZmFrZQ==",
      });
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("keeps the bootstrap session hash stable across user prompts and images", async () => {
    const base = {
      provider: "hermes",
      modelId: "default",
      prompt: "compare this image",
      runId: "run-123",
      sessionId: "session-123",
      sessionFile: "/tmp/hermes/session.json",
      timeoutMs: 30_000,
      workspaceDir: "/tmp/hermes",
    } as unknown as Parameters<typeof buildHermesHarnessPromptBlocks>[0];

    const first = {
      ...base,
      prompt: "first prompt",
      images: [{ type: "image", mimeType: "image/png", data: "Zmlyc3Q=" }],
    } as unknown as Parameters<typeof buildHermesHarnessBootstrapHash>[0];
    const second = {
      ...base,
      prompt: "second prompt",
      images: [{ type: "image", mimeType: "image/png", data: "c2Vjb25k" }],
    } as unknown as Parameters<typeof buildHermesHarnessBootstrapHash>[0];

    expect(await buildHermesHarnessBootstrapHash(first)).toBe(await buildHermesHarnessBootstrapHash(second));
  });

  it("changes the bootstrap session hash when exposed OpenClaw skills change", async () => {
    const base = {
      provider: "hermes",
      modelId: "default",
      prompt: "same prompt",
      runId: "run-123",
      sessionId: "session-123",
      sessionFile: "/tmp/hermes/session.json",
      timeoutMs: 30_000,
      workspaceDir: "/tmp/hermes",
      skillsSnapshot: {
        prompt: "- **research**: skill A",
        skills: [{ name: "research" }],
      },
    } as unknown as Parameters<typeof buildHermesHarnessBootstrapHash>[0];
    const changed = {
      ...base,
      skillsSnapshot: {
        prompt: "- **write**: skill B",
        skills: [{ name: "write" }],
      },
    } as unknown as Parameters<typeof buildHermesHarnessBootstrapHash>[0];

    expect(await buildHermesHarnessBootstrapHash(base)).not.toBe(await buildHermesHarnessBootstrapHash(changed));
  });

  it("sanitizes OpenClaw skills prompt for Hermes so SKILL.md paths are not exposed as runtime instructions", async () => {
    const blocks = await buildHermesHarnessPromptBlocks({
      provider: "hermes",
      modelId: "default",
      prompt: "list skills",
      runId: "run-123",
      sessionId: "session-123",
      sessionFile: "/tmp/hermes/session.json",
      timeoutMs: 30_000,
      workspaceDir: "/tmp/hermes",
      skillsSnapshot: {
        prompt: [
          "## Skills (mandatory)",
          "Before replying: scan <available_skills> <description> entries.",
          "- If exactly one skill clearly applies: read its SKILL.md at <location> with `read`, then follow it.",
          "<available_skills>",
          "  <skill>",
          "    <name>web_search</name>",
          "    <description>Search the web</description>",
          "    <location>/opt/data/home/.openclaw/workspace/skills/web_search/SKILL.md</location>",
          "  </skill>",
          "</available_skills>",
        ].join("\n"),
        skills: [{ name: "web_search" }],
      },
    } as unknown as Parameters<typeof buildHermesHarnessPromptBlocks>[0]);

    const text = String(blocks[0]?.text);
    expect(text).toContain("Available OpenClaw Skills");
    expect(text).toContain("- web_search");
    expect(text).not.toContain("read its SKILL.md");
    expect(text).not.toContain("<location>");
    expect(text).not.toContain("SKILL.md");
  });
});
