import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = "/root/openclaw-hermes-harness";
const workspaceRoot = "/root/.openclaw/workspace";
const fixtureDir = join(workspaceRoot, "hermes-bench-matrix-fixtures");
const outRoot = join(repoRoot, "artifacts", "pi-hermes-bench-matrix");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(outRoot, runId);
mkdirSync(outDir, { recursive: true });
mkdirSync(fixtureDir, { recursive: true });

const runtimeDefaults = {
  pi: {
    id: "pi",
    label: "OpenClaw PI Runtime",
    agentId: "main",
    expectProvider: "model_square",
    expectModel: "doubao-seed-2-0-pro-260215",
  },
  hermes: {
    id: "hermes",
    label: "Hermes Runtime",
    agentId: "ai-1111",
    expectProvider: "hermes",
    expectModel: "default",
  },
};

const runtimes = process.env.BENCH_RUNTIMES
  ? process.env.BENCH_RUNTIMES.split(",").map((id) => runtimeDefaults[id.trim()]).filter(Boolean)
  : [runtimeDefaults.pi, runtimeDefaults.hermes];

const iterations = Number.parseInt(process.env.BENCH_ITERATIONS ?? "3", 10);

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function file(path) {
  return path.replace(/\\/g, "/");
}

function textBetween(start, end, value) {
  const a = value.indexOf(start);
  const b = value.indexOf(end, a + start.length);
  if (a < 0 || b < 0) return null;
  return value.slice(a + start.length, b);
}

function extractJson(text) {
  const trimmed = text.trim();
  const starts = [];
  const candidates = [];
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] === "{") starts.push(i);
  }
  for (let i = starts.length - 1; i >= 0; i -= 1) {
    const start = starts[i];
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = start; j < trimmed.length; j += 1) {
      const ch = trimmed[j];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }
      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{") {
        depth += 1;
        continue;
      }
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const raw = trimmed.slice(start, j + 1);
          try {
            const parsed = JSON.parse(raw);
            candidates.push(parsed);
          } catch {
            // Keep scanning other balanced slices.
          }
          break;
        }
      }
    }
  }
  return (
    candidates.find((item) => item?.meta?.finalAssistantVisibleText != null) ??
    candidates.find((item) => Array.isArray(item?.payloads)) ??
    candidates[0] ??
    null
  );
}

function getVisible(parsed) {
  return (
    parsed?.meta?.finalAssistantVisibleText ??
    parsed?.payloads?.map((item) => item?.text).filter(Boolean).join("\n") ??
    ""
  ).trim();
}

function getReasoning(parsed) {
  return (
    parsed?.meta?.finalAssistantReasoningText ??
    parsed?.payloads?.map((item) => item?.reasoning).filter(Boolean).join("\n") ??
    ""
  ).trim();
}

function getUsage(parsed) {
  return parsed?.meta?.agentMeta?.usage ?? null;
}

function getProvider(parsed) {
  return parsed?.meta?.agentMeta?.provider ?? parsed?.meta?.executionTrace?.winnerProvider ?? null;
}

function getModel(parsed) {
  return parsed?.meta?.agentMeta?.model ?? parsed?.meta?.executionTrace?.winnerModel ?? null;
}

function writeFixture(path, body) {
  ensureDir(join(path, ".."));
  writeFileSync(path, body, "utf8");
}

