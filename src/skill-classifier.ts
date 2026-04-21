import type {
  HermesPluginConfig,
  ProjectedSkill,
  SkillManifestEntry,
} from "./types.js";

export interface SkillClassificationResult {
  projectableLocalSkills: ProjectedSkill[];
  descriptiveOnlySkills: ProjectedSkill[];
  hostBackedSkills: ProjectedSkill[];
  unsupportedSkills: ProjectedSkill[];
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

export function classifySkillEntry(
  skill: SkillManifestEntry,
  config: HermesPluginConfig,
): ProjectedSkill {
  const normalized = normalizeName(skill.name);
  const hostBackedNames = new Set(
    config.skillProjection.hostBackedDenylist.map((entry) => normalizeName(entry)),
  );
  const descriptiveOnlyNames = new Set(
    config.skillProjection.descriptiveOnlyAllowlist.map((entry) => normalizeName(entry)),
  );

  if (hostBackedNames.has(normalized)) {
    return {
      ...skill,
      classification: "host-backed",
      executable: false,
      sourcePath: skill.path,
    };
  }

  if (descriptiveOnlyNames.has(normalized)) {
    return {
      ...skill,
      classification: "descriptive-only",
      executable: false,
      sourcePath: skill.path,
    };
  }

  if (skill.path?.endsWith("/SKILL.md") || skill.path?.endsWith("\\SKILL.md")) {
    return {
      ...skill,
      classification: "projectable-local",
      executable: false,
      sourcePath: skill.path,
    };
  }

  return {
    ...skill,
    classification: "unsupported",
    executable: false,
    sourcePath: skill.path,
  };
}

export function classifyWorkspaceSkills(
  skills: SkillManifestEntry[],
  config: HermesPluginConfig,
): SkillClassificationResult {
  const result: SkillClassificationResult = {
    projectableLocalSkills: [],
    descriptiveOnlySkills: [],
    hostBackedSkills: [],
    unsupportedSkills: [],
  };

  for (const skill of skills) {
    const classified = classifySkillEntry(skill, config);
    if (classified.classification === "projectable-local") {
      result.projectableLocalSkills.push(classified);
    } else if (classified.classification === "descriptive-only") {
      result.descriptiveOnlySkills.push(classified);
    } else if (classified.classification === "host-backed") {
      result.hostBackedSkills.push(classified);
    } else {
      result.unsupportedSkills.push(classified);
    }
  }

  return result;
}
