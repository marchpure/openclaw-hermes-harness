# Hermes WebUI Regression Suite

## Why this suite exists

Commit `8a9168674e9dfce73f60cfba6839219f0699d194` fixed a real WebUI chat response issue.

Later cleanup commits accidentally removed installed-runtime fallbacks in:

- `src/webui-event-bridge.ts`
- `src/agent-event-bridge.ts`

That broke Hermes event fan-out on the real OpenClaw installation used here, where the Gateway runtime shards live under:

- `/usr/lib/node_modules/openclaw/dist/gateway-request-scope-*.js`
- `/usr/lib/node_modules/openclaw/dist/agent-events-*.js`

The regression was not caught earlier because validation focused on:

- CLI/local attempt success
- ACP behavior
- harness-level mocked gateway callbacks

but did not include a hard regression asserting that an installed OpenClaw runtime without resolvable `openclaw/plugin-sdk/*` package paths still publishes WebUI/Gateway events correctly.

## Root cause of the regression

The cleanup removed global dist fallback lookups that are required on this machine:

- `webui-event-bridge.ts` stopped scanning `/usr/lib/node_modules/openclaw/dist`
- `agent-event-bridge.ts` stopped scanning `/usr/lib/node_modules/openclaw/dist`

Because `require.resolve("openclaw/plugin-sdk/agent-harness")` fails in this repo runtime, Hermes could no longer discover:

- `gateway-request-scope-*.js`
- `agent-events-*.js`

Result:

- Hermes still ran
- ACP still completed
- but WebUI/Gateway chat fan-out could disappear in the installed runtime path

## Fixed in current worktree

The installed-runtime fallbacks were restored in:

- `src/webui-event-bridge.ts`
- `src/agent-event-bridge.ts`

## Required regression coverage

This suite is split into three layers so future refactors do not regress WebUI behavior again.

### A. Installed-runtime compatibility

Purpose:

- Ensure Hermes can resolve OpenClaw Gateway bridge modules from the real installed dist layout.

Command:

```bash
node scripts/test-installed-openclaw-resolution.mjs
```

Pass criteria:

- source keeps `/usr/lib/node_modules/openclaw/dist` fallback
- installed `gateway-request-scope-*.js` bundle exports a scope reader
- installed `agent-events-*.js` bundle exports an event emitter

### B. Gateway attempt event bridge

Purpose:

- Ensure Hermes harness publishes lifecycle, thinking, tool, assistant, and chat-adjacent metadata through the Gateway event bridge contract.

Command:

```bash
npx tsx scripts/test-gateway-attempt-full.ts
```

Pass criteria:

- gateway attempt preserves `runId`
- gateway attempt preserves `sessionKey`
- assistant stream events are published
- thinking stream events are published
- tool stream events are published
- final assistant text and usage are preserved

### C. Real OpenClaw runtime validation

Purpose:

- Validate real OpenClaw + Hermes ACP + installed plugin behavior with no mock runtime.

Required cases:

1. `WEBUI-01` Hermes WebUI chat reply
   - Trigger a real WebUI/Gateway Hermes turn
   - Expect `agent:lifecycle:start`
   - Expect at least one `chat delta` or assistant stream
   - Expect `chat final`
   - Expect final text to match the requested marker

2. `WEBUI-02` Hermes write-file from WebUI path
   - Send a real Hermes task through OpenClaw
   - Write a workspace marker file
   - Verify host file exists after completion

3. `WEBUI-03` Hermes read-rule isolation
   - After write-file, run a new isolated session
   - Read a rule file and return only its marker
   - Must not leak previous write marker

4. `WEBUI-04` Hermes session isolation
   - Two new sessions with different markers
   - No cross-session leakage

5. `WEBUI-05` Hermes lifecycle completion
   - No tick-only behavior
   - Must emit lifecycle start/end or equivalent completion evidence

### D. Pi vs Hermes comparison guardrails

Purpose:

- Prevent invalid A/B comparisons.

Required checks before any success-rate/latency comparison:

1. Verify Pi lane provider is not Hermes
2. Verify Pi lane model is not `default`
3. Record session override state from `sessions.json`
4. Reject the comparison if `agent:main:main` still routes to Hermes

## Metrics to record on every run

### Functional correctness

- task success
- final assistant text
- host file evidence
- tool evidence
- isolation correctness

### Efficiency

- completion latency
- P50 / P95 latency across repeated runs
- tool count
- event count

### Reliability

- hard failure rate
- fake progress rate
- wrong-workspace rate
- cross-session contamination rate
- no-final/tick-only rate

## Minimal release gate

Before merging any Hermes runtime cleanup or simplification:

1. `node scripts/test-installed-openclaw-resolution.mjs`
2. `npx tsx scripts/test-gateway-attempt-full.ts`
3. real OpenClaw write/read isolation validation
4. verify current install still resolves Gateway bridge modules from installed dist

If any of the above fail, do not treat the change as behavior-preserving.
