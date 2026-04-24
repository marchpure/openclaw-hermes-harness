import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mirrorWorkspaceFromContainer } from "../src/execenv-builder.js";
import { extractTouchedSkillNames } from "../src/result-processor.js";
import { DEFAULT_CONFIG, type AcpSessionEvent, type HermesPluginConfig } from "../src/types.js";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const workspace = await mkdtemp(join(tmpdir(), "hermes-skill-evolution-"));
  const config: HermesPluginConfig = {
    ...DEFAULT_CONFIG,
    hermesDataDir: join(workspace, ".hermes-data"),
  };
  const runtimeExecEnvPath = join("/opt/data/execenv", "skill-evolution");
  const hostExecEnvSkillsDir = join(config.hermesDataDir!, "execenv", "skill-evolution", "skills");

  await mkdir(join(workspace, "skills", "existing-skill"), { recursive: true });
  await writeFile(
    join(workspace, "skills", "existing-skill", "SKILL.md"),
    "# Existing Skill\n\nold content\n",
    "utf8",
  );

  await mkdir(join(hostExecEnvSkillsDir, "existing-skill"), { recursive: true });
  await writeFile(
    join(hostExecEnvSkillsDir, "existing-skill", "SKILL.md"),
    "# Existing Skill\n\nimproved content\n",
    "utf8",
  );

  const hostGlobalSkillDir = join(config.hermesDataDir!, "skills", "general", "new-autoskill");
  await mkdir(hostGlobalSkillDir, { recursive: true });
  await writeFile(
    join(hostGlobalSkillDir, "SKILL.md"),
    "# New Autoskill\n\ncreated from runtime\n",
    "utf8",
  );

  const autoskillEvents: AcpSessionEvent[] = [
    {
      type: "tool_result",
      toolName: "skill_manage",
      toolCallId: "2",
      text: JSON.stringify({
        action: "create",
        name: "new-autoskill",
        path: "/opt/data/skills/general/new-autoskill/SKILL.md",
        tool: "skill_create",
      }),
    },
  ];

  const autoskillTouchedNames = extractTouchedSkillNames(autoskillEvents);
  assert(
    autoskillTouchedNames.includes("new-autoskill"),
    `unexpected autoskill touched names: ${JSON.stringify(autoskillTouchedNames)}`,
  );

  await mirrorWorkspaceFromContainer(config, workspace, [], runtimeExecEnvPath, autoskillTouchedNames);

  const autoskillPath = join(workspace, "skills", "new-autoskill", "SKILL.md");
  const autoskill = await readFile(autoskillPath, "utf8");
  assert(autoskill.includes("created from runtime"), "new autoskill was not synced from Hermes global skills");
  assert(autoskill.includes("openclaw_skill_origin: autoskill"), "new autoskill did not receive autoskill metadata");

  await writeFile(
    join(hostGlobalSkillDir, "SKILL.md"),
    "# New Autoskill\n\nimproved autoskill content\n",
    "utf8",
  );

  const improveEvents: AcpSessionEvent[] = [
    {
      type: "tool_result",
      toolName: "skill_manage",
      toolCallId: "1",
      text: JSON.stringify({
        action: "patch",
        skill_name: "existing-skill",
        path: "/opt/data/execenv/skill-evolution/skills/existing-skill/SKILL.md",
      }),
    },
    {
      type: "tool_result",
      toolName: "skill_manage",
      toolCallId: "3",
      text: JSON.stringify({
        action: "patch",
        skill_name: "new-autoskill",
        path: "/opt/data/skills/general/new-autoskill/SKILL.md",
      }),
    },
  ];

  const touchedSkillNames = extractTouchedSkillNames(improveEvents);
  assert(
    touchedSkillNames.includes("existing-skill") && touchedSkillNames.includes("new-autoskill"),
    `unexpected touched skill names: ${JSON.stringify(touchedSkillNames)}`,
  );

  await mirrorWorkspaceFromContainer(config, workspace, [], runtimeExecEnvPath, touchedSkillNames);

  const improved = await readFile(join(workspace, "skills", "existing-skill", "SKILL.md"), "utf8");
  assert(improved.includes("old content"), "non-autoskill existing skill should not be updated");

  const autoskillImproved = await readFile(join(workspace, "skills", "new-autoskill", "SKILL.md"), "utf8");
  assert(autoskillImproved.includes("improved autoskill content"), "autoskill should be updateable after autoskill ownership is established");

  console.log("skill evolution test: ok");
  console.log(JSON.stringify({ touchedSkillNames }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
