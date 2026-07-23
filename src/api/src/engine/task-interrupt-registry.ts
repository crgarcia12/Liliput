import { logger } from '../logger.js';

type TaskAborter = () => void | Promise<void>;

const abortersByTask = new Map<string, Map<symbol, TaskAborter>>();

export function registerTaskAborter(
  taskId: string,
  aborter: TaskAborter,
): () => void {
  const token = Symbol(taskId);
  const aborters = abortersByTask.get(taskId) ?? new Map<symbol, TaskAborter>();
  aborters.set(token, aborter);
  abortersByTask.set(taskId, aborters);
  return () => {
    const current = abortersByTask.get(taskId);
    current?.delete(token);
    if (current?.size === 0) abortersByTask.delete(taskId);
  };
}

export function interruptRegisteredTaskSessions(taskId: string): number {
  const aborters = [...(abortersByTask.get(taskId)?.values() ?? [])];
  for (const aborter of aborters) {
    void Promise.resolve()
      .then(aborter)
      .catch((error: unknown) => {
        logger.warn(
          {
            taskId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to abort registered task session',
        );
      });
  }
  return aborters.length;
}
