import type { AgentHarnessAttemptParams } from "openclaw/plugin-sdk/agent-harness";

type HarnessAgentEvent = {
  stream: string;
  data: Record<string, unknown>;
};

export function publishHermesHarnessAgentEvent(
  params: AgentHarnessAttemptParams,
  event: HarnessAgentEvent,
): void {
  try {
    void Promise.resolve(params.onAgentEvent?.(event)).catch(() => {});
  } catch {
    // Best effort only. Agent event delivery must not block or fail the turn.
  }
}
