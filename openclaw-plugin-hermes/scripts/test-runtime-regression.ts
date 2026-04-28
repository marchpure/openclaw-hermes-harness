import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type HermesPluginConfig } from "../src/types.js";
import { HermesAcpClient } from "../src/acp-client.js";
import {
  clearSessionBinding,
  prepareProjectedExecutionEnv,
  readSessionBinding,
  writeSessionBinding,
} from "../src/runtime-client.js";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function createWorkspace(params: {
  prefix: string;
  soul: string;
  user: string;
  agents: string;
  skills: Array<{ name: string; body: string }>;
}): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), `${params.prefix}-`));
  await writeFile(join(workspace, "SOUL.md"), params.soul, "utf8");
  await writeFile(join(workspace, "USER.md"), params.user, "utf8");
  await writeFile(join(workspace, "AGENTS.md"), params.agents, "utf8");
  for (const skill of params.skills) {
    await mkdir(join(workspace, "skills", skill.name), { recursive: true });
    await writeFile(join(workspace, "skills", skill.name, "SKILL.md"), skill.body, "utf8");
  }
  return workspace;
}

async function testWorkspaceIsolation() {
  const workspaceA = await createWorkspace({
    prefix: "hermes-rt-a",
    soul: "You are a finance assistant.",
    user: "User is Hao Xingjun.",
    agents: "Prefer terse market summaries.",
    skills: [
      { name: "summary-helper", body: "# Summary Helper\n\nSummarize in 3 lines." },
      { name: "browser", body: "# Browser\n\nSearch the web." },
    ],
  });
  const workspaceB = await createWorkspace({
    prefix: "hermes-rt-b",
    soul: "You are a code assistant.",
    user: "User is Hao Xingjun.",
    agents: "Prefer technical debugging output.",
    skills: [
      { name: "debug-helper", body: "# Debug Helper\n\nList root causes first." },
      { name: "browser", body: "# Browser\n\nSearch the web." },
    ],
  });

  const configA: HermesPluginConfig = {
    ...DEFAULT_CONFIG,
    hermesDataDir: join(workspaceA, ".hermes-data"),
  };
  const configB: HermesPluginConfig = {
    ...DEFAULT_CONFIG,
    hermesDataDir: join(workspaceB, ".hermes-data"),
  };

  const executionA = await prepareProjectedExecutionEnv({
    task: "Summarize market news",
    taskId: "task-a",
    workspaceDir: workspaceA,
    contextLevel: "L3",
    config: configA,
  });
  const executionB = await prepareProjectedExecutionEnv({
    task: "Debug a failing service",
    taskId: "task-b",
    workspaceDir: workspaceB,
    contextLevel: "L3",
    config: configB,
  });

  assert(
    executionA.sessionBindingHash !== executionB.sessionBindingHash,
    "binding hash should differ across workspaces",
  );
  assert(
    executionA.bootstrapPrompt.includes("finance assistant"),
    "workspace A prompt should include finance identity",
  );
  assert(
    executionB.bootstrapPrompt.includes("code assistant"),
    "workspace B prompt should include code identity",
  );
  assert(
    executionA.exposedSkills.some((skill) => skill.name === "browser" && skill.placement === "host-backed") &&
      executionB.exposedSkills.some((skill) => skill.name === "browser" && skill.placement === "host-backed"),
    "browser should be exposed as a host-backed skill in both workspaces",
  );
  assert(
    executionA.bootstrapPrompt.includes("**browser**") &&
      executionA.bootstrapPrompt.includes("openclaw.skill.invoke"),
    "browser should be advertised through the host-backed MCP contract",
  );

  const soulA = await readFile(join(executionA.execEnv.hostExecEnvPath, "SOUL.md"), "utf8");
  const soulB = await readFile(join(executionB.execEnv.hostExecEnvPath, "SOUL.md"), "utf8");
  assert(soulA.includes("finance assistant"), "execenv A should materialize finance SOUL");
  assert(soulB.includes("code assistant"), "execenv B should materialize code SOUL");

  return {
    workspaceAHash: executionA.sessionBindingHash,
    workspaceBHash: executionB.sessionBindingHash,
    exposedA: executionA.exposedSkills.map((skill) => skill.name),
    exposedB: executionB.exposedSkills.map((skill) => skill.name),
  };
}

