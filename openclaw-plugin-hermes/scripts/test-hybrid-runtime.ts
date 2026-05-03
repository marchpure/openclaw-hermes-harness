import { createServer, type Socket } from "node:net";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HermesAcpClient } from "../src/acp-client.js";
import { DEFAULT_CONFIG, type HermesPluginConfig } from "../src/types.js";
import { prepareProjectedExecutionEnv } from "../src/runtime-client.js";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function createWorkspace(): Promise<{
  workspace: string;
  projectedSkillPath: string;
  hiddenSkillPath: string;
}> {
  const workspace = await mkdtemp(join(tmpdir(), "hermes-hybrid-runtime-"));
  await writeFile(join(workspace, "SOUL.md"), "You are a hybrid runtime test agent.", "utf8");
  await writeFile(join(workspace, "USER.md"), "The user cares about skill routing.", "utf8");
  await writeFile(join(workspace, "AGENTS.md"), "Keep host-backed tools on the host.", "utf8");

  const projectedSkillDir = join(workspace, "snapshot-skills", "projected-helper");
  await mkdir(join(projectedSkillDir, "references"), { recursive: true });
  await writeFile(join(projectedSkillDir, "SKILL.md"), "# Projected Helper\n\nUse the reference.", "utf8");
  await writeFile(join(projectedSkillDir, "references", "details.md"), "details", "utf8");

  const hiddenSkillDir = join(workspace, "skills", "hidden-workspace-skill");
  await mkdir(hiddenSkillDir, { recursive: true });
  await writeFile(join(hiddenSkillDir, "SKILL.md"), "# Hidden\n\nShould not appear.", "utf8");

  return {
    workspace,
    projectedSkillPath: join(projectedSkillDir, "SKILL.md"),
    hiddenSkillPath: join(hiddenSkillDir, "SKILL.md"),
  };
}

async function testSnapshotProjection(): Promise<Record<string, unknown>> {
  const { workspace, projectedSkillPath } = await createWorkspace();
  const config: HermesPluginConfig = {
    ...DEFAULT_CONFIG,
    hermesDataDir: join(workspace, ".hermes-data"),
    mirrorExecEnvToContainer: false,
  };
  const execution = await prepareProjectedExecutionEnv({
    task: "Use a skill and write a Lark doc.",
    taskId: "hybrid-snapshot",
    workspaceDir: workspace,
    contextLevel: "L3",
    includeWorkspaceSkills: true,
    config,
    openClawContext: {
      agentId: "main",
      skillsSnapshot: {
        prompt: "<available_skills><skill><name>projected-helper</name></skill></available_skills>",
        version: 7,
        resolvedSkills: [
          {
            name: "projected-helper",
            description: "Projected local skill",
            filePath: projectedSkillPath,
          },
          {
            name: "lark-doc",
            description: "Create Lark documents",
            path: "/host/lark-doc/SKILL.md",
          },
        ],
      },
    },
  });

  const names = execution.exposedSkills.map((skill) => `${skill.name}:${skill.placement}`).sort();
  assert(names.includes("projected-helper:projected-local"), "projected skill should be local");
  assert(names.includes("lark-doc:host-backed"), "lark-doc should be host-backed");
  assert(
    !execution.bootstrapPrompt.includes("hidden-workspace-skill"),
    "snapshot should prevent fallback workspace skill exposure",
  );
  assert(
    execution.bootstrapPrompt.includes("openclaw.skill.invoke"),
    "host-backed skill contract should mention MCP invocation",
  );
  assert(
    execution.bootstrapPrompt.includes("Runtime file:"),
    "projected skill prompt should include runtime file path",
  );

  const projectedReference = await readFile(
    join(execution.execEnv.hostExecEnvPath, "skills", "projected-helper", "references", "details.md"),
    "utf8",
  );
  assert(projectedReference === "details", "projected skill directory should include references");

  const manifest = JSON.parse(await readFile(execution.execEnv.manifestPath, "utf8")) as {
    openClaw?: { skillsSnapshotVersion?: number; skillsSource?: string };
    skills?: Array<{ name: string; placement: string }>;
  };
  assert(manifest.openClaw?.skillsSnapshotVersion === 7, "manifest should include snapshot version");
  assert(manifest.openClaw?.skillsSource === "snapshot", "manifest should record snapshot source");
  assert(
    manifest.skills?.some((skill) => skill.name === "lark-doc" && skill.placement === "host-backed"),
    "manifest should include host-backed skill metadata",
  );

  return {
    promptIncludesMcpTool: execution.bootstrapPrompt.includes("openclaw.skill.invoke"),
    exposedSkills: names,
    manifestOpenClaw: manifest.openClaw,
  };
}

