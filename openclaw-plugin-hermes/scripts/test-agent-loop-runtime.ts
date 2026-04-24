import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HermesAcpClient } from "../src/acp-client.js";
import { DEFAULT_CONFIG, type HermesPluginConfig } from "../src/types.js";
import {
  clearSessionBinding,
  prepareProjectedExecutionEnv,
  readSessionBinding,
  writeSessionBinding,
} from "../src/runtime-client.js";
import { mirrorWorkspaceFromContainer } from "../src/execenv-builder.js";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function createWorkspace(prefix: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), `${prefix}-`));
  await writeFile(join(workspace, "SOUL.md"), "You are a Hermes runtime validation agent.", "utf8");
  await writeFile(join(workspace, "USER.md"), "User expects precise validation results.", "utf8");
  await writeFile(join(workspace, "AGENTS.md"), "Prefer concise, factual output.", "utf8");
  await mkdir(join(workspace, "skills", "local-helper"), { recursive: true });
  await writeFile(
    join(workspace, "skills", "local-helper", "SKILL.md"),
    "# Local Helper\n\nUse this helper for local workspace tasks.",
    "utf8",
  );
  return workspace;
}

async function testApiModeAndStreaming(config: HermesPluginConfig) {
  const client = new HermesAcpClient(config);
  const workspace = await createWorkspace("agent-loop-api-mode");
  const events: Array<{ type: string; text?: string; toolName?: string }> = [];

  try {
    await client.start({}, workspace);
    const sessionId = await client.newSession(workspace);
    const result = await client.prompt("请只回复 AGENT_LOOP_STREAM_OK", sessionId, {
      timeout: 45000,
      onEvent: async (event) => {
        events.push({ type: event.type, text: event.text, toolName: event.toolName });
      },
    });

    assert(result.text.includes("AGENT_LOOP_STREAM_OK"), "streaming prompt should return expected marker");
    assert(events.some((event) => event.type === "text"), "streaming should include text events");
    return {
      sessionId,
      textEvents: events.filter((event) => event.type === "text").length,
      thinkingEvents: events.filter((event) => event.type === "thinking").length,
      finalText: result.text,
    };
  } finally {
    await client.close().catch(() => {});
    await rm(workspace, { recursive: true, force: true });
  }
}

async function testSessionLifecycle(config: HermesPluginConfig) {
  const workspace = await createWorkspace("agent-loop-session");
  const execution = await prepareProjectedExecutionEnv({
    task: "Validate session lifecycle.",
    taskId: "agent-loop-session",
    workspaceDir: workspace,
    contextLevel: "L3",
    config,
  });

  const client = new HermesAcpClient(config);
  try {
    await client.start({}, execution.execEnv.runtimeExecEnvPath);
    const created = await client.newSession(execution.execEnv.runtimeExecEnvPath);
    writeSessionBinding(execution.sessionBindingHash, {
      sessionId: created,
      runtimeExecEnvPath: execution.execEnv.runtimeExecEnvPath,
      bindingHash: execution.sessionBindingHash,
    });
    const loaded = await client.loadSession(created, execution.execEnv.runtimeExecEnvPath);
    const resumed = await client.resumeSession(created, execution.execEnv.runtimeExecEnvPath);
    const bound = readSessionBinding(execution.sessionBindingHash);
    assert(bound?.sessionId === created, "session binding should persist created session");
    return { created, loaded, resumed, bindingHash: execution.sessionBindingHash };
  } finally {
    clearSessionBinding(execution.sessionBindingHash);
    await client.close().catch(() => {});
    await rm(workspace, { recursive: true, force: true });
  }
}

