import { createHash } from "node:crypto";
import { assembleProjectedContext, serializeProjectedContextForPrompt } from "./context-assembler.js";
import { buildExecEnv } from "./execenv-builder.js";
import { classifyWorkspaceSkills } from "./skill-classifier.js";
import type {
  ContextLevel,
  ExecEnvBuildResult,
  HermesPluginConfig,
  ProjectedContext,
  ProjectedSkill,
} from "./types.js";

export interface PreparedExecution {
  execEnv: ExecEnvBuildResult;
  projectedContext: ProjectedContext;
  exposedSkills: ProjectedSkill[];
  bootstrapPrompt: string;
}

function computeSessionBindingHash(input: {
  workspaceDir: string;
  runtimeExecEnvPath: string;
  projectionVersion: string;
  skillNames: string[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        workspaceDir: input.workspaceDir,
        runtimeExecEnvPath: input.runtimeExecEnvPath,
        projectionVersion: input.projectionVersion,
        skills: input.skillNames,
      }),
    )
    .digest("hex");
}

function buildRuntimeRoot(config: HermesPluginConfig): string {
  return config.runtimeExecEnvRootDir ??
    config.execEnvRootDir ??
    config.hermesDataDir ??
    "/var/cache/hermes-agent/execenv";
}

export async function prepareProjectedExecutionEnv(params: {
  task: string;
  taskId: string;
  workspaceDir: string;
  contextLevel: ContextLevel;
  model?: string;
  config: HermesPluginConfig;
}): Promise<PreparedExecution> {
  const projectedContext = await assembleProjectedContext(params.task, params.contextLevel, {
    workspaceDir: params.workspaceDir,
    config: params.config,
  });
  const classifiedSkills = classifyWorkspaceSkills(projectedContext.discoveredSkills, params.config);
  const runtimeRoot = buildRuntimeRoot(params.config);
  const runtimeExecEnvPathHint = `${runtimeRoot}/${params.taskId}`;
  const sessionBindingHash = computeSessionBindingHash({
    workspaceDir: params.workspaceDir,
    runtimeExecEnvPath: runtimeExecEnvPathHint,
    projectionVersion: params.config.projectionVersion,
    skillNames: classifiedSkills.projectableLocalSkills.map((skill) => skill.name),
  });
  const execEnv = await buildExecEnv(
    params.config,
    {
      taskId: params.taskId,
      workspaceDir: params.workspaceDir,
      runtimeRootDir: runtimeRoot,
      contextFiles: projectedContext.files,
      projectedSkills: classifiedSkills.projectableLocalSkills,
      runtimeConfig: {
        model: params.model ?? params.config.defaultModel ?? "minimax-m2.5",
        contextLevel: params.contextLevel,
        projectionVersion: params.config.projectionVersion,
      },
    },
    sessionBindingHash,
  );

  return {
    execEnv,
    projectedContext,
    exposedSkills: execEnv.projectedSkills,
    bootstrapPrompt: serializeProjectedContextForPrompt(projectedContext, execEnv.projectedSkills),
  };
}
