import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = existsSync("/root/work/openclaw-hermes-harness")
  ? "/root/work/openclaw-hermes-harness"
  : "/root/openclaw-hermes-harness";
const outRoot = join(repoRoot, "artifacts", "openclaw-real-regression");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(outRoot, runId);
mkdirSync(outDir, { recursive: true });

const agentId = process.env.REGRESSION_AGENT_ID ?? "ai-1111";
const runtimeId = process.env.REGRESSION_RUNTIME_ID ?? "hermes";
const expectProvider = process.env.REGRESSION_EXPECT_PROVIDER ?? "hermes";
const expectModel = process.env.REGRESSION_EXPECT_MODEL ?? "default";
const maxMs = Number(process.env.REGRESSION_MAX_MS ?? 90_000);
const killAfterJsonMs = Number(process.env.REGRESSION_KILL_AFTER_JSON_MS ?? 3_000);
const retries = Number(process.env.REGRESSION_RETRIES ?? 1);
const retryDelayMs = Number(process.env.REGRESSION_RETRY_DELAY_MS ?? 5_000);
const selectedCaseIds = new Set(
  (process.env.REGRESSION_CASES ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean),
);

const workspace = `/root/.openclaw/.arkclaw-team/projects/project-1/workspaces/${agentId}`;
const fixtureDir = join(workspace, "hermes-real-regression-fixtures");
mkdirSync(fixtureDir, { recursive: true });
const routeBase = process.env.REGRESSION_ROUTE_BASE ?? "+1555000";

const cases = [
  {
    id: "basic",
    prompt: `请只回复 ${runtimeId.toUpperCase()}_BASIC_OK`,
    check: (_parsed, visible) => visible.trim() === `${runtimeId.toUpperCase()}_BASIC_OK`,
  },
  {
    id: "session-status-mcp",
    prompt: `请调用当前可用的 OpenClaw session_status/session MCP 工具查看当前会话状态，然后只回复 ${runtimeId.toUpperCase()}_SESSION_STATUS_OK。`,
    check: (parsed, visible) =>
      visible.includes(`${runtimeId.toUpperCase()}_SESSION_STATUS_OK`) &&
      (parsed.meta?.toolSummary?.tools ?? []).some((name) => String(name).includes("session")),
  },
  {
    id: "workspace-write",
    before: () => rmSync(join(fixtureDir, `${runtimeId}-write.txt`), { force: true }),
    prompt: `请使用文件工具创建这个绝对路径文件：${join(fixtureDir, `${runtimeId}-write.txt`)}，内容必须正好是 ${runtimeId.toUpperCase()}_WRITE_OK，然后只回复 ${runtimeId.toUpperCase()}_WRITE_DONE。`,
    check: (_parsed, visible) => {
      const target = join(fixtureDir, `${runtimeId}-write.txt`);
      const content = existsSync(target) ? readFileSync(target, "utf8").trim() : "";
      return visible.trim() === `${runtimeId.toUpperCase()}_WRITE_DONE` && content === `${runtimeId.toUpperCase()}_WRITE_OK`;
    },
  },
  {
    id: "workspace-read-after-write",
    before: () => writeFileSync(join(fixtureDir, `${runtimeId}-read-source.txt`), `${runtimeId.toUpperCase()}_READ_SOURCE_OK\n`),
    prompt: `请读取这个绝对路径文件的内容：${join(fixtureDir, `${runtimeId}-read-source.txt`)}，然后只回复文件中的完整标记。`,
    check: (_parsed, visible) => visible.trim() === `${runtimeId.toUpperCase()}_READ_SOURCE_OK`,
  },
  {
    id: "workspace-list",
    before: () => {
      writeFileSync(join(fixtureDir, `${runtimeId}-list-a.txt`), "A\n");
      writeFileSync(join(fixtureDir, `${runtimeId}-list-b.txt`), "B\n");
    },
    prompt: `请列出这个绝对路径目录中的文件名：${fixtureDir}。确认同时存在 ${runtimeId}-list-a.txt 和 ${runtimeId}-list-b.txt 后，只回复 ${runtimeId.toUpperCase()}_LIST_OK。`,
    check: (_parsed, visible) => visible.includes(`${runtimeId.toUpperCase()}_LIST_OK`),
  },
  {
    id: "agents-list-mcp",
    prompt: `请调用当前可用的 OpenClaw agents_list/agents MCP 工具查看 agent 列表，确认能看到 ai-1111 或 main 后，只回复 ${runtimeId.toUpperCase()}_AGENTS_OK。`,
    check: (parsed, visible) =>
      visible.includes(`${runtimeId.toUpperCase()}_AGENTS_OK`) &&
      (parsed.meta?.toolSummary?.tools ?? []).some((name) => /agents/i.test(String(name))),
  },
  {
    id: "sessions-list-mcp",
    prompt: `请调用当前可用的 OpenClaw sessions_list/sessions MCP 工具查看当前 agent session 列表，然后只回复 ${runtimeId.toUpperCase()}_SESSIONS_OK。`,
    check: (parsed, visible) =>
      visible.includes(`${runtimeId.toUpperCase()}_SESSIONS_OK`) &&
      (parsed.meta?.toolSummary?.tools ?? []).some((name) => /sessions/i.test(String(name))),
  },
  {
    id: "web-fetch-mcp",
    prompt: `请调用当前可用的 web_fetch 或 browser MCP 工具访问 https://example.com 并确认页面可达，然后只回复 ${runtimeId.toUpperCase()}_WEB_OK。`,
    check: (parsed, visible) =>
      visible.includes(`${runtimeId.toUpperCase()}_WEB_OK`) &&
      (parsed.meta?.toolSummary?.tools ?? []).some((name) => /web|browser/i.test(String(name))),
  },
  {
    id: "browser-status-mcp",
    prompt: `请调用当前可用的 browser MCP 工具查看浏览器状态或启动状态，然后只回复 ${runtimeId.toUpperCase()}_BROWSER_STATUS_OK。`,
    check: (parsed, visible) =>
      visible.includes(`${runtimeId.toUpperCase()}_BROWSER_STATUS_OK`) &&
      (parsed.meta?.toolSummary?.tools ?? []).some((name) => /browser/i.test(String(name))),
  },
  {
    id: "p0-skill-visibility",
    prompt: `请检查当前可见的 OpenClaw P0 skills/capabilities，确认 browser 或 browser-use、computer-use、byted-web-search 或 web_search、byted-seedream-image-generate、byted-seedance-video-generate、arkdrive-netdisk 至少有 5 项可见。不要执行图片或视频生成。确认后只回复 ${runtimeId.toUpperCase()}_P0_SKILLS_OK。`,
    check: (_parsed, visible) => visible.includes(`${runtimeId.toUpperCase()}_P0_SKILLS_OK`),
  },
  {
    id: "feishu-fetch-doc-mcp",
    prompt: `请调用当前可用的飞书/feishu MCP 工具读取这个文档的标题或摘要：https://bytedance.larkoffice.com/docx/Oe9Udos8dovO53x3Zqlcgtlynoc。读取成功后只回复 ${runtimeId.toUpperCase()}_FEISHU_OK；如果工具返回成功但你无法理解内容，也请说明具体原因并以 ${runtimeId.toUpperCase()}_FEISHU_DIAG 结尾。`,
    check: (parsed, visible) =>
      visible.includes(`${runtimeId.toUpperCase()}_FEISHU_OK`) &&
      (parsed.meta?.toolSummary?.tools ?? []).some((name) => /feishu/i.test(String(name))),
    diagnostic: (parsed, visible) =>
      visible.includes(`${runtimeId.toUpperCase()}_FEISHU_DIAG`) &&
      (parsed.meta?.toolSummary?.tools ?? []).some((name) => /feishu/i.test(String(name))),
  },
];

