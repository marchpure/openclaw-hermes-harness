import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import type {
  CredentialEnvelopeManifest,
  ExecEnvBuildResult,
  ExecEnvInput,
  ExecEnvManifest,
  HermesPluginConfig,
  ProjectedSkill,
} from "./types.js";
import {
  CREDENTIAL_ENV_FILENAME,
  CREDENTIAL_MANIFEST_FILENAME,
  OPENCLAW_RUNTIME_DIR,
} from "./types.js";
import {
  resolveHostExecEnvPathFromRuntimePath,
  resolveExecEnvHostPath,
  resolveExecEnvRuntimePath,
} from "./runtime-paths.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const AUTOSKILL_HEADER_LINES = [
  "openclaw_managed: true",
  "openclaw_skill_origin: autoskill",
  "openclaw_created_by: hermes-runtime",
];
const SHARED_WORKSPACE_ROOTS = ["/root/.openclaw/workspace"];

function normalizeMirroredRoots(workspaceDir: string): string[] {
  return [workspaceDir, ...SHARED_WORKSPACE_ROOTS]
    .filter((value) => value.startsWith("/"))
    .map((value) => value.replace(/\\/g, "/").replace(/\/+/g, "/"))
    .sort((left, right) => right.length - left.length);
}

function isMirroredWorkspacePath(path: string, workspaceDir: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/+/g, "/");
  return normalizeMirroredRoots(workspaceDir).some((root) => normalizedPath.startsWith(root));
}

async function readAutoskillMetadata(skillFile: string): Promise<{
  managed: boolean;
  autoskill: boolean;
}> {
  try {
    const content = await readFile(skillFile, "utf8");
    return {
      managed: /^openclaw_managed:\s*true$/m.test(content),
      autoskill: /^openclaw_skill_origin:\s*autoskill$/m.test(content),
    };
  } catch {
    return { managed: false, autoskill: false };
  }
}

async function ensureAutoskillMetadata(skillDir: string): Promise<void> {
  const skillFile = join(skillDir, "SKILL.md");
  let content = await readFile(skillFile, "utf8");
  const hasManaged = /^openclaw_managed:\s*true$/m.test(content);
  const hasOrigin = /^openclaw_skill_origin:\s*autoskill$/m.test(content);
  const hasCreator = /^openclaw_created_by:\s*hermes-runtime$/m.test(content);
  if (hasManaged && hasOrigin && hasCreator) {
    return;
  }

  if (content.startsWith("---\n")) {
    const closing = content.indexOf("\n---\n", 4);
    if (closing >= 0) {
      const frontmatter = content.slice(0, closing + 5);
      const body = content.slice(closing + 5);
      const extraLines = AUTOSKILL_HEADER_LINES.filter((line) => !frontmatter.includes(line));
      if (extraLines.length > 0) {
        const injected = `${frontmatter.slice(0, -4)}${extraLines.join("\n")}\n---\n${body}`;
        await writeFile(skillFile, injected, "utf8");
      }
      return;
    }
  }

  const header = `---\n${AUTOSKILL_HEADER_LINES.join("\n")}\n---\n`;
  if (!content.startsWith(header)) {
    content = `${header}${content}`;
    await writeFile(skillFile, content, "utf8");
  }
}

