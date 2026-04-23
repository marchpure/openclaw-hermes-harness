import { spawnSync } from "node:child_process";

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
  const idx = text.lastIndexOf("\n{");
  const raw = (idx >= 0 ? text.slice(idx + 1) : text.slice(text.indexOf("{"))).trim();
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
    ["agent", "--local", "--agent", "hermes-bench", "--session-id", sessionId, "--message", testCase.prompt, "--json", "--timeout", "180"],
    {
      cwd: "/root/openclaw-hermes-harness",
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  const parsed = extractJson(child.stderr) ?? extractJson(child.stdout) ?? {};
  const meta = parsed.meta ?? {};
  console.log(JSON.stringify({
    caseId: testCase.id,
    sessionId,
    durationMs: meta.durationMs,
    provider: meta.agentMeta?.provider,
    model: meta.agentMeta?.model,
    promptTokens: meta.agentMeta?.promptTokens,
    finalPromptText: meta.finalPromptText,
    visible: meta.finalAssistantVisibleText,
  }, null, 2));
}
