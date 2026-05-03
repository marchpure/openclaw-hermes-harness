import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = existsSync("/root/work/openclaw-hermes-harness")
  ? "/root/work/openclaw-hermes-harness"
  : "/root/openclaw-hermes-harness";
const workspace = "/root/.openclaw/workspace";
const fixtureDir = join(workspace, "agent-loop-bench-fixtures-v2");
const outRoot = join(repoRoot, "artifacts/pi-hermes-bench-v2");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(outRoot, runId);
mkdirSync(outDir, { recursive: true });
mkdirSync(fixtureDir, { recursive: true });

const runtimes = [
  {
    id: "pi",
    agentId: process.env.PI_BENCH_AGENT_ID ?? "main",
    expectProvider: "ark",
    expectModel: "doubao-seed-2-0-pro-260215",
    enabled: process.env.RUN_PI_BENCH === "1",
  },
  {
    id: "hermes",
    agentId: process.env.HERMES_BENCH_AGENT_ID ?? "ai-1111",
    expectProvider: "hermes",
    expectModel: "default",
    enabled: true,
  },
];

const cases = [
  {
    id: "CHAT-01-basic",
    prompt: (rt) => `请只回复 ${rt.id.toUpperCase()}_BASIC_OK`,
    check: (rt, parsed) => ({
      ok: parsed.visible === `${rt.id.toUpperCase()}_BASIC_OK`,
      expected: `${rt.id.toUpperCase()}_BASIC_OK`,
    }),
  },
  {
    id: "FS-01-write-file",
    before: (rt) => {
      rmSync(join(fixtureDir, `write-${rt.id}.txt`), { force: true });
    },
    prompt: (rt) =>
      `Create or overwrite ${join(fixtureDir, `write-${rt.id}.txt`)} with exactly ${rt.id.toUpperCase()}_WRITE_OK, then reply exactly ${rt.id.toUpperCase()}_WRITE_DONE`,
    check: (rt, parsed) => {
      const target = join(fixtureDir, `write-${rt.id}.txt`);
      const exists = existsSync(target);
      const content = exists ? readFileSync(target, "utf8").trim() : "";
      return {
        ok: parsed.visible === `${rt.id.toUpperCase()}_WRITE_DONE` && exists && content === `${rt.id.toUpperCase()}_WRITE_OK`,
        target,
        exists,
        content,
      };
    },
  },
  {
    id: "FS-02-read-rule",
    before: (rt) => {
      writeFileSync(join(fixtureDir, `rule-${rt.id}.md`), `Reply exactly ${rt.id.toUpperCase()}_RULE_OK and no other text.\n`);
    },
    prompt: (rt) =>
      `Read ${join(fixtureDir, `rule-${rt.id}.md`)} and follow its instruction. Reply with the marker only.`,
    check: (rt, parsed) => ({
      ok: parsed.visible === `${rt.id.toUpperCase()}_RULE_OK`,
      expected: `${rt.id.toUpperCase()}_RULE_OK`,
    }),
  },
  {
    id: "CTX-01-user-skill-awareness",
    prompt: () =>
      "请回答两行：第一行只回答 YES_USER_MD 或 NO_USER_MD；第二行只列出 3 个当前可见 skill 名称，用英文逗号分隔，不要解释。",
    check: (_rt, parsed) => {
      const lines = parsed.visible.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const hasUser = lines[0] === "YES_USER_MD";
      const skills = (lines[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      return {
        ok: hasUser && skills.length >= 3,
        hasUser,
        skills,
      };
    },
  },
];

function extractJson(text) {
  if (!text) return null;
  const idx = text.lastIndexOf("\n{");
  const firstJson = text.indexOf("{");
  if (idx < 0 && firstJson < 0) return null;
  const raw = (idx >= 0 ? text.slice(idx + 1) : text.slice(firstJson)).trim();
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function buildSummary(results) {
  return {
    runId,
    outDir,
    totals: Object.fromEntries(
      runtimes.map((rt) => {
        const rows = results.filter((r) => r.runtime === rt.id);
        return [
          rt.id,
          {
            total: rows.length,
            passed: rows.filter((r) => r.ok && r.providerOk).length,
            avgMs: rows.length ? Math.round(rows.reduce((sum, r) => sum + r.durationMs, 0) / rows.length) : 0,
          },
        ];
      }),
    ),
    results,
  };
}

function persistProgress(results) {
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(buildSummary(results), null, 2));
}

function runCase(rt, testCase, iteration = 1) {
  testCase.before?.(rt);
  const sessionId = `${rt.id}-${testCase.id}-${iteration}-${runId}`.replace(/[^a-zA-Z0-9_-]/g, "-");
  const prompt = testCase.prompt(rt);
  console.error(`[bench] start runtime=${rt.id} case=${testCase.id} session=${sessionId}`);
  const started = Date.now();
  const child = spawnSync(
    "openclaw",
    ["agent", "--local", "--agent", rt.agentId, "--session-id", sessionId, "--message", prompt, "--json", "--timeout", "180"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 240 * 1000,
      killSignal: "SIGKILL",
    },
  );
  const durationMs = Date.now() - started;
  const parsed = extractJson(child.stderr) ?? extractJson(child.stdout) ?? {};
  const meta = parsed.meta ?? {};
  const visible = meta.finalAssistantVisibleText ?? parsed.payloads?.map((p) => p.text).join("\n") ?? "";
  const provider = meta.agentMeta?.provider ?? meta.executionTrace?.winnerProvider ?? null;
  const model = meta.agentMeta?.model ?? meta.executionTrace?.winnerModel ?? null;
  const usage = meta.agentMeta?.usage ?? null;
  const check = testCase.check(rt, { parsed, visible, provider, model, usage });
  const record = {
    runtime: rt.id,
    agentId: rt.agentId,
    caseId: testCase.id,
    iteration,
    sessionId,
    prompt,
    durationMs,
    status: child.status,
    signal: child.signal ?? null,
    error: child.error ? {
      code: child.error.code ?? null,
      message: child.error.message,
    } : null,
    provider,
    model,
    visible,
    usage,
    providerOk: provider === rt.expectProvider,
    modelObserved: model,
    ok: check.ok,
    check,
  };
  writeFileSync(join(outDir, `${rt.id}-${testCase.id}-${iteration}.stdout.txt`), child.stdout);
  writeFileSync(join(outDir, `${rt.id}-${testCase.id}-${iteration}.stderr.txt`), child.stderr);
  console.error(
    `[bench] done runtime=${rt.id} case=${testCase.id} status=${child.status} signal=${child.signal ?? "none"} durationMs=${durationMs}`,
  );
  return record;
}

const results = [];
for (const rt of runtimes) {
  if (!rt.enabled) continue;
  for (const testCase of cases) {
    results.push(runCase(rt, testCase, 1));
    persistProgress(results);
  }
}

const summary = buildSummary(results);
console.log(JSON.stringify(summary, null, 2));