async function withMockAcpServer<T>(fn: (port: number, requests: Array<Record<string, unknown>>) => Promise<T>): Promise<T> {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((socket: Socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const request = JSON.parse(line) as Record<string, unknown>;
        requests.push(request);
        const id = request.id;
        const method = request.method;
        const result =
          method === "initialize"
            ? { protocol_version: 1 }
            : method === "session/new"
              ? { session_id: "mock-session" }
              : method === "session/resume"
                ? { session_id: "mock-session" }
                : {};
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock ACP server did not expose a TCP port");
  }
  try {
    return await fn(address.port, requests);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testAcpSessionOptions(): Promise<Record<string, unknown>> {
  return await withMockAcpServer(async (port, requests) => {
    const config: HermesPluginConfig = {
      ...DEFAULT_CONFIG,
      tcpPort: port,
      timeout: 5,
    };
    const client = new HermesAcpClient(config);
    await client.start();
    const sessionId = await client.newSession({
      cwd: "/runtime/execenv/session-a",
      mcpServers: {
        openclaw: { url: "http://127.0.0.1:18789/mcp" },
      },
      env: {
        OPENCLAW_MCP_TOKEN: "secret-token",
        OPENCLAW_MCP_SESSION_KEY: "session-a",
      },
    });
    await client.resumeSession(sessionId, {
      cwd: "/runtime/execenv/session-a",
      mcpServers: {
        openclaw: { url: "http://127.0.0.1:18789/mcp" },
      },
      env: {
        OPENCLAW_MCP_TOKEN: "secret-token-2",
        OPENCLAW_MCP_SESSION_KEY: "session-a",
      },
    });
    await client.close();

    const newSessionRequest = requests.find((request) => request.method === "session/new") as {
      params?: Record<string, unknown>;
    };
    const resumeRequest = requests.find((request) => request.method === "session/resume") as {
      params?: Record<string, unknown>;
    };
    assert(newSessionRequest?.params?.cwd === "/runtime/execenv/session-a", "newSession should send cwd");
    assert(Array.isArray(newSessionRequest?.params?.mcpServers), "newSession should send ACP mcpServers array");
    assert(Boolean(newSessionRequest?.params?.env), "newSession should send env");
    assert(Array.isArray(resumeRequest?.params?.mcpServers), "resumeSession should send ACP mcpServers array");
    assert(Boolean(resumeRequest?.params?.env), "resumeSession should send fresh env");

    const acpMcpServers = newSessionRequest.params?.mcpServers as Array<Record<string, unknown>>;
    assert(acpMcpServers[0]?.name === "openclaw", "mcp server should include name");
    assert(acpMcpServers[0]?.type === "http", "url mcp server should default to http");
    assert(acpMcpServers[0]?.url === "http://127.0.0.1:18789/mcp", "mcp server should include url");

    return {
      requestMethods: requests.map((request) => request.method),
      newSessionParams: newSessionRequest.params,
      resumeParams: resumeRequest.params,
    };
  });
}

async function main() {
  const projection = await testSnapshotProjection();
  const acp = await testAcpSessionOptions();
  console.log(JSON.stringify({ ok: true, projection, acp }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