const cases = [
  {
    id: "L1-chat-marker",
    complexity: "light",
    category: "single_turn",
    prompt: (rt) => `只回复 ${rt.id.toUpperCase()}_LIGHT_OK`,
    check: (rt, { visible }) => ({
      ok: visible === `${rt.id.toUpperCase()}_LIGHT_OK`,
      expected: `${rt.id.toUpperCase()}_LIGHT_OK`,
      actual: visible,
    }),
  },
  {
    id: "L2-file-write",
    complexity: "light",
    category: "filesystem",
    before: (rt) => {
      rmSync(join(fixtureDir, `write-${rt.id}.txt`), { force: true });
    },
    prompt: (rt) => {
      const target = file(join(fixtureDir, `write-${rt.id}.txt`));
      return `创建或覆盖文件 ${target}，内容必须且只能是 ${rt.id.toUpperCase()}_FILE_OK。完成后只回复 ${rt.id.toUpperCase()}_FILE_DONE`;
    },
    check: (rt, { visible }) => {
      const target = join(fixtureDir, `write-${rt.id}.txt`);
      const content = existsSync(target) ? readFileSync(target, "utf8").trim() : "";
      return {
        ok: visible === `${rt.id.toUpperCase()}_FILE_DONE` && content === `${rt.id.toUpperCase()}_FILE_OK`,
        file: target,
        content,
      };
    },
  },
  {
    id: "L3-shell-python",
    complexity: "light",
    category: "command_exec",
    before: (rt) => {
      rmSync(join(fixtureDir, `numbers-${rt.id}.txt`), { force: true });
    },
    prompt: (rt) => {
      const target = file(join(fixtureDir, `numbers-${rt.id}.txt`));
      return [
        `使用 shell 或 python 在 ${target} 中写入三行：`,
        "1",
        "4",
        "9",
        `完成后只回复 ${rt.id.toUpperCase()}_SCRIPT_DONE:14`,
      ].join("\n");
    },
    check: (rt, { visible }) => {
      const target = join(fixtureDir, `numbers-${rt.id}.txt`);
      const lines = existsSync(target) ? readFileSync(target, "utf8").trim().split(/\r?\n/) : [];
      const sum = lines.map((n) => Number.parseInt(n, 10)).reduce((acc, n) => acc + n, 0);
      return {
        ok: visible === `${rt.id.toUpperCase()}_SCRIPT_DONE:14` && sum === 14,
        file: target,
        lines,
        sum,
      };
    },
  },
  {
    id: "M1-read-follow-rule",
    complexity: "medium",
    category: "context_read",
    before: (rt) => {
      writeFixture(
        join(fixtureDir, `rule-${rt.id}.md`),
        `请只回复 ${rt.id.toUpperCase()}_RULE_PASS，不要添加其它内容。\n`,
      );
    },
    prompt: (rt) => `读取 ${file(join(fixtureDir, `rule-${rt.id}.md`))} 并严格按其中要求回复。`,
    check: (rt, { visible }) => ({
      ok: visible === `${rt.id.toUpperCase()}_RULE_PASS`,
      actual: visible,
    }),
  },
  {
    id: "M2-bugfix-code",
    complexity: "medium",
    category: "code_edit",
    before: (_rt) => {
      writeFixture(
        join(fixtureDir, "calc_bug.py"),
        [
          "def score(values):",
          "    total = 0",
          "    for value in values:",
          "        total += value",
          "    return total / (len(values) + 1)",
          "",
          "if __name__ == '__main__':",
          "    print(score([2, 4, 6]))",
          "",
        ].join("\n"),
      );
    },
    prompt: () => {
      const target = file(join(fixtureDir, "calc_bug.py"));
      return [
        `修复文件 ${target} 中的 bug，使其输出 4.0。`,
        "必须直接修改该文件。",
        "完成后运行它验证，并只回复 FIXED:4.0",
      ].join("\n");
    },
    check: (_rt, { visible }) => {
      const target = join(fixtureDir, "calc_bug.py");
      const content = readFileSync(target, "utf8");
      const verify = runLocalCheck("python3", [target]);
      const output = `${verify.stdout ?? ""}${verify.stderr ?? ""}`.trim();
      const ok =
        visible === "FIXED:4.0" &&
        verify.status === 0 &&
        output.endsWith("4.0") &&
        !content.includes("len(values) + 1");
      return { ok, file: target, output, status: verify.status };
    },
  },
  {
    id: "M3-long-context-summary",
    complexity: "medium",
    category: "long_context",
    before: () => {
      const payload = Array.from({ length: 80 }, (_, i) => `SECTION ${i + 1}: key_${i + 1}=value_${(i + 1) * 3}`);
      payload.push("FINAL_ANSWER=VALUE_237");
      writeFixture(join(fixtureDir, "long-context.txt"), payload.join("\n"));
    },
    prompt: () => {
      const target = file(join(fixtureDir, "long-context.txt"));
      return [
        `读取 ${target}，找到 FINAL_ANSWER 对应的值。`,
        "只回复 ANSWER=<value>。",
      ].join("\n");
    },
    check: (_rt, { visible }) => ({
      ok: visible === "ANSWER=VALUE_237",
      actual: visible,
    }),
  },
  {
    id: "H1-multistep-plan-exec",
    complexity: "heavy",
    category: "multi_step",
    before: (rt) => {
      rmSync(join(fixtureDir, `report-${rt.id}.json`), { force: true });
    },
    prompt: (rt) => {
      const target = file(join(fixtureDir, `report-${rt.id}.json`));
      return [
        "完成三个步骤：",
        "1. 统计 1 到 20 的平方和。",
        "2. 把结果写入 JSON 文件，键名为 sumSquares。",
        "3. 再读取该文件确认内容。",
        `目标文件：${target}`,
        "最后只回复 VERIFIED_SUM=2870",
      ].join("\n");
    },
    check: (rt, { visible }) => {
      const target = join(fixtureDir, `report-${rt.id}.json`);
      const parsed = existsSync(target) ? JSON.parse(readFileSync(target, "utf8")) : {};
      return {
        ok: visible === "VERIFIED_SUM=2870" && parsed.sumSquares === 2870,
        file: target,
        parsed,
      };
    },
  },
  {
    id: "H2-browser-availability",
    complexity: "heavy",
    category: "browser_probe",
    prompt: () => [
      "检查当前环境是否存在可用浏览器能力。",
      "如果可以实际访问浏览器或远程 CDP，请只回复 BROWSER=YES。",
      "如果当前环境没有可用浏览器能力，请只回复 BROWSER=NO。",
      "不要解释。",
    ].join("\n"),
    check: (_rt, { visible }) => ({
      ok: visible === "BROWSER=YES" || visible === "BROWSER=NO",
      actual: visible,
    }),
  },
  {
    id: "H3-session-followup",
    complexity: "heavy",
    category: "multi_turn",
    sequence: [
      {
        prompt: "记住口令 ALPHA-BETA-42。只回复 MEMORIZED。",
        expectVisible: "MEMORIZED",
      },
      {
        prompt: "只回复上一个回合让我记住的口令，不要解释。",
        expectVisible: "ALPHA-BETA-42",
      },
    ],
    checkSequence: (_rt, steps) => ({
      ok: steps.length === 2 && steps[0].visible === "MEMORIZED" && steps[1].visible === "ALPHA-BETA-42",
      steps: steps.map((step) => ({ visible: step.visible, durationMs: step.durationMs })),
    }),
  },
];

