# Pi vs Hermes Root Cause Analysis

## Scope

This document records root-cause analysis for the real OpenClaw comparison described in:

- `https://bytedance.larkoffice.com/docx/VpwldK51doomDTxJ3U4cIxPwneR`

All findings below were reproduced on the local OpenClaw deployment. No mock runtime or synthetic tool layer was used.

## Environment

- Date: 2026-04-23
- Harness repo: `/root/openclaw-hermes-harness`
- Branch: `minimal-reasoning-bridge`
- OpenClaw workspace: `/root/.openclaw/workspace`
- OpenClaw config: `/root/.openclaw/openclaw.json`
- Hermes ACP bridge: `127.0.0.1:3100`
- Hermes container: `hermes-agent`

## Root Cause 1: the reported "Pi" lane was not actually Pi

### Finding

The session store contains a persistent override on `agent:main:main`:

- `providerOverride: hermes`
- `modelOverride: default`
- `modelOverrideSource: user`

Because the real bench script uses:

- `openclaw agent --local --agent main --session-id <unique-id> ...`

OpenClaw still reuses the broad `agent:main:main` routing state, so the supposed Pi lane is dispatched to Hermes.

### Evidence

Observed from `/root/.openclaw/agents/main/sessions/sessions.json`:

- `agent:main:main -> providerOverride=hermes`
- `agent:main:main -> modelOverride=default`

Observed from isolated real runs:

- Pi write-file: `provider=hermes`
- Pi read-rule: `provider=hermes`

### Impact

The `16/16` Pi result in the current Feishu comparison doc cannot be treated as a clean Pi-vs-Hermes A/B result until the OpenClaw session override is isolated or cleared.

## Root Cause 2: Hermes session binding reused a broad session key

### Finding

Before the fix, Hermes binding anchor selection preferred:

1. `sessionKey`
2. `sessionFile`
3. `sessionId`

Real OpenClaw CLI/local runs often reuse a broad `sessionKey` such as `agent:main:main` while still passing a unique `sessionId`. That caused unrelated tasks to resume the same Hermes ACP session and projected execenv.

### Evidence

Before the fix:

- unrelated isolated cases reused one Hermes binding path
- read-rule could surface a marker written by a previous case

After the fix:

- anchor selection now prefers `sessionId`
- isolated post-fix runs created distinct Hermes ACP sessions per case
- stderr shows separate `Session created` values for each case

### Code fix

Committed as:

- `753bf63 Prefer explicit session id for Hermes bindings`

### Impact

This removes one confirmed source of cross-case contamination in Hermes ACP session reuse.

## Root Cause 3: Hermes workspace writes landed inside the container namespace

### Finding

Hermes executed absolute workspace paths such as:

- `/root/.openclaw/workspace/agent-loop-bench-fixtures/isolated-marker-hermes.txt`

but those writes were applied inside the Hermes container filesystem, not on the host workspace that OpenClaw verification checks.

### Evidence

From the real isolated Hermes write-file case:

- tool summary reported `write: /root/.openclaw/workspace/agent-loop-bench-fixtures/isolated-marker-hermes.txt`
- host file did not exist after the run
- container file did exist at the same absolute path

From the follow-up read-rule case:

- Hermes read `ISOLATED_RULE.md`
- Hermes also read `isolated-marker-hermes.txt`
- the returned marker matched the container-private file

This shows the runtime was operating on a container-private `/root/.openclaw/workspace`, not the host workspace namespace.

### Impact

This produced two visible failures:

- fake host-side write failure
- apparent context pollution, because later reads could see container-private files that host-side validation did not see

## Additional environment notes

- Hermes plugin config currently has `enableLayeredProtocol=false` in `/root/.openclaw/openclaw.json`
- Hermes plugin config currently sets `defaultModel` to `doubao-seed-2-0-pro-260215`

These settings do not invalidate the two root causes above, but they must be recorded when interpreting runtime behavior.

## Fix status

### Fixed

- Hermes binding anchor now prefers explicit `sessionId`

### In progress

- Workspace synchronization between host and Hermes container for absolute OpenClaw workspace paths

### Fixed after validation rerun

The workspace namespace issue was fixed by synchronizing the OpenClaw workspace between host and Hermes container around each real harness turn:

- mirror host workspace to container before the turn
- mirror container workspace back to host after the turn

This removed both previously observed Hermes failures in the isolated real validation rerun:

- write-file now creates a host-visible file
- read-rule now returns the rule marker instead of the previous write marker

Validation artifact:

- `/root/openclaw-hermes-harness/artifacts/pi-hermes-root-cause/isolated-2026-04-23T00-49-48-709Z`

## Recommended validation gates

Before accepting any new Pi-vs-Hermes comparison numbers:

1. Ensure the Pi lane no longer resolves to `provider=hermes`
2. Ensure Hermes write-file creates a file visible on the host workspace
3. Ensure Hermes read-rule no longer returns a marker from a prior isolated case
4. Record the exact OpenClaw session override state together with each run
