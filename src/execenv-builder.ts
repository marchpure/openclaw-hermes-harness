import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type {
  ExecEnvBuildResult,
  ExecEnvInput,
  ExecEnvManifest,
  HermesPluginConfig,
  ProjectedSkill,
} from "./types.js";
import {
  resolveExecEnvHostPath,
  resolveExecEnvRuntimePath,
} from "./runtime-paths.js";

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function copyProjectedSkill(hostExecEnvPath: string, skill: ProjectedSkill): Promise<ProjectedSkill> {
  if (!skill.sourcePath) return skill;

  const skillDir = join(hostExecEnvPath, "skills", skill.name);
  await mkdir(skillDir, { recursive: true });

  const targetSkillPath = join(skillDir, "SKILL.md");
  await cp(skill.sourcePath, targetSkillPath, { force: true });

  return {
    ...skill,
    projectedPath: targetSkillPath,
  };
}

function buildManifest(input: {
  config: HermesPluginConfig;
  execEnvInput: ExecEnvInput;
  runtimeExecEnvPath: string;
  projectedSkills: ProjectedSkill[];
  sessionBindingHash: string;
}): ExecEnvManifest {
  const workspaceHash = hashText(input.execEnvInput.workspaceDir);
  const skillsHash = hashText(JSON.stringify(input.projectedSkills.map((skill) => ({
    name: skill.name,
    classification: skill.classification,
    sourcePath: skill.sourcePath,
  }))));
  const projectionHash = hashText(
    JSON.stringify({
      version: input.config.projectionVersion,
      files: input.execEnvInput.contextFiles,
      runtimeConfig: input.execEnvInput.runtimeConfig,
    }),
  );

  return {
    version: input.config.projectionVersion,
    taskId: input.execEnvInput.taskId,
    agentId: input.execEnvInput.agentId,
    hostWorkspaceDir: input.execEnvInput.workspaceDir,
    runtimeCwd: input.runtimeExecEnvPath,
    files: {
      soul: input.execEnvInput.contextFiles.soul ? "SOUL.md" : undefined,
      user: input.execEnvInput.contextFiles.user ? "USER.md" : undefined,
      agent: input.execEnvInput.contextFiles.agent ? "AGENT.md" : undefined,
      task: input.execEnvInput.contextFiles.task ? "TASK.md" : undefined,
    },
    skills: input.projectedSkills,
    hashes: {
      workspace: workspaceHash,
      skills: skillsHash,
      projection: projectionHash,
      sessionBinding: input.sessionBindingHash,
    },
  };
}

export async function buildExecEnv(
  config: HermesPluginConfig,
  input: ExecEnvInput,
  sessionBindingHash: string,
): Promise<ExecEnvBuildResult> {
  const hostExecEnvPath = resolveExecEnvHostPath(config, input.taskId);
  const runtimeExecEnvPath = resolveExecEnvRuntimePath(config, input.taskId);

  await rm(hostExecEnvPath, { recursive: true, force: true });
  await mkdir(hostExecEnvPath, { recursive: true });
  await mkdir(join(hostExecEnvPath, "skills"), { recursive: true });

  if (input.contextFiles.soul) {
    await writeFile(join(hostExecEnvPath, "SOUL.md"), input.contextFiles.soul, "utf8");
  }
  if (input.contextFiles.user) {
    await writeFile(join(hostExecEnvPath, "USER.md"), input.contextFiles.user, "utf8");
  }
  if (input.contextFiles.agent) {
    await writeFile(join(hostExecEnvPath, "AGENT.md"), input.contextFiles.agent, "utf8");
  }
  if (input.contextFiles.task) {
    await writeFile(join(hostExecEnvPath, "TASK.md"), input.contextFiles.task, "utf8");
  }

  const projectedSkills: ProjectedSkill[] = [];
  for (const skill of input.projectedSkills) {
    projectedSkills.push(await copyProjectedSkill(hostExecEnvPath, skill));
  }

  await writeFile(
    join(hostExecEnvPath, "runtime-config.json"),
    JSON.stringify(input.runtimeConfig, null, 2),
    "utf8",
  );

  const manifest = buildManifest({
    config,
    execEnvInput: input,
    runtimeExecEnvPath,
    projectedSkills,
    sessionBindingHash,
  });
  const manifestPath = join(hostExecEnvPath, "projection.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  return {
    hostExecEnvPath,
    runtimeExecEnvPath,
    manifestPath,
    projectedSkills,
    sessionBindingHash,
  };
}

export async function cleanupExecEnvs(config: HermesPluginConfig): Promise<void> {
  if (!config.execEnvCleanup.enabled) return;
  const root = config.execEnvRootDir ?? config.hermesDataDir;
  if (!root) return;

  try {
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) return;
  } catch {
    return;
  }

  // Cleanup is intentionally conservative in the first iteration.
}

export async function readProjectedSkillFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}
