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

  await mkdir(join(hostExecEnvSkillsDir, "invalid-dir"), { recursive: true });
  await writeFile(join(hostExecEnvSkillsDir, "invalid-dir", "README.md"), "missing skill md", "utf8");

  await mirrorWorkspaceFromContainer(config, workspace, [], runtimeExecEnvPath);

  const newSkillPath = join(workspace, "skills", "new-runtime-skill", "SKILL.md");
  const existingSkillPath = join(workspace, "skills", "existing-skill", "SKILL.md");
  const invalidPath = join(workspace, "skills", "invalid-dir");

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
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
