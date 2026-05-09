import { createRequire } from "node:module";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentHarnessAttemptParams } from "openclaw/plugin-sdk/agent-harness";

type HarnessAgentEvent = {
  stream: string;
  data: Record<string, unknown>;
};

type EmitAgentEvent = (event: {
  runId: string;
  stream: string;
  data: Record<string, unknown>;
  sessionKey?: string;
}) => void;

let emitterPromise: Promise<EmitAgentEvent | undefined> | undefined;
let testEmitter: EmitAgentEvent | undefined;

export function publishHermesHarnessAgentEvent(
  params: AgentHarnessAttemptParams,
  event: HarnessAgentEvent,
): void {
  void emitHermesHarnessAgentEvent(params, event);
  void params.onAgentEvent?.(event);
}

export async function emitHermesHarnessAgentEvent(
  params: AgentHarnessAttemptParams,
  event: HarnessAgentEvent,
): Promise<void> {
  const runId = readNonEmptyString(params.runId);
  if (!runId) {
    return;
  }
  try {
    const emit = testEmitter ?? (await loadOpenClawAgentEventEmitter());
    if (!emit) {
      return;
    }
    const sessionKey = readNonEmptyString((params as { sessionKey?: unknown }).sessionKey);
    emit({
      runId,
      stream: event.stream,
      data: event.data,
      ...(sessionKey ? { sessionKey } : {}),
    });
  } catch {
    // Best effort only. Channel delivery still uses onToolResult/onReasoningStream.
  }
}

export function setHermesHarnessAgentEventEmitterForTest(
  emitter: EmitAgentEvent | undefined,
): void {
  testEmitter = emitter;
}

async function loadOpenClawAgentEventEmitter(): Promise<EmitAgentEvent | undefined> {
  emitterPromise ??= resolveOpenClawAgentEventEmitter();
  return emitterPromise;
}

async function resolveOpenClawAgentEventEmitter(): Promise<EmitAgentEvent | undefined> {
  const require = createRequire(import.meta.url);
  const candidateRoots = new Set<string>();
  try {
    const sdkEntry = require.resolve("openclaw/plugin-sdk/agent-harness");
    candidateRoots.add(dirname(dirname(sdkEntry)));
  } catch {}
  // Installed OpenClaw builds may only expose hashed dist bundles in the
  // global module directory, so keep those roots in the search set.
  candidateRoots.add("/usr/lib/node_modules/openclaw/dist");
  candidateRoots.add("/usr/local/lib/node_modules/openclaw/dist");

  const candidates: string[] = [];
  for (const distRoot of candidateRoots) {
    candidates.push(join(distRoot, "infra", "agent-events.js"));
    candidates.push(join(distRoot, "plugin-sdk", "src", "infra", "agent-events.js"));
    candidates.push(...(await findBundledAgentEventModules(distRoot)));
  }

  for (const candidate of candidates) {
    const emit = await tryLoadEmitter(candidate);
    if (emit) {
      return emit;
    }
  }
  return undefined;
}

async function findBundledAgentEventModules(distRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(distRoot);
    return entries
      .filter((entry) => /^agent-events-[\w-]+\.js$/.test(entry))
      .map((entry) => join(distRoot, entry));
  } catch {
    return [];
  }
}

async function tryLoadEmitter(modulePath: string): Promise<EmitAgentEvent | undefined> {
  try {
    const mod = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
    const named = mod.emitAgentEvent;
    if (typeof named === "function") {
      return named as EmitAgentEvent;
    }
    // Bundled OpenClaw builds sometimes minify the named export. Keep this
    // fallback because it is still part of the real local runtime surface.
    const bundled = mod.i;
    if (typeof bundled === "function") {
      return bundled as EmitAgentEvent;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
