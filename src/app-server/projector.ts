import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
  NormalizedUsage,
} from "openclaw/plugin-sdk/agent-harness";
import { publishHermesHarnessAgentEvent } from "../agent-event-bridge.js";
import type { HermesServerNotification, JsonObject, JsonValue } from "./protocol.js";
import { isJsonObject } from "./protocol.js";

type ToolTelemetry = {
  didSendViaMessagingTool: boolean;
  messagingToolSentTexts: string[];
  messagingToolSentMediaUrls: string[];
  messagingToolSentTargets: AgentHarnessAttemptResult["messagingToolSentTargets"];
  toolMediaUrls?: string[];
  toolAudioAsVoice?: boolean;
  successfulCronAdds?: number;
};

export class HermesAppServerEventProjector {
  private assistantText = "";
  private reasoningText = "";
  private assistantStarted = false;
  private reasoningStarted = false;
  private reasoningEnded = false;
  private readonly toolMetas = new Map<string, { toolName: string; meta?: string }>();
  private completedTurn:
    | { status?: string; error?: { message?: string } | null }
    | undefined;
  private promptError: unknown = null;
  private promptErrorSource: AgentHarnessAttemptResult["promptErrorSource"] = null;
  private aborted = false;
  private usage: NormalizedUsage | undefined;
  private startedCount = 0;
  private completedCount = 0;

  constructor(
    private readonly params: AgentHarnessAttemptParams,
    private readonly threadId: string,
  ) {}

  async handleNotification(notification: HermesServerNotification): Promise<void> {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    if (!params || readString(params, "threadId") !== this.threadId) {
      return;
    }

    switch (notification.method) {
      case "item/agentMessage/delta":
        await this.handleAssistantDelta(params);
        break;
      case "item/reasoning/textDelta":
        await this.handleReasoningDelta(params);
        break;
      case "item/tool/started":
        this.handleToolStarted(params);
        break;
      case "item/tool/completed":
        await this.handleToolCompleted(params);
        break;
      case "turn/completed":
        this.completedTurn = isJsonObject(params.turn)
          ? {
              status: readString(params.turn, "status"),
              error: isJsonObject(params.turn.error)
                ? { message: readString(params.turn.error, "message") }
                : null,
            }
          : { status: "completed" };
        if (this.reasoningStarted && !this.reasoningEnded) {
          await this.params.onReasoningEnd?.();
          this.reasoningEnded = true;
        }
        break;
      case "error":
        this.promptError = readString(params, "message") ?? "hermes app-server error";
        this.promptErrorSource = "prompt";
        break;
      default:
        break;
    }
  }

  markTimedOut(): void {
    this.aborted = true;
    this.promptError = "hermes app-server attempt timed out";
    this.promptErrorSource = "prompt";
  }

  setUsage(usage: NormalizedUsage | undefined): void {
    this.usage = usage;
  }

  buildResult(telemetry: ToolTelemetry, options?: { yieldDetected?: boolean }): AgentHarnessAttemptResult {
    const synthesizedAssistantText = this.synthesizeAssistantText();
    const effectiveAssistantText = this.assistantText || synthesizedAssistantText;
    const lastAssistant = effectiveAssistantText
      ? ({
          role: "assistant",
          content: effectiveAssistantText,
          timestamp: Date.now(),
          usage: this.usage,
        } as unknown as AgentHarnessAttemptResult["lastAssistant"])
      : undefined;
    const messagesSnapshot: AgentMessage[] = [
      { role: "user", content: this.params.prompt, timestamp: Date.now() },
    ];
    if (this.reasoningText) {
      messagesSnapshot.push({
        role: "assistant",
        content: `Hermes reasoning\n\n${this.reasoningText}`,
        timestamp: Date.now(),
      } as unknown as AgentMessage);
    }
    if (lastAssistant) {
      messagesSnapshot.push(lastAssistant as AgentMessage);
    }

    const turnFailed = this.completedTurn?.status === "failed";
    const turnInterrupted = this.completedTurn?.status === "interrupted";
    const promptError =
      this.promptError ??
      (turnFailed ? (this.completedTurn?.error?.message ?? "hermes app-server turn failed") : null);

    return {
      aborted: this.aborted || turnInterrupted,
      externalAbort: false,
      timedOut: false,
      idleTimedOut: false,
      timedOutDuringCompaction: false,
      promptError,
      promptErrorSource: promptError ? this.promptErrorSource || "prompt" : null,
      sessionIdUsed: this.params.sessionId,
      bootstrapPromptWarningSignaturesSeen: this.params.bootstrapPromptWarningSignaturesSeen,
      bootstrapPromptWarningSignature: this.params.bootstrapPromptWarningSignature,
      finalPromptText: this.params.prompt,
      messagesSnapshot,
      assistantTexts: effectiveAssistantText ? [effectiveAssistantText] : [],
      toolMetas: [...this.toolMetas.values()],
      lastAssistant,
      currentAttemptAssistant: lastAssistant,
      didSendViaMessagingTool: telemetry.didSendViaMessagingTool,
      messagingToolSentTexts: telemetry.messagingToolSentTexts,
      messagingToolSentMediaUrls: telemetry.messagingToolSentMediaUrls,
      messagingToolSentTargets: telemetry.messagingToolSentTargets,
      toolMediaUrls: telemetry.toolMediaUrls,
      toolAudioAsVoice: telemetry.toolAudioAsVoice,
      successfulCronAdds: telemetry.successfulCronAdds,
      cloudCodeAssistFormatError: false,
      attemptUsage: this.usage,
      yieldDetected: options?.yieldDetected || false,
      replayMetadata: {
        hadPotentialSideEffects: telemetry.didSendViaMessagingTool || this.toolMetas.size > 0,
        replaySafe: !telemetry.didSendViaMessagingTool && this.toolMetas.size === 0,
      },
      itemLifecycle: {
        startedCount: this.startedCount,
        completedCount: this.completedCount,
        activeCount: Math.max(0, this.startedCount - this.completedCount),
      },
    };
  }

