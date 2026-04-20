import { describe, expect, it, vi } from "vitest";
import { executeHermesHostTool } from "./host-tool-bridge.js";

describe("host tool bridge", () => {
  it("rejects unsupported host tools", async () => {
    await expect(executeHermesHostTool("lark.docs.update", {})).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_tool" },
    });
  });

  it("validates lark docs search query length", async () => {
    await expect(
      executeHermesHostTool("lark.docs.search", {
        query: "x".repeat(51),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
    });
  });

  it("executes lark docs search through lark-cli as user", async () => {
    const execFile = vi.fn(async () => ({
      stdout: JSON.stringify({ ok: true, data: { items: [{ title: "Hermes" }] } }),
      stderr: "",
    }));

    const result = await executeHermesHostTool(
      "lark.docs.search",
      { query: "Hermes Agent OpenClaw" },
      { execFile },
    );

    expect(execFile).toHaveBeenCalledWith(
      "lark-cli",
      ["docs", "+search", "--query", "Hermes Agent OpenClaw", "--as", "user", "--format", "json"],
      expect.objectContaining({ timeout: 30_000 }),
    );
    expect(result).toMatchObject({
      ok: true,
      tool: "lark.docs.search",
      contentType: "application/json",
    });
  });

  it("executes lark docs fetch and returns markdown content", async () => {
    const execFile = vi.fn(async () => ({
      stdout: JSON.stringify({ ok: true, data: { markdown: "# Hermes\n\nRuntime notes." } }),
      stderr: "",
    }));

    const result = await executeHermesHostTool(
      "lark.docs.fetch",
      { doc: "https://bytedance.larkoffice.com/docx/example" },
      { execFile },
    );

    expect(execFile).toHaveBeenCalledWith(
      "lark-cli",
      [
        "docs",
        "+fetch",
        "--doc",
        "https://bytedance.larkoffice.com/docx/example",
        "--as",
        "user",
        "--format",
        "json",
      ],
      expect.objectContaining({ timeout: 30_000 }),
    );
    expect(result).toMatchObject({
      ok: true,
      tool: "lark.docs.fetch",
      contentType: "text/markdown",
      content: "# Hermes\n\nRuntime notes.",
    });
  });

  it("maps lark-cli permission errors to structured permission_denied", async () => {
    const execFile = vi.fn(async () => ({
      stdout: JSON.stringify({ ok: false, message: "Permission denied: missing scope docs:doc:readonly" }),
      stderr: "",
    }));

    await expect(
      executeHermesHostTool("lark.docs.fetch", { doc: "doc-token" }, { execFile }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "permission_denied",
      },
    });
  });
});
