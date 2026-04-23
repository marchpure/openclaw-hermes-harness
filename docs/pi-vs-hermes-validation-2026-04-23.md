# Pi vs Hermes Validation Notes

## Scope

This document records real OpenClaw validation work for the Pi-vs-Hermes comparison. All checks were executed through the local OpenClaw runtime and Hermes ACP bridge.

## Source doc analyzed

- `https://bytedance.larkoffice.com/docx/VpwldK51doomDTxJ3U4cIxPwneR`

## Validation method

Runner:

- `artifacts/pi-hermes-root-cause/run-isolated-openclaw-bench.mjs`

Execution path:

- `openclaw agent --local`
- real OpenClaw session store
- real Hermes plugin
- real Hermes ACP bridge
- real Docker container `hermes-agent`

## Artifacts

Primary artifact root:

- `/root/openclaw-hermes-harness/artifacts/pi-hermes-root-cause`

Important runs:

- `isolated-2026-04-23T00-36-03-418Z`
- `isolated-2026-04-23T00-39-09-769Z`
- `isolated-2026-04-23T00-45-55-527Z`

## Confirmed observations

### 1. Pi lane contamination

Real isolated runs that were configured as Pi still produced:

- `provider=hermes`
- `model=default`

That confirms the current comparison environment is not a clean Pi-vs-Hermes split.

### 2. Hermes ACP session isolation issue was real

Before the fix, unrelated isolated cases could reuse the same Hermes session anchor.

After the fix in `753bf63`:

- anchor selection is unique per `sessionId`
- separate isolated cases created separate Hermes ACP sessions

### 3. Hermes write/read mismatch was namespace-specific

Real evidence showed:

- host workspace file missing
- container workspace file present

This explains why host validation reported write failure while Hermes later read the expected marker.

## Current code checkpoints

- `753bf63 Prefer explicit session id for Hermes bindings`

## Pending validation after workspace sync fix

The following must be re-run after deploying the workspace sync change:

1. Hermes isolated write-file
2. Hermes isolated read-rule
3. Pi isolated write-file after clearing or bypassing `agent:main:main` provider override
4. Pi isolated read-rule after clearing or bypassing `agent:main:main` provider override

## Acceptance criteria for the rerun

- Pi cases must report a non-Hermes provider
- Hermes write-file must create the file on the host workspace
- Hermes read-rule must return the rule marker, not a previous write marker
- tool evidence and file evidence must match

## Rerun result after workspace sync fix

Artifact:

- `/root/openclaw-hermes-harness/artifacts/pi-hermes-root-cause/isolated-2026-04-23T00-49-48-709Z`

Summary:

- Pi write-file: `ok=true`, but `provider=hermes`
- Pi read-rule: `ok=true`, but `provider=hermes`
- Hermes write-file: `ok=true`, `provider=hermes`
- Hermes read-rule: `ok=true`, `provider=hermes`

Interpretation:

- The Hermes runtime defects reproduced from the original comparison doc are fixed in the current plugin build.
- The Pi lane is still not a valid Pi baseline because OpenClaw continues routing it through Hermes via session override state.
