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
const modelOverride = process.env.REGRESSION_MODEL_OVERRIDE ?? "";
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
const runTag = runId.replace(/[^0-9A-Za-z]/g, "").slice(-12).toLowerCase();
const autoSkillName = `${runtimeId}-real-autoskill-${runTag}`;
const improveSkillName = `${runtimeId}-real-skillimprove-${runTag}`;
const autoSkillDir = join(workspace, "skills", autoSkillName);
const improveSkillDir = join(workspace, "skills", improveSkillName);
const autoSkillFile = join(autoSkillDir, "SKILL.md");
const improveSkillFile = join(improveSkillDir, "SKILL.md");

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
    id: "compute-use",
    before: () => rmSync(join(fixtureDir, `${runtimeId}-compute.json`), { force: true }),
    prompt: `请必须调用 terminal/exec/process 这类真实 compute 工具执行命令来计算 1234567 * 89 + 42，不要心算。然后把 JSON 写入这个绝对路径文件：${join(fixtureDir, `${runtimeId}-compute.json`)}。JSON 必须包含 {"runtime":"${runtimeId}","value":109876505}。写完后只回复 ${runtimeId.toUpperCase()}_COMPUTE_OK。`,
    check: (parsed, visible) => {
      const target = join(fixtureDir, `${runtimeId}-compute.json`);
      let data = {};
      try {
        data = JSON.parse(existsSync(target) ? readFileSync(target, "utf8") : "{}");
      } catch {}
      return visible.includes(`${runtimeId.toUpperCase()}_COMPUTE_OK`) &&
        data.runtime === runtimeId &&
        data.value === 109876505 &&
        (parsed.meta?.toolSummary?.tools ?? []).some((name) => /^(terminal|exec|process)\b/i.test(String(name)));
    },
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
    id: "feishu-tool-visibility-mcp",
    prompt: `这是一个严格工具调用测试。请必须调用 OpenClaw MCP 的 mcp_openclaw_list_resources 或等价资源/工具列表工具，确认工具列表中存在飞书工具，例如 mcp_openclaw_feishu_doc 或 mcp_openclaw_feishu_fetch_doc。不能只根据提示文字判断；如果没有实际调用列表工具，本用例会失败。确认后只回复 ${runtimeId.toUpperCase()}_FEISHU_TOOL_VISIBLE_OK；如果不存在，请列出你实际看到的 OpenClaw MCP 工具名并以 ${runtimeId.toUpperCase()}_FEISHU_TOOL_VISIBLE_DIAG 结尾。`,
    check: (parsed, visible) =>
      visible.includes(`${runtimeId.toUpperCase()}_FEISHU_TOOL_VISIBLE_OK`) &&
      (parsed.meta?.toolSummary?.tools ?? []).some((name) => /mcp_openclaw_/i.test(String(name))),
    diagnostic: (parsed, visible) =>
      visible.includes(`${runtimeId.toUpperCase()}_FEISHU_TOOL_VISIBLE_DIAG`) &&
      (parsed.meta?.toolSummary?.tools ?? []).some((name) => /mcp_openclaw_/i.test(String(name))),
  },
  {
    id: "feishu-fetch-doc-mcp",
    prompt: `请必须调用当前 tools/list 中实际存在的 OpenClaw 飞书 MCP 工具读取这个文档：https://bytedance.larkoffice.com/docx/Oe9Udos8dovO53x3Zqlcgtlynoc。工具名通常带 mcp_openclaw_ 前缀；优先使用 stock OpenClaw 的 mcp_openclaw_feishu_doc 并传 action=read、doc_token=Oe9Udos8dovO53x3Zqlcgtlynoc；如果只看到 openclaw-lark 的 mcp_openclaw_feishu_fetch_doc，也可以调用它并传 doc_id 为原始 URL。不要读取容器内 feishu-fetch-doc/SKILL.md，不要运行 opencli，也不要用浏览器替代。读取成功后只回复 ${runtimeId.toUpperCase()}_FEISHU_OK；如果飞书工具被调用但返回需要授权或权限不足，请说明具体错误并以 ${runtimeId.toUpperCase()}_FEISHU_AUTH_REQUIRED 结尾；如果没有任何飞书工具可用，请说明具体原因并以 ${runtimeId.toUpperCase()}_FEISHU_DIAG 结尾。`,
    check: (parsed, visible) =>
      visible.includes(`${runtimeId.toUpperCase()}_FEISHU_OK`) &&
      (parsed.meta?.toolSummary?.tools ?? []).some((name) => /mcp_openclaw_.*feishu/i.test(String(name))),
    diagnostic: (parsed, visible) =>
      (visible.includes(`${runtimeId.toUpperCase()}_FEISHU_DIAG`) ||
        visible.includes(`${runtimeId.toUpperCase()}_FEISHU_AUTH_REQUIRED`)) &&
      (parsed.meta?.toolSummary?.tools ?? []).some((name) => /mcp_openclaw_.*feishu/i.test(String(name))),
  },
  {
    id: "autoskill-create",
    before: () => rmSync(autoSkillDir, { recursive: true, force: true }),
    prompt: `请使用 Hermes runtime 的 autoskill/skill_manage 能力创建一个新的 autoskill，名称必须是 ${autoSkillName}。SKILL.md 必须包含 frontmatter name: ${autoSkillName}，description 中包含 real autoskill regression，并且正文包含 ${runtimeId.toUpperCase()}_AUTOSKILL_CONTENT。完成后只回复 ${runtimeId.toUpperCase()}_AUTOSKILL_OK。`,
    check: (parsed, visible) => {
      const content = existsSync(autoSkillFile) ? readFileSync(autoSkillFile, "utf8") : "";
      return visible.includes(`${runtimeId.toUpperCase()}_AUTOSKILL_OK`) &&
        content.includes(`name: ${autoSkillName}`) &&
        content.includes("real autoskill regression") &&
        content.includes(`${runtimeId.toUpperCase()}_AUTOSKILL_CONTENT`) &&
        content.includes("openclaw_skill_origin: autoskill") &&
        (parsed.meta?.toolSummary?.tools ?? []).some((name) => /skill_manage|skill_create|terminal|exec/i.test(String(name)));
    },
  },
  {
    id: "skillimprove-update",
    before: () => {
      rmSync(improveSkillDir, { recursive: true, force: true });
      mkdirSync(improveSkillDir, { recursive: true });
      writeFileSync(
        improveSkillFile,
        `---\nopenclaw_managed: true\nopenclaw_skill_origin: autoskill\nopenclaw_created_by: hermes-runtime\nname: ${improveSkillName}\ndescription: baseline skillimprove regression\n---\n# ${improveSkillName}\n\nBASELINE_ONLY\n`,
      );
    },
    prompt: `请使用 Hermes runtime 的 skillimprove/skill_manage 能力改进已有 autoskill ${improveSkillName}。必须保留 openclaw_skill_origin: autoskill 元数据，并把 SKILL.md 正文中的 BASELINE_ONLY 替换或扩展为 ${runtimeId.toUpperCase()}_SKILLIMPROVE_CONTENT。完成后只回复 ${runtimeId.toUpperCase()}_SKILLIMPROVE_OK。`,
    check: (parsed, visible) => {
      const content = existsSync(improveSkillFile) ? readFileSync(improveSkillFile, "utf8") : "";
      return visible.includes(`${runtimeId.toUpperCase()}_SKILLIMPROVE_OK`) &&
        content.includes(`name: ${improveSkillName}`) &&
        content.includes("openclaw_skill_origin: autoskill") &&
        content.includes(`${runtimeId.toUpperCase()}_SKILLIMPROVE_CONTENT`) &&
        !content.includes("BASELINE_ONLY") &&
        (parsed.meta?.toolSummary?.tools ?? []).some((name) => /skill_manage|skill_create|terminal|exec/i.test(String(name)));
    },
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
    [
      "agent",
      "--local",
      "--agent",
      agentId,
      "--to",
      routeTarget,
      "--session-id",
      sessionId,
      ...(modelOverride ? ["--model", modelOverride] : []),
      "--message",
      testCase.prompt,
      "--json",
      "--timeout",
      String(Math.ceil(maxMs / 1000)),
    ],
    {
      cwd: repoRoot,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    writeFileSync(stdoutPath, stdout);
    parsed = extractJson(stdout) ?? extractJson(stderr);
    if (parsed && !jsonSeenAt) {
      jsonSeenAt = Date.now();
    }
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
    let settled = false;
    let exitStatus = { code: null, signal: null };
    const settle = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(maxTimer);
      clearInterval(pollTimer);
      resolve(status);
    };
    const maxTimer = setTimeout(() => {
      killProcessGroup(child);
      setTimeout(() => settle(exitStatus), 5_000).unref();
    }, maxMs);
    const pollTimer = setInterval(() => {
      if (jsonSeenAt && Date.now() - jsonSeenAt >= killAfterJsonMs) {
        killProcessGroup(child);
        settle({ ...exitStatus, signal: exitStatus.signal ?? "json_seen" });
      }
    }, 250);
    child.on("exit", (code, signal) => {
      exitStatus = { code, signal };
      if (!jsonSeenAt) {
        settle(exitStatus);
      }
    });
    child.on("close", (code, signal) => {
      exitStatus = { code, signal };
      settle(exitStatus);
    });
    child.on("error", (error) => {
      settle({ code: 1, signal: `error:${error.code ?? error.message}` });
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
  modelOverride: modelOverride || null,
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
