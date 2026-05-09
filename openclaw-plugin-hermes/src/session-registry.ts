/**
 * Track active Hermes dispatches so tool callers can cancel them explicitly.
 */

export interface ActiveSession {
  abortController: AbortController;
  task: string;
  startTime: number;
}

const activeSessions = new Map<string, ActiveSession>();
let idCounter = 0;

export function generateDispatchId(): string {
  return `hermes-${Date.now()}-${++idCounter}`;
}

export function registerSession(id: string, session: ActiveSession): void {
  activeSessions.set(id, session);
}

export function unregisterSession(id: string): void {
  activeSessions.delete(id);
}

export function cancelSession(id: string): boolean {
  const session = activeSessions.get(id);
  if (!session) return false;
  session.abortController.abort();
  activeSessions.delete(id);
  return true;
}

export function cancelAllSessions(): number {
  const count = activeSessions.size;
  for (const [id, session] of activeSessions) {
    session.abortController.abort();
    activeSessions.delete(id);
  }
  return count;
}

export function getActiveSessions(): Array<{
  id: string;
  task: string;
  startTime: number;
  durationMs: number;
}> {
  const now = Date.now();
  return Array.from(activeSessions.entries()).map(([id, session]) => ({
    id,
    task: session.task,
    startTime: session.startTime,
    durationMs: now - session.startTime,
  }));
}
