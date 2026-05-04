import { mkdtemp, mkdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/types.js";
import { prepareProjectedExecutionEnv } from "../src/runtime-client.js";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function createWorkspace(name: string, skillNames: string[]): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), `${name}-`));
  await writeFile(join(workspace, "SOUL.md"), `You are ${name}`, "utf8");
  await writeFile(join(workspace, "USER.md"), "User is Hao Xingjun", "utf8");
  await writeFile(join(workspace, "AGENTS.md"), `Workspace ${name}`, "utf8");
  for (const skillName of skillNames) {
    await mkdir(join(workspace, "skills", skillName), { recursive: true });
    await writeFile(
      join(workspace, "skills", skillName, "SKILL.md"),
      `# ${skillName}\n\nSkill ${skillName}.`,
      "utf8",
    );
  }
  return workspace;
}

async function main() {
  const workspaceA = await createWorkspace("workspace-a", ["summary-helper", "browser"]);
  const workspaceB = await createWorkspace("workspace-b", ["summary-helper", "draft-helper"]);
  await mkdir(join(workspaceA, "skills", "unsafe-link-skill"), { recursive: true });
  await writeFile(join(workspaceA, "skills", "unsafe-link-skill", "SKILL.md"), "# Unsafe Link Skill\n\nDo not project.", "utf8");
  await symlink("/etc/passwd", join(workspaceA, "skills", "unsafe-link-skill", "passwd-link"));

  const configA = {
    ...DEFAULT_CONFIG,
    hermesDataDir: join(workspaceA, ".hermes-data"),
  };
  const configB = {
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
    task: "Summarize market news",
    taskId: "task-b",
    workspaceDir: workspaceB,
    contextLevel: "L3",
    config: configB,
  });

  assert(
    executionA.sessionBindingHash !== executionB.sessionBindingHash,
    "Session binding hash should change when workspace/skills change",
  );
  assert(
    executionA.exposedSkills.some((skill) => skill.name === "summary-helper"),
    "summary-helper should be exposed",
  );
  assert(
    executionA.exposedSkills.some(
      (skill) => skill.name === "browser" && skill.placement === "host-backed",
    ),
    "browser should be exposed as a host-backed skill",
  );
  assert(
    executionA.exposedSkills.some(
      (skill) => skill.name === "unsafe-link-skill" && skill.placement === "unsupported",
    ),
    "skills containing symlinks should be exposed as unsupported instead of copied",
  );
  const unsafeProjected = await stat(join(executionA.execEnv.hostExecEnvPath, "skills", "unsafe-link-skill"))
    .then(() => true)
    .catch(() => false);
  assert(!unsafeProjected, "unsafe symlink skill should not be copied into execenv");
  assert(
    executionA.bootstrapPrompt.includes("**browser**") &&
      executionA.bootstrapPrompt.includes("browser"),
    "bootstrap prompt should advertise browser through the host-backed MCP contract",
  );

  console.log("projection test: ok");
  console.log(
    JSON.stringify(
      {
        workspaceAHash: executionA.sessionBindingHash,
        workspaceBHash: executionB.sessionBindingHash,
        exposedSkillsA: executionA.exposedSkills.map((skill) => skill.name),
        exposedSkillsB: executionB.exposedSkills.map((skill) => skill.name),
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
