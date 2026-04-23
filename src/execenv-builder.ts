import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { spawn } from "node:child_process";
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

async function copyProjectedSkill(
  hostExecEnvPath: string,
  runtimeExecEnvPath: string,
  skill: ProjectedSkill,
): Promise<ProjectedSkill> {
  if (!skill.sourcePath) return skill;

  const skillDir = join(hostExecEnvPath, "skills", skill.name);
  await mkdir(skillDir, { recursive: true });

  const targetSkillPath = join(skillDir, "SKILL.md");
  await cp(skill.sourcePath, targetSkillPath, { force: true });

  return {
    ...skill,
    projectedPath: join(runtimeExecEnvPath, "skills", skill.name, "SKILL.md"),
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
      agent: input.execEnvInput.contextFiles.agent ? "AGENTS.md" : undefined,
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

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with exit ${code}: ${stderr.trim()}`));
    });
  });
}

function streamDirectoryToContainer(hostExecEnvPath: string, container: string, runtimeExecEnvPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tarCreate = spawn("tar", ["-C", hostExecEnvPath, "-cf", "-", "."], {
      env: {
        ...process.env,
        COPYFILE_DISABLE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tarExtract = spawn("docker", [
      "exec",
      "-i",
      container,
      "tar",
      "-C",
      runtimeExecEnvPath,
      "-xf",
      "-",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    tarCreate.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    tarExtract.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    tarCreate.stdout.pipe(tarExtract.stdin);

    let createDone = false;
    let extractDone = false;
    let failed = false;

    const finishIfDone = () => {
      if (!failed && createDone && extractDone) {
        resolve();
      }
    };

    const fail = (err: Error) => {
      if (failed) return;
      failed = true;
      tarCreate.kill();
      tarExtract.kill();
      reject(err);
    };

    tarCreate.on("error", (err) => fail(err));
    tarExtract.on("error", (err) => fail(err));

    tarCreate.on("exit", (code) => {
      if (code !== 0) {
        fail(new Error(`tar create failed with exit ${code}: ${stderr.trim()}`));
        return;
      }
      createDone = true;
      finishIfDone();
    });

    tarExtract.on("exit", (code) => {
      if (code !== 0) {
        fail(new Error(`docker exec tar extract failed with exit ${code}: ${stderr.trim()}`));
        return;
      }
      extractDone = true;
      finishIfDone();
    });
  });
}

function streamDirectoryFromContainer(container: string, runtimePath: string, hostPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tarCreate = spawn("docker", [
      "exec",
      container,
      "tar",
      "-C",
      runtimePath,
      "-cf",
      "-",
      ".",
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tarExtract = spawn("tar", ["-C", hostPath, "-xf", "-"], {
      env: {
        ...process.env,
        COPYFILE_DISABLE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    tarCreate.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    tarExtract.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    tarCreate.stdout.pipe(tarExtract.stdin);

    let createDone = false;
    let extractDone = false;
    let failed = false;

    const finishIfDone = () => {
      if (!failed && createDone && extractDone) {
        resolve();
      }
    };

    const fail = (err: Error) => {
      if (failed) return;
      failed = true;
      tarCreate.kill();
      tarExtract.kill();
      reject(err);
    };

    tarCreate.on("error", (err) => fail(err));
    tarExtract.on("error", (err) => fail(err));

    tarCreate.on("exit", (code) => {
      if (code !== 0) {
        fail(new Error(`docker exec tar create failed with exit ${code}: ${stderr.trim()}`));
        return;
      }
      createDone = true;
      finishIfDone();
    });

    tarExtract.on("exit", (code) => {
      if (code !== 0) {
        fail(new Error(`tar extract failed with exit ${code}: ${stderr.trim()}`));
        return;
      }
      extractDone = true;
      finishIfDone();
    });
  });
}

async function mirrorExecEnvToContainer(config: HermesPluginConfig, hostExecEnvPath: string, runtimeExecEnvPath: string): Promise<void> {
  if (!config.mirrorExecEnvToContainer) return;
  if (config.transport !== "tcp") return;
  if (!runtimeExecEnvPath.startsWith("/")) return;

  const container = config.hermesContainerName;
  const runtimeParent = runtimeExecEnvPath.slice(0, Math.max(runtimeExecEnvPath.lastIndexOf("/"), 1));
  await runCommand("docker", [
    "exec",
    container,
    "sh",
    "-lc",
    `mkdir -p ${JSON.stringify(runtimeParent)} && rm -rf ${JSON.stringify(runtimeExecEnvPath)} && mkdir -p ${JSON.stringify(runtimeExecEnvPath)}`,
  ]);
  await streamDirectoryToContainer(hostExecEnvPath, container, runtimeExecEnvPath);
}

export async function mirrorWorkspaceToContainer(config: HermesPluginConfig, workspaceDir: string): Promise<void> {
  if (!config.mirrorExecEnvToContainer) return;
  if (config.transport !== "tcp") return;
  if (!workspaceDir.startsWith("/")) return;

  const container = config.hermesContainerName;
  const runtimeParent = workspaceDir.slice(0, Math.max(workspaceDir.lastIndexOf("/"), 1));
  await runCommand("docker", [
    "exec",
    container,
    "sh",
    "-lc",
    `mkdir -p ${JSON.stringify(runtimeParent)} && rm -rf ${JSON.stringify(workspaceDir)} && mkdir -p ${JSON.stringify(workspaceDir)}`,
  ]);
  // Hermes tools run inside the container but OpenClaw validates on the host.
  // Mirroring the workspace before each turn makes absolute workspace paths
  // resolve to the same starting contents in both namespaces.
  await streamDirectoryToContainer(workspaceDir, container, workspaceDir);
}

export async function mirrorWorkspaceFromContainer(config: HermesPluginConfig, workspaceDir: string): Promise<void> {
  if (!config.mirrorExecEnvToContainer) return;
  if (config.transport !== "tcp") return;
  if (!workspaceDir.startsWith("/")) return;

  const container = config.hermesContainerName;
  await mkdir(workspaceDir, { recursive: true });
  // Pull back file creations/edits made by Hermes so host-side OpenClaw checks
  // observe real tool effects instead of container-private state.
  await streamDirectoryFromContainer(container, workspaceDir, workspaceDir);
}

export async function buildExecEnv(
  config: HermesPluginConfig,
  input: ExecEnvInput,
  sessionBindingHash: string,
): Promise<ExecEnvBuildResult> {
  const hostExecEnvPath = resolveExecEnvHostPath(config, input.taskId);
  const runtimeExecEnvPath = resolveExecEnvRuntimePath(config, input.taskId);

  await mkdir(hostExecEnvPath, { recursive: true });

  // Preserve Hermes-owned runtime state in stable execenv directories so ACP
  // session resume can reuse the same workdir across turns.
  await rm(join(hostExecEnvPath, "skills"), { recursive: true, force: true });
  await rm(join(hostExecEnvPath, "SOUL.md"), { force: true });
  await rm(join(hostExecEnvPath, "USER.md"), { force: true });
  await rm(join(hostExecEnvPath, "AGENT.md"), { force: true });
  await rm(join(hostExecEnvPath, "AGENTS.md"), { force: true });
  await rm(join(hostExecEnvPath, "TASK.md"), { force: true });
  await rm(join(hostExecEnvPath, "runtime-config.json"), { force: true });
  await rm(join(hostExecEnvPath, "projection.json"), { force: true });
  await mkdir(join(hostExecEnvPath, "skills"), { recursive: true });

  if (input.contextFiles.soul) {
    await writeFile(join(hostExecEnvPath, "SOUL.md"), input.contextFiles.soul, "utf8");
  }
  if (input.contextFiles.user) {
    await writeFile(join(hostExecEnvPath, "USER.md"), input.contextFiles.user, "utf8");
  }
  if (input.contextFiles.agent) {
    await writeFile(join(hostExecEnvPath, "AGENT.md"), input.contextFiles.agent, "utf8");
    await writeFile(join(hostExecEnvPath, "AGENTS.md"), input.contextFiles.agent, "utf8");
  }
  if (input.contextFiles.task) {
    await writeFile(join(hostExecEnvPath, "TASK.md"), input.contextFiles.task, "utf8");
  }

  const projectedSkills: ProjectedSkill[] = [];
  for (const skill of input.projectedSkills) {
    projectedSkills.push(await copyProjectedSkill(hostExecEnvPath, runtimeExecEnvPath, skill));
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
  await mirrorExecEnvToContainer(config, hostExecEnvPath, runtimeExecEnvPath);

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
  const root = config.execEnvRootDir ?? (config.hermesDataDir ? join(config.hermesDataDir, "execenv") : undefined);
  if (!root) return;

  try {
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) return;
  } catch {
    return;
  }

  const entries = await readdir(root, { withFileTypes: true });
  const taskDirs = entries.filter((entry) => entry.isDirectory());
  if (taskDirs.length <= config.execEnvCleanup.maxCount) return;

  const overflow = taskDirs.length - config.execEnvCleanup.maxCount;
  const sorted = [...taskDirs].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sorted.slice(0, overflow)) {
    await rm(join(root, entry.name), { recursive: true, force: true });
  }
}

export async function readProjectedSkillFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}