async function copyProjectedSkill(
  hostExecEnvPath: string,
  runtimeExecEnvPath: string,
  skill: ProjectedSkill,
): Promise<ProjectedSkill> {
  if (!skill.sourcePath) return skill;

  const skillDir = join(hostExecEnvPath, "skills", skill.name);
  const sourceSkillPath = skill.sourcePath;
  const sourceSkillDir = dirname(sourceSkillPath);
  await mkdir(join(hostExecEnvPath, "skills"), { recursive: true });

  // Project the full skill directory so runtime scripts/assets referenced by
  // SKILL.md remain executable inside Hermes execenv.
  await cp(sourceSkillDir, skillDir, {
    recursive: true,
    force: true,
    dereference: true,
  });

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
  // The projection manifest is the execenv's audit record: it captures which
  // workspace, skills, and projection schema produced this Hermes workdir.
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

function shellEscapeSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function writeCredentialEnvelope(
  hostExecEnvPath: string,
  envelope: ExecEnvInput["credentialEnvelope"],
): Promise<string | undefined> {
  const runtimeDir = join(hostExecEnvPath, OPENCLAW_RUNTIME_DIR);
  const envFilePath = join(runtimeDir, CREDENTIAL_ENV_FILENAME);
  const manifestPath = join(runtimeDir, CREDENTIAL_MANIFEST_FILENAME);

  await rm(envFilePath, { force: true });
  await rm(manifestPath, { force: true });

  if (!envelope || Object.keys(envelope.envVars).length === 0) {
    return undefined;
  }

  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });

  const envContent = Object.entries(envelope.envVars)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `export ${key}=${shellEscapeSingleQuoted(value)}`)
    .join("\n") + "\n";

  await writeFile(envFilePath, envContent, { encoding: "utf8", mode: 0o600 });

  const manifest: CredentialEnvelopeManifest = {
    version: envelope.version,
    scope: envelope.scope,
    generatedAt: new Date().toISOString(),
    envFile: `${OPENCLAW_RUNTIME_DIR}/${CREDENTIAL_ENV_FILENAME}`,
    envKeys: Object.keys(envelope.envVars).sort(),
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { encoding: "utf8", mode: 0o600 });
  return manifestPath;
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
    // Use a tar pipe instead of docker cp for steadier throughput on large
    // directories and to avoid intermediate archive files.
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
  const hermesDataDir = config.hermesDataDir?.trim();
  // When the runtime execenv lives under /opt/data, the container path is the
  // same bind-mounted directory as hostExecEnvPath. Re-copying would first
  // `rm -rf` the container path and accidentally delete the host projection.
  if (
    hermesDataDir &&
    hostExecEnvPath.startsWith(`${hermesDataDir}/`) &&
    runtimeExecEnvPath === hostExecEnvPath.replace(hermesDataDir, "/opt/data")
  ) {
    return;
  }

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

function uniqueSortedPaths(paths: string[]): string[] {
  return [...new Set(paths)].sort();
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch(() => false);
}