function runOne(rt, prompt, sessionId) {
  const started = Date.now();
  const child = spawnSync(
    "openclaw",
    ["agent", "--local", "--agent", rt.agentId, "--session-id", sessionId, "--message", prompt, "--json", "--timeout", "240"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 30 * 1024 * 1024,
      timeout: 300 * 1000,
      killSignal: "SIGKILL",
    },
  );
  const durationMs = Date.now() - started;
  const parsed = extractJson(child.stderr) ?? extractJson(child.stdout) ?? {};
  return {
    durationMs,
    status: child.status,
    signal: child.signal ?? null,
    error: child.error ? { code: child.error.code ?? null, message: child.error.message } : null,
    stdout: child.stdout,
    stderr: child.stderr,
    parsed,
    visible: getVisible(parsed),
    reasoning: getReasoning(parsed),
    usage: getUsage(parsed),
    provider: getProvider(parsed),
    model: getModel(parsed),
  };
}

function runLocalCheck(command, args) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60 * 1000,
    killSignal: "SIGKILL",
  });
}

function persistProgress(results) {
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(buildSummary(results), null, 2));
}

function buildSummary(results) {
  const grouped = {};
  for (const rt of runtimes) {
    const rows = results.filter((row) => row.runtime === rt.id && row.phase === "final");
    const passed = rows.filter((row) => row.ok && row.providerOk).length;
    grouped[rt.id] = {
      total: rows.length,
      passed,
      providerMatched: rows.filter((row) => row.providerOk).length,
      avgMs: rows.length ? Math.round(rows.reduce((acc, row) => acc + row.durationMs, 0) / rows.length) : 0,
      p95Ms: percentile(rows.map((row) => row.durationMs), 95),
      failures: rows.filter((row) => !(row.ok && row.providerOk)).map((row) => ({
        caseId: row.caseId,
        iteration: row.iteration,
        reason: row.failureReason,
      })),
    };
  }
  return { runId, outDir, iterations, runtimes, grouped };
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

const results = [];

for (const rt of runtimes) {
  for (const benchCase of cases) {
    for (let iteration = 1; iteration <= iterations; iteration += 1) {
      benchCase.before?.(rt, iteration);
      if (benchCase.sequence) {
        const sessionId = `${rt.id}-${benchCase.id}-${iteration}-${runId}`.replace(/[^a-zA-Z0-9_-]/g, "-");
        const steps = [];
        for (let index = 0; index < benchCase.sequence.length; index += 1) {
          const turn = benchCase.sequence[index];
          const step = runOne(rt, turn.prompt, sessionId);
          writeFileSync(join(outDir, `${rt.id}-${benchCase.id}-${iteration}-step${index + 1}.stdout.txt`), step.stdout);
          writeFileSync(join(outDir, `${rt.id}-${benchCase.id}-${iteration}-step${index + 1}.stderr.txt`), step.stderr);
          steps.push({
            visible: step.visible,
            durationMs: step.durationMs,
            provider: step.provider,
            model: step.model,
            status: step.status,
          });
        }
        const sequenceCheck = benchCase.checkSequence(rt, steps);
        const provider = steps[steps.length - 1]?.provider ?? null;
        const model = steps[steps.length - 1]?.model ?? null;
        const durationMs = steps.reduce((acc, step) => acc + step.durationMs, 0);
        const record = {
          runtime: rt.id,
          runtimeLabel: rt.label,
          phase: "final",
          caseId: benchCase.id,
          complexity: benchCase.complexity,
          category: benchCase.category,
          iteration,
          durationMs,
          provider,
          model,
          providerOk: provider === rt.expectProvider,
          modelObserved: model,
          ok: sequenceCheck.ok,
          visible: steps.map((step) => step.visible).join(" | "),
          check: sequenceCheck,
          failureReason: sequenceCheck.ok ? null : "sequence_check_failed",
        };
        results.push(record);
        persistProgress(results);
        continue;
      }

      const sessionId = `${rt.id}-${benchCase.id}-${iteration}-${runId}`.replace(/[^a-zA-Z0-9_-]/g, "-");
      const run = runOne(rt, benchCase.prompt(rt, iteration), sessionId);
      const check = benchCase.check(rt, run, iteration);
      writeFileSync(join(outDir, `${rt.id}-${benchCase.id}-${iteration}.stdout.txt`), run.stdout);
      writeFileSync(join(outDir, `${rt.id}-${benchCase.id}-${iteration}.stderr.txt`), run.stderr);
      results.push({
        runtime: rt.id,
        runtimeLabel: rt.label,
        phase: "final",
        caseId: benchCase.id,
        complexity: benchCase.complexity,
        category: benchCase.category,
        iteration,
        durationMs: run.durationMs,
        provider: run.provider,
        model: run.model,
        providerOk: run.provider === rt.expectProvider,
        modelObserved: run.model,
        ok: check.ok,
        visible: run.visible,
        reasoning: run.reasoning,
        usage: run.usage,
        status: run.status,
        signal: run.signal,
        error: run.error,
        check,
        failureReason: check.ok ? null : "check_failed",
      });
      persistProgress(results);
    }
  }
}

const summary = buildSummary(results);
console.log(JSON.stringify(summary, null, 2));
