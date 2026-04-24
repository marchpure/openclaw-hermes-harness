import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mirrorWorkspaceFromContainer } from "../src/execenv-builder.js";
import { DEFAULT_CONFIG, type HermesPluginConfig } from "../src/types.js";

function ok(msg: string) {
  console.log(`OK  ${msg}`);
}

function fail(msg: string): never {
  throw new Error(msg);
}

async function mustRead(path: string): Promise<string> {
  return readFile(path, "utf8");
}

async function main() {
  const workspace = await mkdtemp(join(tmpdir(), "hermes-skill-writeback-workspace-"));
  const taskId = `skill-writeback-${Date.now()}`;
  const config: HermesPluginConfig = {
    ...DEFAULT_CONFIG,
    hermesDataDir: join(workspace, ".hermes-data"),
  };

  const runtimeExecEnvPath = join("/opt/data/execenv", taskId);
  const hostExecEnvSkillsDir = join(config.hermesDataDir!, "execenv", taskId, "skills");

  await mkdir(join(workspace, "skills", "existing-skill"), { recursive: true });
  await writeFile(
    join(workspace, "skills", "existing-skill", "SKILL.md"),
    "---\nname: existing-skill\ndescription: workspace copy\n---\n# Existing\n\nworkspace version\n",
    "utf8",
  );

  await mkdir(join(hostExecEnvSkillsDir, "existing-skill"), { recursive: true });
  await writeFile(
    join(hostExecEnvSkillsDir, "existing-skill", "SKILL.md"),
    "---\nname: existing-skill\ndescription: runtime copy\n---\n# Existing\n\nruntime updated version\n",
    "utf8",
  );

  await mkdir(join(hostExecEnvSkillsDir, "new-runtime-skill"), { recursive: true });
  await writeFile(
    join(hostExecEnvSkillsDir, "new-runtime-skill", "SKILL.md"),
    "---\nname: new-runtime-skill\ndescription: runtime generated\n---\n# New Runtime Skill\n\ncreated inside runtime execenv\n",
    "utf8",
  );
  await mkdir(join(hostExecEnvSkillsDir, "unrelated-runtime-skill"), { recursive: true });
  await writeFile(
    join(hostExecEnvSkillsDir, "unrelated-runtime-skill", "SKILL.md"),
    "---\nname: unrelated-runtime-skill\ndescription: should stay isolated\n---\n# Unrelated Runtime Skill\n\nmust not be copied\n",
    "utf8",
  );

  await mkdir(join(hostExecEnvSkillsDir, "invalid-dir"), { recursive: true });
  await writeFile(join(hostExecEnvSkillsDir, "invalid-dir", "README.md"), "missing skill md", "utf8");

  await mirrorWorkspaceFromContainer(config, workspace, [], runtimeExecEnvPath, ["existing-skill", "new-runtime-skill"]);

  const newSkillPath = join(workspace, "skills", "new-runtime-skill", "SKILL.md");
  const existingSkillPath = join(workspace, "skills", "existing-skill", "SKILL.md");
  const invalidPath = join(workspace, "skills", "invalid-dir");
  const unrelatedSkillPath = join(workspace, "skills", "unrelated-runtime-skill");

  const newSkill = await mustRead(newSkillPath);
  if (!newSkill.includes("created inside runtime execenv")) {
    fail("new runtime skill was not copied into workspace/skills");
  }
  ok("copies new runtime-generated skill into workspace/skills");

  const existingSkill = await mustRead(existingSkillPath);
  if (!existingSkill.includes("runtime updated version")) {
    fail("existing workspace skill was not refreshed from runtime execenv");
  }
  ok("refreshes existing workspace skill from runtime execenv");

  try {
    await stat(invalidPath);
    fail("invalid runtime directory without SKILL.md should not be mirrored");
  } catch {
    ok("ignores runtime directories without SKILL.md");
  }

  try {
    await stat(unrelatedSkillPath);
    fail("unrelated runtime skill should not be mirrored into workspace");
  } catch {
    ok("does not mirror unrelated runtime skills");
  }

  const hostGlobalSkillDir = join(config.hermesDataDir!, "skills", "productivity", "global-runtime-skill");
  await mkdir(hostGlobalSkillDir, { recursive: true });
  await writeFile(
    join(hostGlobalSkillDir, "SKILL.md"),
    "---\nname: global-runtime-skill\ndescription: stored in hermes global skills\n---\n# Global Runtime Skill\n\ncreated inside /opt/data/skills\n",
    "utf8",
  );
  const unrelatedGlobalSkillDir = join(config.hermesDataDir!, "skills", "productivity", "unrelated-global-skill");
  await mkdir(unrelatedGlobalSkillDir, { recursive: true });
  await writeFile(
    join(unrelatedGlobalSkillDir, "SKILL.md"),
    "---\nname: unrelated-global-skill\ndescription: should stay isolated\n---\n# Unrelated Global Skill\n\nmust not be copied\n",
    "utf8",
  );

  await mirrorWorkspaceFromContainer(config, workspace, [], runtimeExecEnvPath, ["global-runtime-skill"]);

  const globalSkillPath = join(workspace, "skills", "global-runtime-skill", "SKILL.md");
  const globalSkill = await mustRead(globalSkillPath);
  if (!globalSkill.includes("created inside /opt/data/skills")) {
    fail("global Hermes skill was not copied into workspace/skills");
  }
  ok("copies only explicitly created Hermes global skills from /opt/data/skills into workspace/skills");

  try {
    await stat(join(workspace, "skills", "unrelated-global-skill"));
    fail("unrelated global Hermes skill should not be mirrored");
  } catch {
    ok("does not mirror unrelated global Hermes skills");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
