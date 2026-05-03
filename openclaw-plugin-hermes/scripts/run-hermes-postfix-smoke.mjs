import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const repoRoot = existsSync("/root/work/openclaw-hermes-harness")
  ? "/root/work/openclaw-hermes-harness"
  : "/root/openclaw-hermes-harness";
const hermesAgentId = process.env.HERMES_BENCH_AGENT_ID ?? "ai-1111";

const cases = [
  {
    id: "basic",
    prompt: "请只回复 HERMES_POSTFIX_BASIC_OK",
  },
  {
    id: "write",
    prompt: "Create or overwrite /root/.openclaw/workspace/agent-loop-bench-fixtures-v2/postfix-write-hermes.txt with exactly HERMES_POSTFIX_WRITE_OK, then reply exactly HERMES_POSTFIX_WRITE_DONE",
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

for (const testCase of cases) {
  const sessionId = `hermes-postfix-${testCase.id}-${Date.now()}`;
  const child = spawnSync(
    "openclaw",
    ["agent", "--local", "--agent", hermesAgentId, "--session-id", sessionId, "--message", testCase.prompt, "--json", "--timeout", "180"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 240 * 1000,
      killSignal: "SIGKILL",
    },
  );
  const parsed = extractJson(child.stderr) ?? extractJson(child.stdout) ?? {};
  const meta = parsed.meta ?? {};
  console.log(JSON.stringify({
    caseId: testCase.id,
    sessionId,
    agentId: hermesAgentId,
    status: child.status,
    signal: child.signal,
    error: child.error?.message,
    durationMs: meta.durationMs,
    provider: meta.agentMeta?.provider,
    model: meta.agentMeta?.model,
    promptTokens: meta.agentMeta?.promptTokens,
    finalPromptText: meta.finalPromptText,
    visible: meta.finalAssistantVisibleText,
  }, null, 2));
}