function extractJson(text) {
  if (!text) return null;
  for (let idx = text.lastIndexOf("\n{"); idx >= 0; idx = text.lastIndexOf("\n{", idx - 1)) {
    const raw = text.slice(idx + 1).trim();
    try {
      return JSON.parse(raw);
    } catch {}
  }
  const first = text.indexOf("{");
  if (first >= 0) {
    try {
      return JSON.parse(text.slice(first).trim());
    } catch {}
  }
  return null;
}

function visibleText(parsed) {
  return parsed?.meta?.finalAssistantVisibleText ??
    parsed?.payloads?.map((payload) => payload.text).filter(Boolean).join("\n") ??
    "";
}

function killProcessGroup(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }, 1000).unref();
}

function classifyFailure(record, parsed) {
  if (record.ok) return null;
  if (record.diagnostic) return "diagnostic";
  const visible = record.visible ?? "";
  if (!record.process.jsonSeen) return "no-json-result";
  if (/LLM request failed: network connection error/i.test(visible) && !record.toolSummary) {
    return "downstream-network-error";
  }
  if (parsed.meta?.stopReason === "error") return "runtime-or-model-error";
  if (record.provider !== expectProvider || record.model !== expectModel) return "unexpected-provider-or-model";
  if (record.toolSummary && !testCaseUsesTool(record.caseId, record.toolSummary)) return "unexpected-tool-summary";
  return "assertion-failed";
}

function testCaseUsesTool(caseId, toolSummary) {
  const tools = toolSummary?.tools ?? [];
  if (caseId.includes("mcp") || caseId.includes("feishu") || caseId.includes("session")) {
    return tools.length > 0;
  }
  return true;
}

