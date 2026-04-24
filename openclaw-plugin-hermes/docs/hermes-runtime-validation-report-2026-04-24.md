# Hermes Runtime Validation Report

Date: 2026-04-24

Scope: non-Feishu validation only. All checks below were run against the real local OpenClaw installation and the real `hermes-agent` container unless explicitly marked as mocked/script-level.

## Environment

- OpenClaw CLI: `2026.4.15`
- Hermes container: `hermes-agent`
- Hermes runtime version: `v0.9.0 (2026.4.13)`
- ACP transport: local TCP bridge `127.0.0.1:3100`
- OpenClaw Hermes plugin: enabled in `/root/.openclaw/openclaw.json`
- Workspace detected on host: `/root/.openclaw/workspace`

## Executive Summary

The Hermes runtime integration is working for the major non-Feishu flows in the current environment after local fixes and revalidation:

- Core runtime health is good.
- ACP initialization, session creation, prompt execution, and basic projection work.
- Gateway/harness event bridging works in script-level end-to-end verification.
- Skill writeback logic works in dedicated writeback tests and in the local end-to-end validation after path-resolution and test-contract fixes.
- A projection regression around `feishu` exposure was fixed by classifying it as non-projectable via the default denylist.
- Feishu-dependent validation is blocked by missing real Feishu app credentials and is intentionally excluded from this report.

## Real Environment Results

### 1. Runtime health

Status: PASS

Evidence:

- `docker ps` showed `hermes-agent` running.
- `docker exec hermes-agent ... hermes version` returned a valid version.
- `docker exec hermes-agent ... hermes acp --help` succeeded.
- `test-e2e.ts` health section reported:
  - container running
  - ACP responsive

### 2. ACP prompt round-trip

Status: PASS

Real verification performed through the live Hermes ACP bridge.

Observed behavior:

- TCP connect to `127.0.0.1:3100`
- ACP initialize succeeded
- session created successfully
- prompt succeeded
- streamed thinking/text events received
- final response returned normally

### 3. Projection / execenv creation

Status: PASS

Validated behavior:

- execution environment created successfully
- projected prompt built correctly
- `browser` skill filtered from projected OpenClaw skills
- workspace-dependent binding hashes differ across different workspaces

Passing scripts:

- `test:runtime:projection`
- `test:runtime:static`
- `test:runtime:session-history`
- `test:runtime:gateway`

### 4. Session binding and history projection

Status: PASS

Validated behavior:

- stable session anchor derived from OpenClaw session identity
- session binding written to persisted store
- prior conversation history injected into projected prompt path

Passing script:

- `test:runtime:session-history`

### 5. Gateway/harness event bridge

Status: PASS at script-level

Validated behavior:

- projected execenv path anchored by stable session identity
- tool/thinking/assistant lifecycle events emitted
- reasoning stream surfaced
- partial assistant replies surfaced
- session binding persisted

Passing script:

- `test:runtime:gateway`

Note:

This script uses a mocked ACP client but exercises the real harness/runtime glue code around it.

### 6. Skill writeback

Status: PASS

Dedicated and broad writeback behavior:

- `test:skill-writeback` passes
- `test:skill-evolution` passes
- `test-e2e.ts` writeback section passes

Validated behavior from dedicated scripts:

- new runtime-generated skill can sync back into `workspace/skills`
- autoskill-managed existing skill can be refreshed
- unmanaged existing workspace skill is protected from overwrite
- unrelated runtime skills are not mirrored
- unrelated global Hermes skills are not mirrored

Fixes applied during validation:

- corrected runtime-path to host-path resolution for projected execenv skill sync
- changed sync logic to prefer host execenv content whenever the host execenv exists
- aligned `test-e2e.ts` writeback expectations with the current autoskill overwrite contract and explicit touched-skill filtering

### 7. Strict projection / host-backed skill filtering

Status: PASS after fix

Initial failure:

- projected skills were `["feishu", "ops-helper"]`
- `browser` was filtered
- `feishu` was not filtered

Fix applied:

- expanded default `skillProjection.hostBackedDenylist` to include `feishu`

Current result:

