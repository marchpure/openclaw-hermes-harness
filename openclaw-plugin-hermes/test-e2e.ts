/**
 * 端到端测试 — 直接调用插件核心模块
 *
 * 用法: npx tsx test-e2e.ts
 *
 * 测试流程:
 *   1. 健康检查 — 确认 Hermes 容器在跑
 *   2. 策略推断 — 测试几个任务的自动推断
 *   3. ACP 通信 — initialize → session/new → session/prompt → 收结果
 */

import { HermesAcpClient } from "./src/acp-client.js";
import { inferStrategy, formatStrategy } from "./src/strategy-engine.js";
import { assembleContext, serializeContextForPrompt } from "./src/context-assembler.js";
import { injectCredentials } from "./src/credential-injector.js";
import { checkHealth, formatHealthReport } from "./src/health.js";
import { DEFAULT_CONFIG } from "./src/types.js";
import type { HermesPluginConfig } from "./src/types.js";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareProjectedExecutionEnv } from "./src/runtime-client.js";
import { mirrorWorkspaceFromContainer } from "./src/execenv-builder.js";

const config: HermesPluginConfig = {
  ...DEFAULT_CONFIG,
  hermesContainerName: "hermes-agent",
  timeout: 60,
};

const WORKSPACE = "/Users/bytedance/.the-system/workspace";