function shouldRetry(record) {
  return record.failureCategory === "downstream-network-error" || record.failureCategory === "no-json-result";
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCaseAttempt(testCase, attempt) {
  if (attempt === 1) {
    testCase.before?.();
  }
  const sessionId = `${runtimeId}-real-${testCase.id}-a${attempt}-${Date.now()}`;
  const routeTarget = `${routeBase}${String(results.length + 1).padStart(4, "0")}${String(attempt).padStart(2, "0")}`;
  const stderrPath = join(outDir, `${testCase.id}.attempt-${attempt}.stderr.txt`);
  const stdoutPath = join(outDir, `${testCase.id}.attempt-${attempt}.stdout.txt`);
  let stderr = "";
  let stdout = "";
  let parsed = null;
  let jsonSeenAt = 0;
  const startedAt = Date.now();
  const child = spawn(
    "openclaw",
    ["agent", "--local", "--agent", agentId, "--to", routeTarget, "--session-id", sessionId, "--message", testCase.prompt, "--json", "--timeout", String(Math.ceil(maxMs / 1000))],
    {
      cwd: repoRoot,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    writeFileSync(stdoutPath, stdout);
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    writeFileSync(stderrPath, stderr);
    parsed = extractJson(stderr) ?? extractJson(stdout);
    if (parsed && !jsonSeenAt) {
      jsonSeenAt = Date.now();
    }
  });

  const status = await new Promise((resolve) => {
    const maxTimer = setTimeout(() => {
      killProcessGroup(child);
    }, maxMs);
    const pollTimer = setInterval(() => {
      if (jsonSeenAt && Date.now() - jsonSeenAt >= killAfterJsonMs) {
        killProcessGroup(child);
      }
    }, 250);
    child.on("exit", (code, signal) => {
      clearTimeout(maxTimer);
      clearInterval(pollTimer);
      resolve({ code, signal });
    });
  });

  parsed = parsed ?? extractJson(stderr) ?? extractJson(stdout) ?? {};
  const visible = visibleText(parsed);
  const provider = parsed.meta?.agentMeta?.provider ?? parsed.meta?.executionTrace?.winnerProvider ?? null;
  const model = parsed.meta?.agentMeta?.model ?? parsed.meta?.executionTrace?.winnerModel ?? null;
  const durationMs = parsed.meta?.durationMs ?? (jsonSeenAt ? jsonSeenAt - startedAt : Date.now() - startedAt);
  const ok = Boolean(parsed.meta) && provider === expectProvider && model === expectModel && testCase.check(parsed, visible);
  const diagnostic = Boolean(parsed.meta) && provider === expectProvider && model === expectModel && Boolean(testCase.diagnostic?.(parsed, visible));
  const record = {
    runtimeId,
    agentId,
    caseId: testCase.id,
    attempt,
    sessionId,
    routeTarget,
    ok,
    diagnostic,
    provider,
    model,
    durationMs,
    visible,
    toolSummary: parsed.meta?.toolSummary ?? null,
    process: {
      code: status.code,
      signal: status.signal,
      jsonSeen: Boolean(parsed.meta),
      killedAfterJson: Boolean(jsonSeenAt) && status.signal !== null,
    },
    artifacts: { stdoutPath, stderrPath },
  };
  record.failureCategory = classifyFailure(record, parsed);
  return record;
}

async function runCase(testCase) {
  const attempts = [];
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    const record = await runCaseAttempt(testCase, attempt);
    attempts.push(record);
    if (record.ok || attempt > retries || !shouldRetry(record)) {
      return {
        ...record,
        attempts: attempts.map((item) => ({
          attempt: item.attempt,
          ok: item.ok,
          diagnostic: item.diagnostic,
          failureCategory: item.failureCategory,
          durationMs: item.durationMs,
          visible: item.visible,
          toolSummary: item.toolSummary,
          artifacts: item.artifacts,
        })),
      };
    }
    console.error(`[regression] retry ${testCase.id} after ${record.failureCategory}`);
    await sleep(retryDelayMs);
  }
  return attempts.at(-1);
}

const results = [];
for (const testCase of cases) {
  if (selectedCaseIds.size > 0 && !selectedCaseIds.has(testCase.id)) {
    continue;
  }
  console.error(`[regression] start ${testCase.id}`);
  const record = await runCase(testCase);
  results.push(record);
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
  console.error(`[regression] done ${testCase.id} ok=${record.ok} durationMs=${record.durationMs} signal=${record.process.signal ?? "none"}`);
}

const summary = {
  runId,
  outDir,
  runtimeId,
  agentId,
  expectProvider,
  expectModel,
  retries,
  total: results.length,
  passed: results.filter((result) => result.ok).length,
  diagnostics: results.filter((result) => result.diagnostic).length,
  failedByCategory: results.reduce((acc, result) => {
    if (result.ok || result.diagnostic) return acc;
    const key = result.failureCategory ?? "unknown";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {}),
  avgDurationMs: Math.round(results.reduce((sum, result) => sum + result.durationMs, 0) / Math.max(results.length, 1)),
  results,
};
writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