async function mirrorPathToContainer(config: HermesPluginConfig, hostPath: string): Promise<void> {
  const container = config.hermesContainerName;
  const parent = dirname(hostPath);
  const base = hostPath.slice(parent.length + 1);
  await runCommand("docker", [
    "exec",
    container,
    "sh",
    "-lc",
    `mkdir -p ${JSON.stringify(parent)}`,
  ]);
  console.log(`[hermes-sync] host->container file ${hostPath}`);

  await new Promise<void>((resolve, reject) => {
    const tarCreate = spawn("tar", ["-C", parent, "-cf", "-", base], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tarExtract = spawn("docker", [
      "exec",
      "-i",
      container,
      "tar",
      "-C",
      parent,
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
      if (!failed && createDone && extractDone) resolve();
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
      if (code !== 0) return fail(new Error(`tar create failed with exit ${code}: ${stderr.trim()}`));
      createDone = true;
      finishIfDone();
    });
    tarExtract.on("exit", (code) => {
      if (code !== 0) return fail(new Error(`docker exec tar extract failed with exit ${code}: ${stderr.trim()}`));
      extractDone = true;
      finishIfDone();
    });
  });
}

async function mirrorPathFromContainer(config: HermesPluginConfig, hostPath: string): Promise<void> {
  const container = config.hermesContainerName;
  const parent = dirname(hostPath);
  await mkdir(parent, { recursive: true });
  console.log(`[hermes-sync] container->host file ${hostPath}`);
  const existsInContainer = await runCommand("docker", [
    "exec",
    container,
    "sh",
    "-lc",
    `test -e ${JSON.stringify(hostPath)}`,
  ]).then(() => true).catch(() => false);
  if (!existsInContainer) {
    return;
  }
  await runCommand("docker", [
    "cp",
    `${container}:${hostPath}`,
    hostPath,
  ]);
}

async function mirrorDirectoryToContainer(config: HermesPluginConfig, hostDir: string): Promise<void> {
  const container = config.hermesContainerName;
  const runtimeParent = hostDir.slice(0, Math.max(hostDir.lastIndexOf("/"), 1));
  await runCommand("docker", [
    "exec",
    container,
    "sh",
    "-lc",
    `mkdir -p ${JSON.stringify(runtimeParent)} && mkdir -p ${JSON.stringify(hostDir)}`,
  ]);
  await streamDirectoryToContainer(hostDir, container, hostDir);
}

async function mirrorDirectoryFromContainer(config: HermesPluginConfig, hostDir: string): Promise<void> {
  const container = config.hermesContainerName;
  await mkdir(hostDir, { recursive: true });
  await streamDirectoryFromContainer(container, hostDir, hostDir);
}

async function syncExecEnvSkillsToWorkspace(
  config: HermesPluginConfig,
  workspaceDir: string,
  runtimeExecEnvPath: string,
  createdSkillNames: string[],
): Promise<void> {
  if (!runtimeExecEnvPath.startsWith("/")) return;

  const workspaceSkillsDir = join(workspaceDir, "skills");
  const runtimeSkillsDir = join(runtimeExecEnvPath, "skills");
  const hostExecEnvSkillsDir = join(
    resolveHostExecEnvPathFromRuntimePath(config, runtimeExecEnvPath),
    "skills",
  );
  const tempSyncDir = join(tmpdir(), `hermes-skill-sync-${hashText(runtimeExecEnvPath).slice(0, 12)}`);
  const allowedSkills = new Set(createdSkillNames);
  const allowAllNewSkills = createdSkillNames.length === 0;

  await mkdir(workspaceSkillsDir, { recursive: true });

  try {
    // Hermes may report prompt completion slightly before the execenv skill
    // write is visible on the mounted host path or fully streamed back out of
    // the container. Retry briefly so plain `write skills/.../SKILL.md` flows
    // can still sync into the OpenClaw workspace.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const hostExecEnvAvailable = await stat(hostExecEnvSkillsDir)
        .then((info) => info.isDirectory())
        .catch(() => false);

      let sourceDir = hostExecEnvSkillsDir;
      if (!hostExecEnvAvailable) {
        await rm(tempSyncDir, { recursive: true, force: true });
        await mkdir(tempSyncDir, { recursive: true });
        await streamDirectoryFromContainer(config.hermesContainerName, runtimeSkillsDir, tempSyncDir);
        sourceDir = tempSyncDir;
      }

      let copiedCount = 0;
      const skillEntries = await readdir(sourceDir, { withFileTypes: true }).catch(() => []);
      for (const entry of skillEntries) {
        if (!entry.isDirectory()) continue;
        const sourceSkillDir = join(sourceDir, entry.name);
        const sourceSkillFile = join(sourceSkillDir, "SKILL.md");
        try {
          const skillFileStat = await stat(sourceSkillFile);
          if (!skillFileStat.isFile()) continue;
        } catch {
          continue;
        }
        const targetSkillDir = join(workspaceSkillsDir, entry.name);
        const targetSkillFile = join(targetSkillDir, "SKILL.md");
        const targetExists = await stat(targetSkillFile).then((info) => info.isFile()).catch(() => false);
        if (!allowAllNewSkills && !allowedSkills.has(entry.name)) {
          continue;
        }
        if (targetExists) {
          const meta = await readAutoskillMetadata(targetSkillFile);
          if (!meta.managed || !meta.autoskill) {
            continue;
          }
        }
        await cp(sourceSkillDir, targetSkillDir, {
          recursive: true,
          force: true,
          dereference: true,
        });
        await ensureAutoskillMetadata(targetSkillDir);
        copiedCount += 1;
      }

      if (copiedCount > 0 || attempt === 4) {
        break;
      }
      await sleep(200);
    }
  } catch {
    // No projected runtime skills yet; nothing to sync back.
  } finally {
    await rm(tempSyncDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function syncGlobalHermesSkillsToWorkspace(
  config: HermesPluginConfig,
  workspaceDir: string,
  createdSkillNames: string[],
): Promise<void> {
  if (createdSkillNames.length === 0) return;
  const workspaceSkillsDir = join(workspaceDir, "skills");
  const runtimeGlobalSkillsDir = "/opt/data/skills";
  const hostGlobalSkillsDir = config.hermesDataDir?.trim()
    ? join(config.hermesDataDir.trim(), "skills")
    : undefined;
  const tempSyncDir = join(tmpdir(), `hermes-global-skill-sync-${hashText(workspaceDir).slice(0, 12)}`);
  const allowedSkills = new Set(createdSkillNames);

  await mkdir(workspaceSkillsDir, { recursive: true });

  try {
    let sourceDir = tempSyncDir;
    const hostGlobalSkillsAvailable = hostGlobalSkillsDir
      ? await stat(hostGlobalSkillsDir).then((info) => info.isDirectory()).catch(() => false)
      : false;

    if (hostGlobalSkillsAvailable && hostGlobalSkillsDir) {
      sourceDir = hostGlobalSkillsDir;
    } else {
      await rm(tempSyncDir, { recursive: true, force: true });
      await mkdir(tempSyncDir, { recursive: true });
      await streamDirectoryFromContainer(config.hermesContainerName, runtimeGlobalSkillsDir, tempSyncDir);
    }

    const copySkillDir = async (sourceSkillDir: string, skillName: string): Promise<void> => {
      const sourceSkillFile = join(sourceSkillDir, "SKILL.md");
      try {
        const skillFileStat = await stat(sourceSkillFile);
        if (!skillFileStat.isFile()) return;
      } catch {
        return;
      }
      const targetSkillDir = join(workspaceSkillsDir, skillName);
      const targetSkillFile = join(targetSkillDir, "SKILL.md");
      const targetExists = await stat(targetSkillFile).then((info) => info.isFile()).catch(() => false);
      if (targetExists) {
        const meta = await readAutoskillMetadata(targetSkillFile);
        if (!meta.managed || !meta.autoskill) {
          return;
        }
      }
      await cp(sourceSkillDir, targetSkillDir, {
        recursive: true,
        force: true,
        dereference: true,
      });
      await ensureAutoskillMetadata(targetSkillDir);
    };

    const rootEntries = await readdir(sourceDir, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (!entry.isDirectory()) continue;

      // Hermes may create skills directly under /opt/data/skills/<skill>
      // instead of categorizing them under /opt/data/skills/<category>/<skill>.
      if (allowedSkills.has(entry.name)) {
        await copySkillDir(join(sourceDir, entry.name), entry.name);
        continue;
      }

      const categoryDir = join(sourceDir, entry.name);
      const skillEntries = await readdir(categoryDir, { withFileTypes: true }).catch(() => []);
      for (const skillEntry of skillEntries) {
        if (!skillEntry.isDirectory()) continue;
        if (!allowedSkills.has(skillEntry.name)) continue;
        await copySkillDir(join(categoryDir, skillEntry.name), skillEntry.name);
      }
    }
  } catch (err) {
    // Hermes global skills may be unavailable in some deployments.
  } finally {
    await rm(tempSyncDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function mirrorWorkspaceToContainer(
  config: HermesPluginConfig,
  workspaceDir: string,
  referencedPaths: string[] = [],
): Promise<void> {
  if (!config.mirrorExecEnvToContainer) return;
  if (config.transport !== "tcp") return;
  if (!workspaceDir.startsWith("/")) return;

  const normalizedPaths = uniqueSortedPaths(
    referencedPaths.filter((value) => isMirroredWorkspacePath(value, workspaceDir)),
  );
  const dirs = uniqueSortedPaths(normalizedPaths.map((value) => dirname(value)));

  for (const path of normalizedPaths) {
    if (await pathExists(path)) {
      await mirrorPathToContainer(config, path);
    }
  }

  for (const dir of dirs) {
    // Sync only the prompt-referenced workspace slices so Hermes can access
    // the same host files without paying the cost of copying large caches.
    await mirrorDirectoryToContainer(config, dir);
  }
}

export async function mirrorWorkspaceFromContainer(
  config: HermesPluginConfig,
  workspaceDir: string,
  referencedPaths: string[] = [],
  runtimeExecEnvPath?: string,
  createdSkillNames: string[] = [],
): Promise<void> {
  if (!config.mirrorExecEnvToContainer) return;
  if (config.transport !== "tcp") return;
  if (!workspaceDir.startsWith("/")) return;

  const normalizedPaths = uniqueSortedPaths(
    referencedPaths.filter((value) => isMirroredWorkspacePath(value, workspaceDir)),
  );
  const dirs = uniqueSortedPaths(normalizedPaths.map((value) => dirname(value)));

  for (const path of normalizedPaths) {
    await mirrorPathFromContainer(config, path).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[hermes-sync] failed file pull ${path}: ${detail}`);
    });
    const exists = await pathExists(path);
    console.log(`[hermes-sync] host visibility after file pull ${path} exists=${exists}`);
  }

  for (const dir of dirs) {
    // Pull back only the directories touched by the prompt so host-side
    // assertions observe Hermes edits without mirroring the full workspace.
    await mirrorDirectoryFromContainer(config, dir);
  }

  // Hermes autoskill writes land in the projected execenv cwd rather than the
  // real OpenClaw workspace. Persist any generated skills back into the host
  // workspace so future turns can discover and use them.
  if (runtimeExecEnvPath) {
    await syncExecEnvSkillsToWorkspace(config, workspaceDir, runtimeExecEnvPath, createdSkillNames);
  }

  // Hermes skill_manage writes may land in the runtime-global /opt/data/skills
  // store instead of the projected execenv. Mirror back only the skills that
  // were explicitly created in this run; never import the full Hermes catalog.
  await syncGlobalHermesSkillsToWorkspace(config, workspaceDir, createdSkillNames);
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
  // Do not remove the whole execenv directory; only refresh files generated by
  // projection so Hermes-owned cwd state can survive across turns.
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
    // Skill projection copies local markdown instructions, not OpenClaw host
    // tool capabilities. Host-backed skills must be filtered before this point.
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
    // Directory-name ordering is intentionally simple for baseline cleanup.
    // If retention needs to be more exact, switch this to an mtime policy.
    await rm(join(root, entry.name), { recursive: true, force: true });
  }
}

export async function cleanupExecEnv(config: HermesPluginConfig, execEnv: {
  hostExecEnvPath: string;
  runtimeExecEnvPath: string;
}): Promise<void> {
  await rm(execEnv.hostExecEnvPath, { recursive: true, force: true }).catch(() => {});

  if (!execEnv.runtimeExecEnvPath.startsWith("/")) return;

  const hermesDataDir = config.hermesDataDir?.trim();
  if (
    hermesDataDir &&
    execEnv.hostExecEnvPath.startsWith(`${hermesDataDir}/`) &&
    execEnv.runtimeExecEnvPath === execEnv.hostExecEnvPath.replace(hermesDataDir, "/opt/data")
  ) {
    return;
  }

  await runCommand("docker", [
    "exec",
    config.hermesContainerName,
    "sh",
    "-lc",
    `rm -rf ${JSON.stringify(execEnv.runtimeExecEnvPath)}`,
  ]).catch(() => {});
}
