/**
 * openclaw-plugin-hermes — Active Session Registry
 *
 * 追踪所有正在执行的 Hermes 任务，以便在用户取消（Ctrl+C）
 * 或调用 hermes_cancel 时能够终止容器中正在运行的任务。
 */

export interface ActiveSession {
  /** 用于触发 AbortSignal 来取消 ACP prompt */
  abortController: AbortController;
  /** 任务描述（用于展示） */
  task: string;
  /** 任务开始时间戳 */
  startTime: number;
}

/** 活跃会话注册表：dispatchId -> ActiveSession */
const activeSessions = new Map<string, ActiveSession>();

let idCounter = 0;

/** 生成唯一 dispatch ID */
export function generateDispatchId(): string {
  return `hermes-${Date.now()}-${++idCounter}`;
}

/** 注册一个活跃会话 */
export function registerSession(id: string, session: ActiveSession): void {
  activeSessions.set(id, session);
}

/** 注销一个活跃会话 */
export function unregisterSession(id: string): void {
  activeSessions.delete(id);
}

/** 取消指定会话，返回是否成功找到并取消 */
export function cancelSession(id: string): boolean {
  const session = activeSessions.get(id);
  if (!session) return false;
  session.abortController.abort();
  activeSessions.delete(id);
  return true;
}

/** 取消所有活跃会话，返回被取消的数量 */
export function cancelAllSessions(): number {
  const count = activeSessions.size;
  for (const [id, session] of activeSessions) {
    session.abortController.abort();
    activeSessions.delete(id);
  }
  return count;
}

/** 获取所有活跃会话的快照（用于状态查询） */
export function getActiveSessions(): Array<{
  id: string;
  task: string;
  startTime: number;
  durationMs: number;
}> {
  const now = Date.now();
  return Array.from(activeSessions.entries()).map(([id, s]) => ({
    id,
    task: s.task,
    startTime: s.startTime,
    durationMs: now - s.startTime,
  }));
}
