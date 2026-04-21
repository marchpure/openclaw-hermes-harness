# Hermes Runtime Regression Notes

Date: 2026-04-21
Branch: hermes-runtime-clean

## Scope

This regression pass covers four layers:

1. Plugin-unit / projection behavior
2. ACP transport behavior
3. Replaced stock OpenClaw Hermes plugin behavior
4. Product-adjacent OpenClaw CLI / gateway smoke

## Verified

### 1. Projection behavior

Commands run:

```bash
npx tsc
npx tsx scripts/test-projection.ts
npx tsx scripts/test-runtime-regression.ts
```

Verified outcomes:

- task-scoped execenv is materialized
- workspace isolation changes session binding hash
- different workspaces expose different projected skills
- host-backed skills like `browser` and `feishu` are filtered
- bootstrap prompt does not advertise filtered host-backed skills
- binding registry lifecycle works (`write/read/clear`)

### 2. ACP behavior

Commands run:

```bash
npx tsx test-e2e.ts
npx tsx scripts/test-runtime-regression.ts
```

Verified outcomes:

- ACP initialize works
- `session/new` works
- `session/prompt` works
- `session/resume` works against the local Hermes ACP server
- resumed session id matches original session id

### 3. Replaced stock OpenClaw Hermes plugin

Local stock plugin path replaced:

```text
openclaw/dist-runtime/extensions/hermes
```

Backup created at:

```text
openclaw/dist-runtime/extensions/hermes.bak-20260421-124520
```

Commands run from replaced stock plugin dir:

```bash
npx tsx scripts/test-projection.ts
npx tsx scripts/test-runtime-regression.ts
npx tsx test-e2e.ts
```

Verified outcomes:

- replaced stock plugin behaves the same as the development worktree
- projection behavior remains correct
- ACP behavior remains correct

### 4. OpenClaw gateway / agent smoke

Commands run:

```bash
openclaw gateway health
openclaw status
openclaw agent --local --agent main --message "你好，请一句话介绍你自己" --json
```

Verified outcomes:

- gateway starts successfully
- gateway reports `agent model: hermes/default`
- embedded agent run routes to `provider=hermes`, `model=default`

Observed limitation:

- `openclaw agent --local --agent main ...` fails with:
  - `LLM request failed: network connection error.`
  - gateway log confirms `provider=hermes`, `model=default`

This means the routing/model selection path is correct, but the provider-side runtime endpoint or bridge is still incomplete for the product-adjacent embedded agent path.

## Strong conclusions

### Confirmed working

- runtime-first execution projection in the plugin
- workspace-specific prompt and skill projection
- strict filtering of host-backed skills
- session binding and session resume in ACP
- local stock plugin replacement and loading
- gateway model selection to `hermes/default`

### Confirmed not yet complete

- full OpenClaw embedded-agent product path is not yet commercially complete
- the remaining gap is not plugin discovery or model routing
- the remaining gap is provider/runtime connectivity for `provider=hermes` in the embedded agent path

## Suggested next debugging target

Focus on the provider-side runtime endpoint used by OpenClaw when `provider=hermes` and `model=default` are selected:

- what serves `http://127.0.0.1/hermes-runtime`
- whether OpenClaw expects an OpenAI-compatible HTTP surface there
- whether the current plugin is only providing harness tools and model catalog, but not the required provider transport endpoint for embedded-agent inference

