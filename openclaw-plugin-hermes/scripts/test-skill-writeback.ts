import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
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

  await mkdir(join(workspace, "skills", "managed-existing-skill"), { recursive: true });
  await writeFile(
    join(workspace, "skills", "managed-existing-skill", "SKILL.md"),
    "---\nopenclaw_managed: true\nopenclaw_skill_origin: autoskill\nopenclaw_created_by: hermes-runtime\nname: managed-existing-skill\ndescription: workspace copy\n---\n# Managed Existing\n\nworkspace version\n",
    "utf8",
  );

  await mkdir(join(hostExecEnvSkillsDir, "existing-skill"), { recursive: true });
  await writeFile(
    join(hostExecEnvSkillsDir, "existing-skill", "SKILL.md"),
    "---\nname: existing-skill\ndescription: runtime copy\n---\n# Existing\n\nruntime updated version\n",
    "utf8",
  );

  await mkdir(join(hostExecEnvSkillsDir, "managed-existing-skill"), { recursive: true });
  await writeFile(
    join(hostExecEnvSkillsDir, "managed-existing-skill", "SKILL.md"),
    "---\nname: managed-existing-skill\ndescription: runtime copy\n---\n# Managed Existing\n\nruntime updated version\n",
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
  await mkdir(join(hostExecEnvSkillsDir, "direct-autoskill"), { recursive: true });
  await writeFile(
    join(hostExecEnvSkillsDir, "direct-autoskill", "SKILL.md"),
    "---\nname: direct-autoskill\ndescription: created by direct runtime file write\n---\n# Direct Autoskill\n\ncreated by direct execenv write\n",
    "utf8",
  );
  await writeFile(
    join(config.hermesDataDir!, "execenv", taskId, "projection.json"),
    JSON.stringify({
      skills: [
        { name: "existing-skill" },
        { name: "managed-existing-skill" },
        { name: "unrelated-runtime-skill" },
      ],
    }),
    "utf8",
  );
  await writeFile(join(config.hermesDataDir!, "execenv", taskId, "SOUL.md"), "runtime soul copy should not overwrite host\n", "utf8");
  await writeFile(join(config.hermesDataDir!, "execenv", taskId, ".runtime-secret"), "hidden runtime file should not copy\n", "utf8");
  await mkdir(join(config.hermesDataDir!, "execenv", taskId, "node_modules"), { recursive: true });
  await writeFile(join(config.hermesDataDir!, "execenv", taskId, "node_modules", "cache.txt"), "cache should not copy\n", "utf8");
  await mkdir(join(hostExecEnvSkillsDir, "..", "hermes-real-regression-fixtures"), { recursive: true });
  await writeFile(
    join(hostExecEnvSkillsDir, "..", "hermes-real-regression-fixtures", "relative-write.txt"),
    "relative runtime writeback\n",
    "utf8",
  );
  await mkdir(join(hostExecEnvSkillsDir, "..", "unsafe-runtime-symlink"), { recursive: true });
  await symlink("/etc/passwd", join(hostExecEnvSkillsDir, "..", "unsafe-runtime-symlink", "passwd-link"));

  await mkdir(join(hostExecEnvSkillsDir, "invalid-dir"), { recursive: true });
  await writeFile(join(hostExecEnvSkillsDir, "invalid-dir", "README.md"), "missing skill md", "utf8");
  await mkdir(join(hostExecEnvSkillsDir, ".hidden-skill"), { recursive: true });
  await writeFile(join(hostExecEnvSkillsDir, ".hidden-skill", "SKILL.md"), "# Hidden Skill\n\nmust not copy\n", "utf8");
  await mkdir(join(hostExecEnvSkillsDir, "unsafe-symlink-skill"), { recursive: true });
  await writeFile(join(hostExecEnvSkillsDir, "unsafe-symlink-skill", "SKILL.md"), "# Unsafe Symlink Skill\n\nmust not copy\n", "utf8");
  await symlink("/etc/passwd", join(hostExecEnvSkillsDir, "unsafe-symlink-skill", "passwd-link"));

  await mirrorWorkspaceFromContainer(
    config,
    workspace,
    [],
    runtimeExecEnvPath,
    ["existing-skill", "managed-existing-skill", "new-runtime-skill"],
  );

  const newSkillPath = join(workspace, "skills", "new-runtime-skill", "SKILL.md");
  const existingSkillPath = join(workspace, "skills", "existing-skill", "SKILL.md");
  const managedExistingSkillPath = join(workspace, "skills", "managed-existing-skill", "SKILL.md");
  const invalidPath = join(workspace, "skills", "invalid-dir");
  const unrelatedSkillPath = join(workspace, "skills", "unrelated-runtime-skill");
  const directAutoskillPath = join(workspace, "skills", "direct-autoskill", "SKILL.md");

  const newSkill = await mustRead(newSkillPath);
  if (!newSkill.includes("created inside runtime execenv")) {
    fail("new runtime skill was not copied into workspace/skills");
  }
  ok("copies new runtime-generated skill into workspace/skills");

  const relativeWriteback = await mustRead(join(workspace, "hermes-real-regression-fixtures", "relative-write.txt"));
  if (!relativeWriteback.includes("relative runtime writeback")) {
    fail("runtime relative file write was not copied back into workspace");
  }
  ok("copies runtime relative file writes back into workspace");

  try {
    await stat(join(workspace, "projection.json"));
    fail("runtime projection metadata should not be copied into workspace");
  } catch {
    ok("does not copy runtime projection metadata into workspace");
  }

  try {
    await stat(join(workspace, ".runtime-secret"));
    fail("hidden runtime files should not be copied into workspace");
  } catch {
    ok("does not copy hidden runtime root files into workspace");
  }

  try {
    await stat(join(workspace, "node_modules"));
    fail("runtime node_modules should not be copied into workspace");
  } catch {
    ok("does not copy runtime dependency caches into workspace");
  }

  try {
    await stat(join(workspace, "unsafe-runtime-symlink"));
    fail("runtime file writeback containing symlinks should not be copied into workspace");
  } catch {
    ok("does not copy runtime root entries containing symlinks into workspace");
  }

  const existingSkill = await mustRead(existingSkillPath);
  if (!existingSkill.includes("workspace version")) {
    fail("non-autoskill existing workspace skill should not be refreshed from runtime execenv");
  }
  ok("does not refresh non-autoskill existing workspace skill from runtime execenv");

  const managedExistingSkill = await mustRead(managedExistingSkillPath);
  if (!managedExistingSkill.includes("runtime updated version")) {
    fail("autoskill-managed existing workspace skill was not refreshed from runtime execenv");
  }
  if (!managedExistingSkill.includes("openclaw_skill_origin: autoskill")) {
    fail("refreshed autoskill-managed existing workspace skill lost autoskill metadata");
  }
  ok("refreshes autoskill-managed existing workspace skill from runtime execenv");

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

  try {
    await stat(join(workspace, "skills", ".hidden-skill"));
    fail("hidden runtime skill should not be mirrored into workspace");
  } catch {
    ok("does not mirror hidden runtime skills");
  }

  try {
    await stat(join(workspace, "skills", "unsafe-symlink-skill"));
    fail("runtime skill containing symlinks should not be mirrored into workspace");
  } catch {
    ok("does not mirror runtime skills containing symlinks");
  }

  await mirrorWorkspaceFromContainer(config, workspace, [], runtimeExecEnvPath, []);

  const directAutoskill = await mustRead(directAutoskillPath);
  if (!directAutoskill.includes("created by direct execenv write")) {
    fail("direct runtime autoskill was not copied into workspace/skills");
  }
  if (!directAutoskill.includes("openclaw_skill_origin: autoskill")) {
    fail("direct runtime autoskill did not receive autoskill metadata");
  }
  ok("copies direct execenv-created autoskills without explicit skill_manage event");

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

  const hostFlatGlobalSkillDir = join(config.hermesDataDir!, "skills", "flat-global-runtime-skill");
  await mkdir(hostFlatGlobalSkillDir, { recursive: true });
  await writeFile(
    join(hostFlatGlobalSkillDir, "SKILL.md"),
    "---\nname: flat-global-runtime-skill\ndescription: stored directly in hermes global skills\n---\n# Flat Global Runtime Skill\n\ncreated directly inside /opt/data/skills\n",
    "utf8",
  );

  await mirrorWorkspaceFromContainer(config, workspace, [], runtimeExecEnvPath, ["flat-global-runtime-skill"]);

  const flatGlobalSkillPath = join(workspace, "skills", "flat-global-runtime-skill", "SKILL.md");
  const flatGlobalSkill = await mustRead(flatGlobalSkillPath);
  if (!flatGlobalSkill.includes("created directly inside /opt/data/skills")) {
    fail("flat global Hermes skill was not copied into workspace/skills");
  }
  ok("copies explicitly created flat Hermes global skills from /opt/data/skills/<skill>");

  await mkdir(join(workspace, "skills", "global-managed-improved"), { recursive: true });
  await writeFile(
    join(workspace, "skills", "global-managed-improved", "SKILL.md"),
    "---\nopenclaw_managed: true\nopenclaw_skill_origin: autoskill\nopenclaw_created_by: hermes-runtime\nname: global-managed-improved\ndescription: workspace baseline\n---\n# Global Managed\n\nv1\n",
    "utf8",
  );
  const hostGlobalManagedImprovedDir = join(config.hermesDataDir!, "skills", "global-managed-improved");
  await mkdir(hostGlobalManagedImprovedDir, { recursive: true });
  await writeFile(
    join(hostGlobalManagedImprovedDir, "SKILL.md"),
    "---\nname: global-managed-improved\ndescription: improved in global Hermes skills\n---\n# Global Managed\n\nv2\n",
    "utf8",
  );

  await mirrorWorkspaceFromContainer(config, workspace, [], runtimeExecEnvPath, []);

  const globalManagedImproved = await mustRead(join(workspace, "skills", "global-managed-improved", "SKILL.md"));
  if (!globalManagedImproved.includes("v2")) {
    fail("managed global autoskill was not refreshed when explicit skill event names were unavailable");
  }
  if (!globalManagedImproved.includes("openclaw_created_by: hermes-runtime")) {
    fail("managed global autoskill lost autoskill metadata after refresh");
  }
  ok("refreshes existing managed global autoskills when explicit skill event names are unavailable");

  const unrelatedFlatGlobalSkillDir = join(config.hermesDataDir!, "skills", "unrelated-flat-global-skill");
  await mkdir(unrelatedFlatGlobalSkillDir, { recursive: true });
  await writeFile(
    join(unrelatedFlatGlobalSkillDir, "SKILL.md"),
    "---\nname: unrelated-flat-global-skill\ndescription: should stay isolated\n---\n# Unrelated Flat Global Skill\n\nmust not be copied without explicit event\n",
    "utf8",
  );

  await mirrorWorkspaceFromContainer(config, workspace, [], runtimeExecEnvPath, []);
  try {
    await stat(join(workspace, "skills", "unrelated-flat-global-skill"));
    fail("unrelated flat global Hermes skill should not be created without explicit skill event");
  } catch {
    ok("does not create new global Hermes skills when explicit skill event names are unavailable");
  }

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
