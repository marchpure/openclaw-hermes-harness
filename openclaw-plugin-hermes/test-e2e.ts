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
import { dispatchToHermes } from "./src/dispatcher.js";
import { traceDispatch, getOrCreateProvider } from "./src/observability/index.js";
import { inferStrategy, formatStrategy } from "./src/strategy-engine.js";
import { assembleContext, serializeContextForPrompt } from "./src/context-assembler.js";
import { injectCredentials } from "./src/credential-injector.js";
import { checkHealth, formatHealthReport } from "./src/health.js";
import { DEFAULT_CONFIG } from "./src/types.js";
import type { HermesPluginConfig } from "./src/types.js";

const config: HermesPluginConfig = {
  ...DEFAULT_CONFIG,
  hermesContainerName: "hermes-agent",
  timeout: 60,
};

const WORKSPACE = "/Users/bytedance/.the-system/workspace";

// ─── Helpers ────────────────────────────────────────────────────────────────

function section(title: string) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${"═".repeat(60)}\n`);
}

function ok(msg: string) { console.log(`  ✅ ${msg}`); }
function fail(msg: string) { console.log(`  ❌ ${msg}`); }
function info(msg: string) { console.log(`  ℹ️  ${msg}`); }

// ─── Test 1: Health Check ───────────────────────────────────────────────────

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

// ─── Test 2: Strategy Inference ─────────────────────────────────────────────

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

// ─── Test 3: Context Assembly ───────────────────────────────────────────────

async function testContextAssembly() {
  section("Test 3: 上下文组装");

  for (const level of ["L0", "L1", "L2"] as const) {
    const payload = await assembleContext(
      "测试任务",
      level,
      { workspaceDir: WORKSPACE, config },
    );

    const keys = Object.keys(payload).filter(k => {
      const v = (payload as any)[k];
      return v !== undefined && v !== null && (typeof v !== 'object' || Object.keys(v).length > 0);
    });
    ok(`${level}: 包含 [${keys.join(", ")}]`);
  }
}

// ─── Test 4: Credential Injection ───────────────────────────────────────────

function testCredentials() {
  section("Test 4: 凭据注入");

  // C0
  const c0 = injectCredentials({ mode: "none" });
  ok(`C0: ${c0.injected.length} 个凭据, ${c0.auditLog.length} 条日志`);

  // C1
  const c1 = injectCredentials({ mode: "specified", keys: ["OPENAI_API_KEY", "GITHUB_TOKEN"] });
  ok(`C1: ${c1.injected.length} 个凭据注入 (${c1.injected.map(e => e.key).join(", ") || "无匹配"})`);
  for (const log of c1.auditLog) {
    info(log);
  }
}

// ─── Test 5: Full ACP E2E ───────────────────────────────────────────────────

async function testAcpE2E() {
  section("Test 5: ACP 端到端通信");

  const client = new HermesAcpClient(config);
  const events: string[] = [];

  client.on("session-event", (event: any) => {
    events.push(`${event.type}: ${event.text?.slice(0, 50) ?? ""}`);
  });

  try {
    // Step 1: Start
    info("启动 ACP 连接...");
    await client.start({}, WORKSPACE);
    ok("ACP 初始化成功");

    // Step 2: New session
    info("创建会话...");
    const sessionId = await client.newSession("/opt/data");
    ok(`会话已创建: ${sessionId}`);

    // Step 3: Prompt
    info("发送测试提示...");
    const result = await client.prompt(
      "你好，请用一句话介绍你自己。",
      sessionId,
      { timeout: 45000 },
    );

    ok(`收到回复 (${result.text.length} 字符)`);
    console.log(`\n  📨 Hermes 回复:\n  "${result.text}"\n`);

    if (result.usage) {
      info(`Token 使用: input=${result.usage.input_tokens}, output=${result.usage.output_tokens}, total=${result.usage.total_tokens}, cache_read=${result.usage.cache_read_tokens}, cache_write=${result.usage.cache_write_tokens}`);
      console.log(`  🔍 完整的 usage 对象:`, JSON.stringify(result.usage, null, 2));
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

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🚀 OpenClaw × Hermes 插件 — 端到端测试\n");

  // Test 1
  const healthy = await testHealth();
  if (!healthy) {
    fail("容器未运行，跳过后续测试。先运行: cd hermes-containerized && docker compose up -d");
    process.exit(1);
  }

  // Test 2
  testStrategy();

  // Test 3
  await testContextAssembly();

  // Test 4
  testCredentials();

  // Test 5
  await testAcpE2E();

  // Test 6
  await testDispatchE2E();

  section("全部测试完成 ✅");
}

async function testDispatchE2E() {
  section("Test 6: Full Dispatch E2E with trace");
  try {
    const res = await traceDispatch(
      {
        endpoint: "http://127.0.0.1:4317",
        apmplusCtx: {
          traceId: "test-trace-1234",
          spanId: "test-span-5678",
          allowUserDetailInfoReport: true,
          channelId: "hermes-e2e",
        },
        task: "你好，用一段话介绍自己。",
        params: {
          task: "你好，用一段话介绍自己。",
          model: "test-model-abc",
        },
      },
      () =>
        dispatchToHermes(
          {
            task: "你好，用一段话介绍自己。",
            model: "test-model-abc",
          },
          {
            config,
            workspaceDir: WORKSPACE,
            logger: console,
          },
        ),
    );
    ok(`Dispatch returned successfully. Result length: ${res.result.length}`);
  } catch (err) {
    fail(`Dispatch failed: ${err}`);
  }
}

main().catch(console.error);
