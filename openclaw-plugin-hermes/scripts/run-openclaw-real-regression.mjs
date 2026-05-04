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
const effectiveModelOverride =
  modelOverride || (runtimeId === "hermes" ? "hermes/default" : "");
const maxMs = Number(process.env.REGRESSION_MAX_MS ?? 90_000);
const killAfterJsonMs = Number(process.env.REGRESSION_KILL_AFTER_JSON_MS ?? 3_000);
const retries = Number(process.env.REGRESSION_RETRIES ?? 1);
const retryDelayMs = Number(process.env.REGRESSION_RETRY_DELAY_MS ?? 5_000);
const repeat = Math.max(1, Number(process.env.REGRESSION_REPEAT ?? 1));
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
const contextUserMarker = `${runtimeId.toUpperCase()}_USER_CONTEXT_${runTag}`;
const contextAgentsMarker = `${runtimeId.toUpperCase()}_AGENTS_CONTEXT_${runTag}`;
const projectedSkillName = `${runtimeId}-real-projected-skill-${runTag}`;
const projectedSkillDir = join(workspace, "skills", projectedSkillName);
const projectedSkillFile = join(projectedSkillDir, "SKILL.md");
const projectedSkillMarker = `${runtimeId.toUpperCase()}_PROJECTED_SKILL_${runTag}`;
const sameSessionMarker = `${runtimeId.toUpperCase()}_SAME_SESSION_${runTag}`;
const isolatedSessionMarker = `${runtimeId.toUpperCase()}_ISOLATED_SESSION_${runTag}`;
const sameSessionId = `${runtimeId}-real-same-session-${runTag}`;
const isolatedSessionIdA = `${runtimeId}-real-isolated-a-${runTag}`;
const isolatedSessionIdB = `${runtimeId}-real-isolated-b-${runTag}`;

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function writeWorkspaceContextFixtures() {
  ensureDir(workspace);
  ensureDir(projectedSkillDir);
  writeFileSync(
    join(workspace, "USER.md"),
    [
      `# Hermes regression user profile`,
      ``,
      `Mandatory validation marker: ${contextUserMarker}`,
      `If asked whether USER.md is visible, answer with this exact marker.`,
      ``,
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(workspace, "AGENTS.md"),
    [
      `# Hermes regression workspace instructions`,
      ``,
      `Mandatory validation marker: ${contextAgentsMarker}`,
      `If asked whether AGENTS.md is visible, answer with this exact marker.`,
      ``,
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    projectedSkillFile,
    [
      `---`,
      `name: ${projectedSkillName}`,
      `description: real projected workspace skill regression`,
      `---`,
      `# ${projectedSkillName}`,
      ``,
      `When this skill is used, reply with ${projectedSkillMarker}.`,
      `This skill exists only as a workspace SKILL.md fixture and must be projected into Hermes.`,
      ``,
    ].join("\n"),
    "utf8",
  );
}

writeWorkspaceContextFixtures();

const cases = [
  {
    id: "model-route",
    group: "routing",
    prompt: `这是 /model hermes 后的模型路由等价验证。请只回复 ${runtimeId.toUpperCase()}_MODEL_ROUTE_OK。`,
    check: (_parsed, visible) => visible.trim() === `${runtimeId.toUpperCase()}_MODEL_ROUTE_OK`,
  },
  {
    id: "basic",
    group: "chat",
    prompt: `请只回复 ${runtimeId.toUpperCase()}_BASIC_OK`,
    check: (_parsed, visible) => visible.trim() === `${runtimeId.toUpperCase()}_BASIC_OK`,
  },
  {
    id: "session-status-mcp",
    group: "mcp",
    prompt: `请调用当前可用的 OpenClaw session_status/session MCP 工具查看当前会话状态，然后只回复 ${runtimeId.toUpperCase()}_SESSION_STATUS_OK。`,
    check: (parsed, visible) =>
      visible.includes(`${runtimeId.toUpperCase()}_SESSION_STATUS_OK`) &&
      (parsed.meta?.toolSummary?.tools ?? []).some((name) => String(name).includes("session")),
  },
  {
    id: "workspace-write",
    group: "workspace",
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
    group: "workspace",
    before: () => writeFileSync(join(fixtureDir, `${runtimeId}-read-source.txt`), `${runtimeId.toUpperCase()}_READ_SOURCE_OK\n`),
    prompt: `请读取这个绝对路径文件的内容：${join(fixtureDir, `${runtimeId}-read-source.txt`)}，然后只回复文件中的完整标记。`,
    check: (_parsed, visible) => visible.trim() === `${runtimeId.toUpperCase()}_READ_SOURCE_OK`,
  },
  {
    id: "workspace-list",
    group: "workspace",
    before: () => {
      writeFileSync(join(fixtureDir, `${runtimeId}-list-a.txt`), "A\n");
      writeFileSync(join(fixtureDir, `${runtimeId}-list-b.txt`), "B\n");
    },
    prompt: `请列出这个绝对路径目录中的文件名：${fixtureDir}。确认同时存在 ${runtimeId}-list-a.txt 和 ${runtimeId}-list-b.txt 后，只回复 ${runtimeId.toUpperCase()}_LIST_OK。`,
    check: (_parsed, visible) => visible.includes(`${runtimeId.toUpperCase()}_LIST_OK`),
  },
  {
    id: "compute-use",
    group: "toolset",
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
    id: "context-user-agents",
    group: "context",
    before: () => writeWorkspaceContextFixtures(),
    prompt: `请验证当前 Hermes/OpenClaw 上下文是否能看到 workspace 的 USER.md 和 AGENTS.md。只回复两行：第一行是 USER.md 中的 mandatory marker，第二行是 AGENTS.md 中的 mandatory marker。`,
    check: (_parsed, visible) => {
      const normalized = visible.trim();
      return normalized.includes(contextUserMarker) && normalized.includes(contextAgentsMarker);
    },
  },
  {
    id: "workspace-skill-execute",
    group: "skills",
    before: () => writeWorkspaceContextFixtures(),
    prompt: `请使用当前 workspace skill：${projectedSkillName}。必须先读取或遵循该 skill 的 SKILL.md 指令，然后只回复该 skill 要求的 marker。`,
    check: (_parsed, visible) => visible.trim() === projectedSkillMarker,
  },
  {
    id: "same-session-step1",
    group: "session",
    sessionId: ({ iteration }) => `${sameSessionId}-i${iteration}`,
    prompt: `请在本会话中记住这个 marker：${sameSessionMarker}。不要写文件。只回复 ${runtimeId.toUpperCase()}_SAME_SESSION_STEP1_OK。`,
    check: (_parsed, visible) => visible.trim() === `${runtimeId.toUpperCase()}_SAME_SESSION_STEP1_OK`,
  },
  {
    id: "same-session-step2",
    group: "session",
    sessionId: ({ iteration }) => `${sameSessionId}-i${iteration}`,
    prompt: `请基于同一个 session 的对话历史，回忆上一步要求你记住的 marker。只回复该 marker，不要解释。`,
    check: (_parsed, visible) => visible.trim() === sameSessionMarker,
  },
  {
    id: "session-isolation-a",
    group: "session",
    sessionId: ({ iteration }) => `${isolatedSessionIdA}-i${iteration}`,
    prompt: `请在这个 session A 中记住私有 marker：${isolatedSessionMarker}。不要写文件。只回复 ${runtimeId.toUpperCase()}_ISOLATION_A_OK。`,
    check: (_parsed, visible) => visible.trim() === `${runtimeId.toUpperCase()}_ISOLATION_A_OK`,
  },
  {
    id: "session-isolation-b",
    group: "session",
    sessionId: ({ iteration }) => `${isolatedSessionIdB}-i${iteration}`,
    prompt: `这是全新的 session B。请不要读取文件，也不要猜测其他 session 的内容。请回答你是否知道 session A 的私有 marker：如果不知道，只回复 ${runtimeId.toUpperCase()}_ISOLATION_B_OK；如果知道，请回复 ${runtimeId.toUpperCase()}_ISOLATION_LEAK。`,
    check: (_parsed, visible) =>
      visible.trim() === `${runtimeId.toUpperCase()}_ISOLATION_B_OK` &&
      !visible.includes(isolatedSessionMarker) &&
      !visible.includes(`${runtimeId.toUpperCase()}_ISOLATION_LEAK`),
  },
  {
    id: "agents-list-mcp",
    group: "mcp",
    prompt: `请调用当前可用的 OpenClaw agents_list/agents MCP 工具查看 agent 列表。确认工具调用成功且返回中能看到 ${agentId}、main 或任意可用 agent id 后，只回复 ${runtimeId.toUpperCase()}_AGENTS_OK。如果工具调用成功但列表策略不包含 ${agentId} 或 main，请以 ${runtimeId.toUpperCase()}_AGENTS_DIAG 结尾并简要说明返回的 agent id。`,
    check: (parsed, visible) =>
      visible.includes(`${runtimeId.toUpperCase()}_AGENTS_OK`) &&
      (parsed.meta?.toolSummary?.tools ?? []).some((name) => /agents/i.test(String(name))),
    diagnostic: (parsed, visible) =>
      (visible.includes(`${runtimeId.toUpperCase()}_AGENTS_DIAG`) ||
        /Identity Plugin|Session Gate|未认证|login|TIP/i.test(visible)) &&
      (parsed.meta?.toolSummary?.tools ?? []).some((name) => /agents/i.test(String(name))),
  },
  {
    id: "sessions-list-mcp",
    group: "mcp",
    prompt: `请调用当前可用的 OpenClaw sessions_list/sessions MCP 工具查看当前 agent session 列表，然后只回复 ${runtimeId.toUpperCase()}_SESSIONS_OK。`,
    check: (parsed, visible) =>
      visible.includes(`${runtimeId.toUpperCase()}_SESSIONS_OK`) &&
      (parsed.meta?.toolSummary?.tools ?? []).some((name) => /sessions/i.test(String(name))),
  },
  {
    id: "web-fetch-mcp",
    group: "toolset",
    prompt: `请调用当前可用的 web_fetch 或 browser MCP 工具访问 https://example.com 并确认页面可达，然后只回复 ${runtimeId.toUpperCase()}_WEB_OK。`,
    check: (parsed, visible) =>
      visible.includes(`${runtimeId.toUpperCase()}_WEB_OK`) &&
      (parsed.meta?.toolSummary?.tools ?? []).some((name) => /web|browser/i.test(String(name))),
  },
  {
    id: "browser-status-mcp",
    group: "toolset",
    prompt: `请调用当前可用的 browser MCP 工具查看浏览器状态或启动状态，然后只回复 ${runtimeId.toUpperCase()}_BROWSER_STATUS_OK。`,
    check: (parsed, visible) =>
      visible.includes(`${runtimeId.toUpperCase()}_BROWSER_STATUS_OK`) &&
      (parsed.meta?.toolSummary?.tools ?? []).some((name) => /browser/i.test(String(name))),
  },
  {
    id: "mcp-toolset-breadth",
    group: "mcp",
    prompt: `请连续调用至少两个不同的 OpenClaw MCP 工具，优先选择 session/agents 与 browser 或 web_fetch。确认 MCP bridge 能调通多个工具后，只回复 ${runtimeId.toUpperCase()}_MCP_BREADTH_OK。`,
    check: (parsed, visible) => {
      const tools = (parsed.meta?.toolSummary?.tools ?? []).map(String);
      const mcpTools = new Set(tools.filter((name) => /^mcp_openclaw_/i.test(name)).map((name) => name.split(/\s+/)[0]));
      return visible.includes(`${runtimeId.toUpperCase()}_MCP_BREADTH_OK`) && mcpTools.size >= 2;
    },
  },
  {
    id: "p0-skill-visibility",
    group: "skills",
    prompt: `请检查当前可见的 OpenClaw P0 skills/capabilities，确认 browser 或 browser-use、computer-use、byted-web-search 或 web_search、byted-seedream-image-generate、byted-seedance-video-generate、arkdrive-netdisk 至少有 5 项可见。不要执行图片或视频生成。确认后只回复 ${runtimeId.toUpperCase()}_P0_SKILLS_OK。`,
    check: (_parsed, visible) => visible.includes(`${runtimeId.toUpperCase()}_P0_SKILLS_OK`),
  },
  {
    id: "feishu-tool-visibility-mcp",
    group: "feishu",
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
    group: "feishu",
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
    group: "autoskill",
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
    group: "autoskill",
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

function resolveCaseSessionId(testCase, attempt, iteration) {
  if (typeof testCase.sessionId === "function") {
    return testCase.sessionId({ attempt, iteration });
  }
  if (typeof testCase.sessionId === "string" && testCase.sessionId.trim()) {
    return testCase.sessionId;
  }
  return `${runtimeId}-real-${testCase.id}-i${iteration}-a${attempt}-${Date.now()}`;
}

async function runCaseAttempt(testCase, attempt, iteration) {
  if (attempt === 1) {
    testCase.before?.({ attempt, iteration });
  }
  const sessionId = resolveCaseSessionId(testCase, attempt, iteration);
  const routeTarget = `${routeBase}${String(results.length + 1).padStart(4, "0")}${String(attempt).padStart(2, "0")}`;
  const stderrPath = join(outDir, `${testCase.id}.iteration-${iteration}.attempt-${attempt}.stderr.txt`);
  const stdoutPath = join(outDir, `${testCase.id}.iteration-${iteration}.attempt-${attempt}.stdout.txt`);
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
      ...(effectiveModelOverride ? ["--model", effectiveModelOverride] : []),
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
    group: testCase.group ?? "default",
    iteration,
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

async function runCase(testCase, iteration) {
  const attempts = [];
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    const record = await runCaseAttempt(testCase, attempt, iteration);
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
for (let iteration = 1; iteration <= repeat; iteration += 1) {
  for (const testCase of cases) {
    if (selectedCaseIds.size > 0 && !selectedCaseIds.has(testCase.id)) {
      continue;
    }
    console.error(`[regression] start iteration=${iteration}/${repeat} ${testCase.id}`);
    const record = await runCase(testCase, iteration);
    results.push(record);
    writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
    console.error(`[regression] done iteration=${iteration}/${repeat} ${testCase.id} ok=${record.ok} durationMs=${record.durationMs} signal=${record.process.signal ?? "none"}`);
  }
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function buildStats(rows) {
  const durations = rows.map((row) => row.durationMs).filter((value) => Number.isFinite(value));
  return {
    total: rows.length,
    passed: rows.filter((row) => row.ok).length,
    diagnostics: rows.filter((row) => row.diagnostic).length,
    successRate: rows.length ? rows.filter((row) => row.ok).length / rows.length : 0,
    avgDurationMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
    p50DurationMs: percentile(durations, 50),
    p95DurationMs: percentile(durations, 95),
    minDurationMs: durations.length ? Math.min(...durations) : 0,
    maxDurationMs: durations.length ? Math.max(...durations) : 0,
  };
}

function groupBy(rows, keyFn) {
  const grouped = {};
  for (const row of rows) {
    const key = keyFn(row);
    (grouped[key] ??= []).push(row);
  }
  return grouped;
}

const byCase = Object.fromEntries(
  Object.entries(groupBy(results, (row) => row.caseId)).map(([key, rows]) => [key, buildStats(rows)]),
);
const byGroup = Object.fromEntries(
  Object.entries(groupBy(results, (row) => row.group ?? "default")).map(([key, rows]) => [key, buildStats(rows)]),
);

const summary = {
  runId,
  outDir,
  runtimeId,
  agentId,
  expectProvider,
  expectModel,
  modelOverride: effectiveModelOverride || null,
  retries,
  repeat,
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
  byCase,
  byGroup,
  results,
};
writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
