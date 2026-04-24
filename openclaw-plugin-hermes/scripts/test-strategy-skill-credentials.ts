import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSkillsManifest } from "../src/context-assembler.js";
import { inferStrategy } from "../src/strategy-engine.js";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const workspace = await mkdtemp(join(tmpdir(), "hermes-strategy-skill-cred-"));
  const skillDir = join(workspace, "skills", "byted-web-search");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    `---
name: byted-web-search
description: 火山引擎联网搜索 API，联网搜索场景优先使用本 skill。
metadata:
  openclaw:
    primaryEnv: "WEB_SEARCH_API_KEY"
---

# Byted Web Search

联网搜索、核实、最新信息、出处链接。
`,
    "utf8",
  );

  const skills = await readSkillsManifest(join(workspace, "skills"));
  const strategy = inferStrategy("帮我核实一下最近 OpenAI 最新发布，并附上来源链接", {
    availableSkills: skills,
  });

  assert(strategy.credential.mode === "specified", "strategy should infer C1 credentials from skill declaration");
  assert(
    strategy.credential.keys?.includes("WEB_SEARCH_API_KEY"),
    "strategy should request WEB_SEARCH_API_KEY",
  );

  console.log("strategy skill credential inference test: ok");
  console.log(JSON.stringify({
    skills,
    strategy,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
