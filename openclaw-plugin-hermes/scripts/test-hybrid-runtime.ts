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
          {
            name: "feishu-fetch-doc",
            description: "Fetch Feishu documents",
            path: "/host/feishu-fetch-doc/SKILL.md",
          },
        ],
      },
    },
  });

  const names = execution.exposedSkills.map((skill) => `${skill.name}:${skill.placement}`).sort();
  assert(names.includes("projected-helper:projected-local"), "projected skill should be local");
  assert(names.includes("lark-doc:host-backed"), "lark-doc should be host-backed");
  assert(names.includes("feishu-fetch-doc:host-backed"), "feishu-fetch-doc should be host-backed");
  assert(
    !execution.bootstrapPrompt.includes("hidden-workspace-skill"),
    "snapshot should prevent fallback workspace skill exposure",
  );
  assert(
    execution.bootstrapPrompt.includes("browser"),
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
  assert(
    manifest.skills?.some((skill) => skill.name === "feishu-fetch-doc" && skill.placement === "host-backed"),
    "manifest should include Feishu host-backed skill metadata",
  );

  return {
    promptIncludesBrowserTool: execution.bootstrapPrompt.includes("browser"),
    exposedSkills: names,
    manifestOpenClaw: manifest.openClaw,
  };
}

async function withMockAcpServer<T>(
  fn: (port: number, requests: Array<Record<string, unknown>>) => Promise<T>,
  options?: {
    closeOnInitialize?: boolean;
    closeAfterInitializeResponse?: boolean;
    omitPromptResponse?: boolean;
  },
): Promise<T> {
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
        if (method === "initialize" && options?.closeOnInitialize) {
          socket.end();
          continue;
        }
        const result =
          method === "initialize"
            ? { protocol_version: 1 }
            : method === "session/new"
              ? { session_id: "mock-session" }
              : method === "session/resume"
                ? { session_id: "mock-session" }
                : {};
        if (method === "initialize" && options?.closeAfterInitializeResponse) {
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`, () => {
            socket.end();
          });
          continue;
        }
        if (method === "session/prompt" && options?.omitPromptResponse) {
          socket.write(`${JSON.stringify({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionUpdate: "agent_message_text",
              text: "streamed without terminal response",
            },
          })}\n`);
          continue;
        }
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
        openclaw: {
          url: "http://127.0.0.1:18789/mcp",
          _meta: { openclaw: { timeout: 600, connectTimeout: 60 } },
        },
      },
      env: {
        OPENCLAW_MCP_TOKEN: "secret-token",
        OPENCLAW_MCP_SESSION_KEY: "session-a",
      },
    });
    await client.resumeSession(sessionId, {
      cwd: "/runtime/execenv/session-a",
      mcpServers: {
        openclaw: {
          url: "http://127.0.0.1:18789/mcp",
          _meta: { openclaw: { timeout: 600, connectTimeout: 60 } },
        },
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
    assert(
      (acpMcpServers[0]?._meta as Record<string, unknown> | undefined)?.openclaw,
      "mcp server should preserve ACP _meta for runtime-specific options",
    );

    return {
      requestMethods: requests.map((request) => request.method),
      newSessionParams: newSessionRequest.params,
      resumeParams: resumeRequest.params,
    };
  });
}

async function testAcpPromptIdleFinalize(): Promise<Record<string, unknown>> {
  return await withMockAcpServer(async (port, requests) => {
    const config: HermesPluginConfig = {
      ...DEFAULT_CONFIG,
      tcpPort: port,
      timeout: 10,
    };
    const client = new HermesAcpClient(config);
    await client.start();
    const sessionId = await client.newSession({ cwd: "/runtime/execenv/session-idle" });
    const started = Date.now();
    const result = await client.prompt("stream without final JSON-RPC response", sessionId, {
      timeout: 30_000,
    });
    await client.close();

    assert(result.text === "streamed without terminal response", "idle finalize should return accumulated stream text");
    assert(Date.now() - started < 10_000, "idle finalize should not wait for the long prompt timeout");
    assert(
      requests.some((request) => request.method === "session/prompt"),
      "mock server should receive session/prompt",
    );
    return {
      text: result.text,
      requestMethods: requests.map((request) => request.method),
    };
  }, { omitPromptResponse: true });
}

async function testAcpPromptPreAbortedSignal(): Promise<Record<string, unknown>> {
  return await withMockAcpServer(async (port, requests) => {
    const config: HermesPluginConfig = {
      ...DEFAULT_CONFIG,
      tcpPort: port,
      timeout: 10,
    };
    const client = new HermesAcpClient(config);
    await client.start();
    const sessionId = await client.newSession({ cwd: "/runtime/execenv/session-aborted" });
    const controller = new AbortController();
    controller.abort();

    let rejectedMessage = "";
    try {
      await client.prompt("should not be sent", sessionId, { signal: controller.signal });
    } catch (err) {
      rejectedMessage = err instanceof Error ? err.message : String(err);
    }
    await client.close();

    assert(rejectedMessage === "Prompt aborted", "pre-aborted prompt should reject immediately");
    assert(
      !requests.some((request) => request.method === "session/prompt"),
      "pre-aborted prompt should not send session/prompt",
    );

    return {
      rejectedMessage,
      requestMethods: requests.map((request) => request.method),
    };
  });
}

async function testAcpInitializeDisconnect(): Promise<Record<string, unknown>> {
  return await withMockAcpServer(async (port, requests) => {
    const config: HermesPluginConfig = {
      ...DEFAULT_CONFIG,
      tcpPort: port,
      timeout: 10,
    };
    const client = new HermesAcpClient(config);

    let rejectedMessage = "";
    try {
      await client.start();
    } catch (err) {
      rejectedMessage = err instanceof Error ? err.message : String(err);
    }
    await client.close();

    assert(rejectedMessage === "TCP connection closed", "initialize disconnect should reject pending initialize");
    assert(client.isConnected === false, "client should remain disconnected after initialize failure");
    assert(
      requests.some((request) => request.method === "initialize"),
      "mock server should receive initialize before closing",
    );

    return {
      rejectedMessage,
      requestMethods: requests.map((request) => request.method),
      connected: client.isConnected,
    };
  }, { closeOnInitialize: true });
}

async function testAcpInitializeResponseThenDisconnect(): Promise<Record<string, unknown>> {
  return await withMockAcpServer(async (port, requests) => {
    const config: HermesPluginConfig = {
      ...DEFAULT_CONFIG,
      tcpPort: port,
      timeout: 10,
    };
    const client = new HermesAcpClient(config);

    let rejectedMessage = "";
    try {
      await client.start();
    } catch (err) {
      rejectedMessage = err instanceof Error ? err.message : String(err);
    }
    await client.close();

    assert(
      rejectedMessage === "TCP connection closed during ACP initialize",
      "initialize response followed by disconnect should not mark client connected",
    );
    assert(client.isConnected === false, "client should remain disconnected after post-initialize close");
    assert(
      requests.some((request) => request.method === "initialize"),
      "mock server should receive initialize before closing",
    );

    return {
      rejectedMessage,
      requestMethods: requests.map((request) => request.method),
      connected: client.isConnected,
    };
  }, { closeAfterInitializeResponse: true });
}

async function main() {
  const projection = await testSnapshotProjection();
  const acp = await testAcpSessionOptions();
  const idleFinalize = await testAcpPromptIdleFinalize();
  const preAborted = await testAcpPromptPreAbortedSignal();
  const initializeDisconnect = await testAcpInitializeDisconnect();
  const initializeResponseThenDisconnect = await testAcpInitializeResponseThenDisconnect();
  console.log(JSON.stringify({
    ok: true,
    projection,
    acp,
    idleFinalize,
    preAborted,
    initializeDisconnect,
    initializeResponseThenDisconnect,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