async function testMemoryProjection(config: HermesPluginConfig) {
  const workspace = await createWorkspace("agent-loop-memory");
  await writeFile(join(workspace, "MEMORY.md"), "# Memory\n\nImportant persistent note.", "utf8");
  await mkdir(join(workspace, "memory"), { recursive: true });
  const today = new Date().toISOString().split("T")[0];
  await writeFile(join(workspace, "memory", `${today}.md`), "## Today\n\nFresh daily note.", "utf8");

  const execution = await prepareProjectedExecutionEnv({
    task: "Validate memory projection.",
    taskId: "agent-loop-memory",
    workspaceDir: workspace,
    contextLevel: "L3",
    config,
  });

  assert(execution.bootstrapPrompt.includes("Important persistent note."), "long-term memory should be projected");
  assert(execution.bootstrapPrompt.includes("Fresh daily note."), "daily memory should be projected");
  assert(execution.bootstrapPrompt.includes("local-helper"), "local helper skill should be visible");

  await rm(workspace, { recursive: true, force: true });
  return {
    hasLongTermMemory: execution.bootstrapPrompt.includes("Important persistent note."),
    hasDailyMemory: execution.bootstrapPrompt.includes("Fresh daily note."),
    exposedSkills: execution.exposedSkills.map((skill) => skill.name),
  };
}

async function testWritebackSync(config: HermesPluginConfig) {
  const workspace = await createWorkspace("agent-loop-writeback");
  const taskId = "agent-loop-writeback";
  const runtimeExecEnvPath = join("/opt/data/execenv", taskId);
  const hostExecEnvSkillsDir = join(config.hermesDataDir!, "execenv", taskId, "skills");

  await mkdir(join(workspace, "skills", "managed-skill"), { recursive: true });
  await writeFile(
    join(workspace, "skills", "managed-skill", "SKILL.md"),
    "---\nopenclaw_managed: true\nopenclaw_skill_origin: autoskill\nopenclaw_created_by: hermes-runtime\nname: managed-skill\ndescription: managed existing\n---\n# Managed Skill\n\nworkspace version\n",
    "utf8",
  );
  await mkdir(join(hostExecEnvSkillsDir, "managed-skill"), { recursive: true });
  await writeFile(
    join(hostExecEnvSkillsDir, "managed-skill", "SKILL.md"),
    "---\nname: managed-skill\ndescription: managed runtime\n---\n# Managed Skill\n\nruntime updated version\n",
    "utf8",
  );
  await mkdir(join(hostExecEnvSkillsDir, "new-runtime-skill"), { recursive: true });
  await writeFile(
    join(hostExecEnvSkillsDir, "new-runtime-skill", "SKILL.md"),
    "---\nname: new-runtime-skill\ndescription: runtime generated\n---\n# New Runtime Skill\n\ncreated by runtime\n",
    "utf8",
  );

  await mirrorWorkspaceFromContainer(
    config,
    workspace,
    [],
    runtimeExecEnvPath,
    ["managed-skill", "new-runtime-skill"],
  );

  const managed = await readFile(join(workspace, "skills", "managed-skill", "SKILL.md"), "utf8");
  const created = await readFile(join(workspace, "skills", "new-runtime-skill", "SKILL.md"), "utf8");
  assert(managed.includes("runtime updated version"), "managed skill should be refreshed from runtime");
  assert(created.includes("created by runtime"), "new runtime skill should sync back");

  await rm(workspace, { recursive: true, force: true });
  return {
    managedUpdated: managed.includes("runtime updated version"),
    newSkillCreated: created.includes("created by runtime"),
  };
}

async function testCancelSurface(config: HermesPluginConfig) {
  const client = new HermesAcpClient(config);
  const workspace = await createWorkspace("agent-loop-cancel");
  try {
    await client.start({}, workspace);
    const sessionId = await client.newSession(workspace);
    await client.cancel(sessionId);
    return { cancelCallable: true, sessionId };
  } finally {
    await client.close().catch(() => {});
    await rm(workspace, { recursive: true, force: true });
  }
}

async function main() {
  const hermesDataRoot = await mkdtemp(join(tmpdir(), "agent-loop-hermes-data-"));
  const config: HermesPluginConfig = {
    ...DEFAULT_CONFIG,
    hermesContainerName: "hermes-agent",
    hermesDataDir: hermesDataRoot,
    timeout: 60,
  };

  const results = {
    apiModeAndStreaming: await testApiModeAndStreaming(config),
    sessionLifecycle: await testSessionLifecycle(config),
    memoryProjection: await testMemoryProjection(config),
    writebackSync: await testWritebackSync(config),
    cancelSurface: await testCancelSurface(config),
  };

  console.log("agent loop runtime test: ok");
  console.log(JSON.stringify(results, null, 2));

  await rm(hermesDataRoot, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