async function testSessionBindingLifecycle() {
  const workspace = await createWorkspace({
    prefix: "hermes-rt-binding",
    soul: "You are a research assistant.",
    user: "User is Hao Xingjun.",
    agents: "Prefer concise, factual output.",
    skills: [{ name: "summary-helper", body: "# Summary Helper\n\nSummarize in 3 lines." }],
  });
  const config: HermesPluginConfig = {
    ...DEFAULT_CONFIG,
    hermesDataDir: join(workspace, ".hermes-data"),
  };

  const execution = await prepareProjectedExecutionEnv({
    task: "Summarize a report",
    taskId: "task-binding",
    workspaceDir: workspace,
    contextLevel: "L3",
    config,
  });

  writeSessionBinding(execution.sessionBindingHash, {
    sessionId: "session-1",
    runtimeExecEnvPath: execution.execEnv.runtimeExecEnvPath,
    bindingHash: execution.sessionBindingHash,
  });
  const bound = readSessionBinding(execution.sessionBindingHash);
  assert(bound?.sessionId === "session-1", "session binding should be readable after write");

  clearSessionBinding(execution.sessionBindingHash);
  const cleared = readSessionBinding(execution.sessionBindingHash);
  assert(!cleared, "session binding should clear");

  return {
    bindingHash: execution.sessionBindingHash,
    runtimeExecEnvPath: execution.execEnv.runtimeExecEnvPath,
  };
}

async function testStrictProjection() {
  const workspace = await createWorkspace({
    prefix: "hermes-rt-strict",
    soul: "You are an operations assistant.",
    user: "User is Hao Xingjun.",
    agents: "Prefer step-by-step operational output.",
    skills: [
      { name: "browser", body: "# Browser\n\nSearch the web." },
      { name: "feishu", body: "# Feishu\n\nAccess Lark docs." },
      { name: "ops-helper", body: "# Ops Helper\n\nList checks in order." },
    ],
  });
  const config: HermesPluginConfig = {
    ...DEFAULT_CONFIG,
    hermesDataDir: join(workspace, ".hermes-data"),
  };

  const execution = await prepareProjectedExecutionEnv({
    task: "Check production status",
    taskId: "task-strict",
    workspaceDir: workspace,
    contextLevel: "L3",
    config,
  });

  assert(
    execution.exposedSkills.some((skill) => skill.name === "ops-helper" && skill.placement === "projected-local"),
    "strict projection should expose ops-helper as a projected-local skill",
  );
  assert(
    execution.exposedSkills.some((skill) => skill.name === "browser" && skill.placement === "host-backed") &&
      execution.exposedSkills.some((skill) => skill.name === "feishu" && skill.placement === "host-backed"),
    "strict projection should keep host-backed skills as MCP-backed metadata",
  );
  assert(
    !execution.exposedSkills.some((skill) => skill.name === "browser" && skill.projectedPath) &&
      !execution.exposedSkills.some((skill) => skill.name === "feishu" && skill.projectedPath),
    "host-backed skills should not be copied as local skill files",
  );

  return {
    exposed: execution.exposedSkills.map((skill) => skill.name),
    prompt: execution.bootstrapPrompt,
  };
}

async function testAcpResumeRoundTrip() {
  const workspace = await createWorkspace({
    prefix: "hermes-rt-resume",
    soul: "You are a resume assistant.",
    user: "User is Hao Xingjun.",
    agents: "Be concise.",
    skills: [{ name: "summary-helper", body: "# Summary Helper\n\nSummarize in 3 lines." }],
  });
  const config: HermesPluginConfig = {
    ...DEFAULT_CONFIG,
    hermesDataDir: join(workspace, ".hermes-data"),
    transport: "tcp",
    tcpHost: "127.0.0.1",
    tcpPort: 3100,
    timeout: 60,
  };

  const execution = await prepareProjectedExecutionEnv({
    task: "Introduce yourself briefly.",
    taskId: "task-resume",
    workspaceDir: workspace,
    contextLevel: "L3",
    config,
  });

  const client = new HermesAcpClient(config);
  try {
    await client.start();
    const sessionId = await client.newSession({ cwd: execution.execEnv.runtimeExecEnvPath });
    const resumed = await client.resumeSession(sessionId, {
      cwd: execution.execEnv.runtimeExecEnvPath,
    });
    assert(resumed === sessionId, "resume should keep the same session id when ACP supports it");
    return { sessionId, resumed };
  } finally {
    await client.close().catch(() => {});
  }
}

async function main() {
  const results = {
    isolation: await testWorkspaceIsolation(),
    binding: await testSessionBindingLifecycle(),
    strictProjection: await testStrictProjection(),
    resume: await testAcpResumeRoundTrip(),
  };

  console.log("runtime regression test: ok");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
