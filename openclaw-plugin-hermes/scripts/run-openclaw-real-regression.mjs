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
const maxMs = Number(process.env.REGRESSION_MAX_MS ?? 180_000);
const killAfterJsonMs = Number(process.env.REGRESSION_KILL_AFTER_JSON_MS ?? 3_000);

const workspace = `/root/.openclaw/.arkclaw-team/projects/project-1/workspaces/${agentId}`;
const fixtureDir = join(workspace, "hermes-real-regression-fixtures");
mkdirSync(fixtureDir, { recursive: true });

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
    prompt: `请使用文件工具在当前 workspace 下创建 hermes-real-regression-fixtures/${runtimeId}-write.txt，内容必须正好是 ${runtimeId.toUpperCase()}_WRITE_OK，然后只回复 ${runtimeId.toUpperCase()}_WRITE_DONE。`,
    check: (_parsed, visible) => {
      const target = join(fixtureDir, `${runtimeId}-write.txt`);
      const content = existsSync(target) ? readFileSync(target, "utf8").trim() : "";
      return visible.trim() === `${runtimeId.toUpperCase()}_WRITE_DONE` && content === `${runtimeId.toUpperCase()}_WRITE_OK`;
    },
  },
  {
    id: "web-fetch-mcp",
    prompt: `请调用当前可用的 web_fetch 或 browser MCP 工具访问 https://example.com 并确认页面可达，然后只回复 ${runtimeId.toUpperCase()}_WEB_OK。`,
    check: (parsed, visible) =>
      visible.includes(`${runtimeId.toUpperCase()}_WEB_OK`) &&
      (parsed.meta?.toolSummary?.tools ?? []).some((name) => /web|browser/i.test(String(name))),
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

async function runCase(testCase) {
  testCase.before?.();
  const sessionId = `${runtimeId}-real-${testCase.id}-${Date.now()}`;
  const stderrPath = join(outDir, `${testCase.id}.stderr.txt`);
  const stdoutPath = join(outDir, `${testCase.id}.stdout.txt`);
  let stderr = "";
  let stdout = "";
  let parsed = null;
  let jsonSeenAt = 0;
  const startedAt = Date.now();
  const child = spawn(
    "openclaw",
    ["agent", "--local", "--agent", agentId, "--session-id", sessionId, "--message", testCase.prompt, "--json", "--timeout", String(Math.ceil(maxMs / 1000))],
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
  return {
    runtimeId,
    agentId,
    caseId: testCase.id,
    sessionId,
    ok,
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
}

const results = [];
for (const testCase of cases) {
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
  total: results.length,
  passed: results.filter((result) => result.ok).length,
  avgDurationMs: Math.round(results.reduce((sum, result) => sum + result.durationMs, 0) / Math.max(results.length, 1)),
  results,
};
writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