- `strictProjection.exposed` is now only `["ops-helper"]`
- `test:runtime:regression` passes

### 8. Direct dispatch mode

Status: CODE-PATH PRESENT, not fully validated in live end-to-end flow

Observed from code:

- when `enableLayeredProtocol=false`, dispatch bypasses:
  - strategy inference
  - credential injection
  - result writeback
- still prepares an L0 execenv and uses ACP prompt directly

Gap:

- no dedicated live test was run for direct dispatch in this pass

## Unsupported / Not Fully Supported Functions

### Confirmed unsupported in this validation scope

- Real Feishu document read/write verification
- Any Feishu-backed skill behavior
- Final Feishu report publishing

Reason:

- local environment lacks real Feishu `appId/appSecret`

### Not fully supported or not sufficiently validated yet

- Live CLI-level isolated agent flow via `openclaw agent --agent ai-1111`
- W3 confirmation flow with real user confirmation callback
- Direct dispatch mode under real live execution
- Timeout/cancel behavior under real long-running ACP tasks
- Credential injection with actually present external service credentials
- Artifact/result writeback beyond memory/skills metadata
- Cron/config creation lifecycle

## Expanded Functional Use-Case Matrix

### A. Runtime / transport

- Health check
  - Status: PASS
- ACP initialize
  - Status: PASS
- ACP session create
  - Status: PASS
- ACP resume/load session
  - Status: PASS in script-level regression coverage
- ACP prompt round-trip
  - Status: PASS
- ACP stream event parsing
  - Status: PASS
- ACP idle finalize fallback
  - Status: code present, not independently stress-tested
- Cancel session
  - Status: not validated
- Timeout handling
  - Status: code present, not validated with a forced timeout

### B. Projection / context

- L0 projection
  - Status: PASS
- L1 projection
  - Status: PASS
- L2 projection
  - Status: PASS
- L3 projection
  - Status: PASS
- Session history projection
  - Status: PASS
- Stable session anchor
  - Status: PASS
- Browser skill filtering
  - Status: PASS
- Feishu skill filtering
  - Status: FAIL if expected to be host-backed

### C. Strategy engine

- Query-only inference to W0
  - Status: PASS by script observation
- Tool task inference to L1
  - Status: PASS by script observation
- Memory/identity inference to L2
  - Status: PASS by script observation
- Skill/cron inference to L3
  - Status: PASS by script observation
- Specific credential inference to C1
  - Status: PASS by script observation
- All-channel inference to C2
  - Status: PASS by script observation

### D. Writeback

- W0 return-only behavior
  - Status: PASS by code path and strategy script
- W1 result return
  - Status: PASS
- W2 daily memory append
  - Status: code path present, not directly asserted on filesystem in this pass
- W2 MEMORY.md learning append
  - Status: code path present, not directly asserted on filesystem in this pass
- W3 touched skill extraction
  - Status: PASS in dedicated tests
- W3 new skill sync
  - Status: PASS in dedicated test, unstable in broad e2e
- W3 managed skill refresh
  - Status: PASS in dedicated test
- W3 unmanaged skill overwrite protection
  - Status: PASS in dedicated test
- W3 global skill sync
  - Status: PASS in dedicated test, failed in broad e2e script

### E. OpenClaw integration

- Provider registration
  - Status: PASS
- Harness registration
  - Status: PASS
- Gateway attempt integration
  - Status: PASS at script-level
- Real isolated agent registration/routing
  - Status: incomplete

## Known Defects / Gaps

1. CLI-level isolated agent flow not yet stable in this environment

- `openclaw agents add` indicates `ai-1111` exists
- prior `openclaw agent --agent ai-1111` returned unknown agent id
- likely a state/routing persistence issue or earlier add/list timing issue

## Recommended Next Steps

1. Replace denylist-only projection policy with explicit skill classification metadata if the product surface grows further.

2. Add missing live tests:
   - direct dispatch mode
   - forced timeout
   - forced cancel
   - credential-injected live task with real env vars
   - filesystem write/readback through prompt-referenced paths

3. After Feishu credentials are available:
   - validate real doc fetch
   - validate final report publishing