  private synthesizeAssistantText(): string {
    if (this.assistantText) {
      return this.assistantText;
    }
    if (typeof this.promptError === "string" && this.promptError.trim()) {
      return this.promptError.trim();
    }
    const toolNames = [...new Set([...this.toolMetas.values()].map((meta) => meta.toolName).filter(Boolean))];
    if (toolNames.length > 0) {
      return `Hermes completed tool execution but did not return a final textual answer. Tools used: ${toolNames.join(", ")}.`;
    }
    if (this.reasoningText.trim()) {
      return "Hermes completed reasoning but did not return a final textual answer.";
    }
    return "";
  }

  private async handleAssistantDelta(params: JsonObject): Promise<void> {
    const delta = readString(params, "delta") ?? "";
    if (!delta) {
      return;
    }
    if (!this.assistantStarted) {
      this.assistantStarted = true;
      await this.params.onAssistantMessageStart?.();
    }
    this.assistantText += delta;
    await this.params.onPartialReply?.({ text: delta });
  }

  private async handleReasoningDelta(params: JsonObject): Promise<void> {
    const delta = readString(params, "delta") ?? "";
    if (!delta) {
      return;
    }
    this.reasoningStarted = true;
    this.reasoningText += delta;
    publishHermesHarnessAgentEvent(this.params, {
      stream: "thinking",
      data: { text: delta, delta },
    });
    await this.params.onReasoningStream?.({ text: delta });
  }

  private handleToolStarted(params: JsonObject): void {
    const id = readString(params, "itemId") ?? `tool:${this.toolMetas.size}`;
    const toolName = readString(params, "tool") ?? "openclaw_tool";
    this.startedCount += 1;
    this.toolMetas.set(id, { toolName });
    publishHermesHarnessAgentEvent(this.params, {
      stream: "tool",
      data: { phase: "start", name: toolName, toolCallId: id },
    });
    publishHermesHarnessAgentEvent(this.params, {
      stream: "item",
      data: {
        itemId: id,
        phase: "start",
        kind: "tool",
        title: toolName,
        status: "running",
        name: toolName,
        toolCallId: id,
        startedAt: Date.now(),
      },
    });
  }

  private async handleToolCompleted(params: JsonObject): Promise<void> {
    const id = readString(params, "itemId") ?? `tool:${this.toolMetas.size}`;
    const existing = this.toolMetas.get(id);
    const toolName = readString(params, "tool") ?? existing?.toolName ?? "openclaw_tool";
    const preview = readString(params, "preview") ?? "";
    const isError = Boolean(params.isError);
    this.completedCount += 1;
    this.toolMetas.set(id, { toolName, ...(preview ? { meta: preview.slice(0, 200) } : {}) });
    publishHermesHarnessAgentEvent(this.params, {
      stream: "tool",
      data: {
        phase: "result",
        name: toolName,
        toolCallId: id,
        isError,
        result: { content: preview ? [{ type: "text", text: preview }] : [] },
      },
    });
    publishHermesHarnessAgentEvent(this.params, {
      stream: "item",
      data: {
        itemId: id,
        phase: "end",
        kind: "tool",
        title: preview ? `${toolName}: ${preview.slice(0, 120)}` : toolName,
        status: isError ? "failed" : "completed",
        name: toolName,
        toolCallId: id,
        endedAt: Date.now(),
        ...(preview ? { summary: preview, progressText: preview } : {}),
      },
    });
    await this.params.onToolResult?.({ text: preview } as never);
  }
}

function readString(record: JsonObject | JsonValue | undefined, key: string): string | undefined {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return undefined;
  }
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}