function section(title: string) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${"═".repeat(60)}\n`);
}

function ok(msg: string) { console.log(`  ✅ ${msg}`); }
function fail(msg: string) { console.log(`  ❌ ${msg}`); }
function info(msg: string) { console.log(`  ℹ️  ${msg}`); }

async function testHealth() {
  section("Test 1: 健康检查");
  try {
    const report = await checkHealth(config);
    console.log(formatHealthReport(report));
    if (report.containerRunning) ok("容器运行中");
    else fail("容器未运行");
    if (report.acpResponsive) ok("ACP 响应正常");
    else fail("ACP 无响应");
    return report.containerRunning;
  } catch (err) {
    fail(`健康检查异常: ${err}`);
    return false;
  }
}

function testStrategy() {
  section("Test 2: 策略推断");

  const cases = [
    "查一下今天天气",
    "帮我跑一下 npm test",
    "用我的语气帮我写一封回复邮件",
    "帮我在 GitHub 上 fork 这个仓库",
    "创建一个每天检查 SSL 证书的定时任务技能",
    "检查服务器磁盘空间",
    "统一回复所有平台的消息",
  ];

  for (const task of cases) {
    const strategy = inferStrategy(task);
    const label = formatStrategy(strategy);
    info(`"${task}"`);
    ok(`→ ${label} (confidence: ${(strategy.confidence * 100).toFixed(0)}%)`);
    console.log(`     ${strategy.reasoning}`);
    console.log();
  }
}

async function testContextAssembly() {
  section("Test 3: 上下文组装");

  for (const level of ["L0", "L1", "L2"] as const) {
    const payload = await assembleContext(
      "测试任务",
      level,
      { workspaceDir: WORKSPACE, config },
    );

    const keys = Object.keys(payload).filter((k) => {
      const v = (payload as any)[k];
      return v !== undefined && v !== null && (typeof v !== "object" || Object.keys(v).length > 0);
    });
    ok(`${level}: 包含 [${keys.join(", ")}]`);
  }
}

function testCredentials() {
  section("Test 4: 凭据注入");

  const c0 = injectCredentials({ mode: "none" });
  ok(`C0: ${c0.injected.length} 个凭据, ${c0.auditLog.length} 条日志`);

  const c1 = injectCredentials({ mode: "specified", keys: ["OPENAI_API_KEY", "GITHUB_TOKEN"] });
  ok(`C1: ${c1.injected.length} 个凭据注入 (${c1.injected.map((e) => e.key).join(", ") || "无匹配"})`);
  for (const log of c1.auditLog) {
    info(log);
  }
}

async function testAcpE2E() {
  section("Test 5: ACP 端到端通信");

  const client = new HermesAcpClient(config);
  const events: string[] = [];

  client.on("session-event", (event: any) => {
    events.push(`${event.type}: ${event.text?.slice(0, 50) ?? ""}`);
  });

  try {
    info("启动 ACP 连接...");
    await client.start({}, WORKSPACE);
    ok("ACP 初始化成功");

    info("创建会话...");
    const sessionId = await client.newSession("/opt/data");
    ok(`会话已创建: ${sessionId}`);

    info("发送测试提示...");
    const result = await client.prompt(
      "你好，请用一句话介绍你自己。",
      sessionId,
      { timeout: 45000 },
    );

    ok(`收到回复 (${result.text.length} 字符)`);
    console.log(`\n  📨 Hermes 回复:\n  "${result.text}"\n`);

    if (result.usage) {
      info(`Token 使用: input=${result.usage.input_tokens}, output=${result.usage.output_tokens}, total=${result.usage.total_tokens}`);
    }

    info(`事件流: ${result.events.length} 个事件`);
    for (const e of events) {
      info(`  ${e}`);
    }

    ok("ACP 端到端测试通过 🎉");
  } catch (err) {
    fail(`ACP 测试失败: ${err}`);
  } finally {
    await client.close().catch(() => {});
  }
}

async function testProjectionRuntime() {
  section("Test 6: Execution Projection");

  const workspace = await mkdtemp(join(tmpdir(), "hermes-runtime-e2e-"));
  await writeFile(join(workspace, "SOUL.md"), "You are a finance research agent.", "utf8");
  await writeFile(join(workspace, "USER.md"), "The user is Hao Xingjun.", "utf8");
  await writeFile(join(workspace, "AGENTS.md"), "Prefer concise, factual answers.", "utf8");
  await mkdir(join(workspace, "skills", "summary-helper"), { recursive: true });
  await writeFile(
    join(workspace, "skills", "summary-helper", "SKILL.md"),
    "# Summary Helper\n\nSummarize in 3 lines.",
    "utf8",
  );
  await mkdir(join(workspace, "skills", "browser"), { recursive: true });
  await writeFile(
    join(workspace, "skills", "browser", "SKILL.md"),
    "# Browser\n\nSearch the web.",
    "utf8",
  );

  const runtimeConfig: HermesPluginConfig = {
    ...config,
    hermesDataDir: join(workspace, ".hermes-data"),
  };

  const execution = await prepareProjectedExecutionEnv({
    task: "Summarize market news.",
    taskId: "task-e2e",
    workspaceDir: workspace,
    contextLevel: "L3",
    config: runtimeConfig,
  });

  ok(`ExecEnv 已创建: ${execution.execEnv.runtimeExecEnvPath}`);
  ok(`暴露技能: ${execution.exposedSkills.map((skill) => skill.name).join(", ") || "(none)"}`);

  if (execution.exposedSkills.some((skill) => skill.name === "browser")) {
    fail("browser 不应出现在投影后的 OpenClaw skills 中");
  } else {
    ok("browser 已正确过滤");
  }

  if (execution.bootstrapPrompt.includes("**browser**")) {
    fail("bootstrap prompt 不应声明 browser 可用");
  } else {
    ok("bootstrap prompt 已正确去除 browser 暴露");
  }
}

async function testExecenvSkillWriteback() {
  section("Test 7: Execenv Skill Writeback");

  const workspace = await mkdtemp(join(tmpdir(), "hermes-runtime-writeback-"));
  await mkdir(join(workspace, "skills", "existing-skill"), { recursive: true });
  await writeFile(
    join(workspace, "skills", "existing-skill", "SKILL.md"),
    "---\nopenclaw_managed: true\nopenclaw_skill_origin: autoskill\nopenclaw_created_by: hermes-runtime\nname: existing-skill\ndescription: existing\n---\n# Existing\n\noriginal workspace skill\n",
    "utf8",
  );

  const taskId = `task-writeback-${Date.now()}`;
  const runtimeConfig: HermesPluginConfig = {
    ...config,
    hermesDataDir: join(workspace, ".hermes-data"),
  };

  const execution = await prepareProjectedExecutionEnv({
    task: "Create a new skill in execenv",
    taskId,
    workspaceDir: workspace,
    contextLevel: "L3",
    config: runtimeConfig,
  });

  const runtimeSkillDir = join(execution.execEnv.runtimeExecEnvPath, "skills");
  const hostNewSkillDir = join(workspace, ".hermes-data", "execenv", taskId, "skills", "runtime-generated-skill");
  const hostExistingSkillDir = join(workspace, ".hermes-data", "execenv", taskId, "skills", "existing-skill");
  const hostInvalidDir = join(workspace, ".hermes-data", "execenv", taskId, "skills", "invalid-no-skill-md");

  await mkdir(hostNewSkillDir, { recursive: true });
  await writeFile(
    join(hostNewSkillDir, "SKILL.md"),
    "---\nname: runtime-generated-skill\ndescription: generated in execenv\n---\n# Runtime Generated\n\ncreated by Hermes runtime\n",
    "utf8",
  );

  await mkdir(hostExistingSkillDir, { recursive: true });
  await writeFile(
    join(hostExistingSkillDir, "SKILL.md"),
    "---\nname: existing-skill\ndescription: updated in execenv\n---\n# Existing\n\nupdated by Hermes runtime\n",
    "utf8",
  );

  await mkdir(hostInvalidDir, { recursive: true });
  await writeFile(join(hostInvalidDir, "README.md"), "missing SKILL.md", "utf8");

  const hostGlobalSkillDir = join(workspace, ".hermes-data", "skills", "productivity", "global-runtime-skill");
  await mkdir(hostGlobalSkillDir, { recursive: true });
  await writeFile(
    join(hostGlobalSkillDir, "SKILL.md"),
    "---\nname: global-runtime-skill\ndescription: stored in global hermes skills\n---\n# Global Runtime Skill\n\ncreated by Hermes global skill store\n",
    "utf8",
  );

  await mirrorWorkspaceFromContainer(
    runtimeConfig,
    workspace,
    [],
    runtimeSkillDir.replace(/\/skills$/, ""),
    ["runtime-generated-skill", "existing-skill", "global-runtime-skill"],
  );

  const syncedNewSkill = join(workspace, "skills", "runtime-generated-skill", "SKILL.md");
  const syncedExistingSkill = join(workspace, "skills", "existing-skill", "SKILL.md");
  const syncedGlobalSkill = join(workspace, "skills", "global-runtime-skill", "SKILL.md");
  const invalidMirrored = join(workspace, "skills", "invalid-no-skill-md");

  const syncedNewContent = await readFile(syncedNewSkill, "utf8").catch(() => "");
  const syncedExistingContent = await readFile(syncedExistingSkill, "utf8").catch(() => "");
  const syncedGlobalContent = await readFile(syncedGlobalSkill, "utf8").catch(() => "");

  if (syncedNewContent.includes("created by Hermes runtime")) {
    ok("execenv 新增 skill 已同步回 workspace/skills");
  } else {
    fail("execenv 新增 skill 未同步回 workspace/skills");
  }

  if (syncedExistingContent.includes("updated by Hermes runtime")) {
    ok("workspace 已有 skill 可被 execenv 更新版本覆盖");
  } else {
    fail("workspace 已有 skill 未被 execenv 更新");
  }

  if (syncedGlobalContent.includes("created by Hermes global skill store")) {
    ok("Hermes 全局技能库 /opt/data/skills 已同步回 workspace/skills");
  } else {
    fail("Hermes 全局技能库 /opt/data/skills 未同步回 workspace/skills");
  }

  try {
    await stat(invalidMirrored);
    fail("缺少 SKILL.md 的无效目录不应被同步");
  } catch {
    ok("缺少 SKILL.md 的无效目录已正确忽略");
  }
}

async function main() {
  console.log("\n🚀 OpenClaw × Hermes 插件 — 端到端测试\n");

  const healthy = await testHealth();
  if (!healthy) {
    fail("容器未运行，跳过后续测试。先运行: cd hermes-containerized && docker compose up -d");
    process.exit(1);
  }

  testStrategy();
  await testContextAssembly();
  testCredentials();
  await testAcpE2E();
  await testProjectionRuntime();
  await testExecenvSkillWriteback();

  section("全部测试完成 ✅");
}

main().catch(console.error);
