/**
 * Workstreams + delete/preview routes.
 *
 * Hard-delete endpoints tear down external state (PR, branch, namespace,
 * SDK session, workspace) and then remove DB rows. Preview endpoints return
 * a summary of what *would* be deleted so the UI can render a confirmation.
 *
 * These never touch the GitHub repository itself or any branch other than
 * the one the agent created (`task.branch`).
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Server as SocketServer } from 'socket.io';
import type { CreateWorkstreamRequest, DeletePreview, Task } from '../../../shared/types/index.js';
import * as taskStore from '../stores/task-store.js';
import * as wsStore from '../stores/workstream-store.js';
import { teardownTask } from '../engine/agent-engine.js';
import { logger } from '../logger.js';

function buildPreviewForTasks(
  tasks: Task[],
  scope: DeletePreview['scope'],
  label: string,
  workstreams: { id: string; name: string }[] = [],
): DeletePreview {
  return {
    scope,
    label,
    taskCount: tasks.length,
    branches: tasks
      .filter((t) => t.repository && t.branch)
      .map((t) => ({ repository: t.repository as string, branch: t.branch as string })),
    pullRequests: tasks
      .filter((t) => t.repository && typeof t.pullRequestNumber === 'number')
      .map((t) => ({
        repository: t.repository as string,
        number: t.pullRequestNumber as number,
        ...(t.pullRequestUrl ? { url: t.pullRequestUrl } : {}),
      })),
    namespaces: tasks.filter((t) => !!t.devNamespace).map((t) => t.devNamespace as string),
    workstreams,
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status })),
  };
}

/**
 * Mark a task as `deleting`, notify the UI immediately, and run external
 * teardown in the background. Idempotent and resumable:
 *
 *  - If the row is already `deleting`, just (re-)schedule another teardown
 *    pass — every step (`closePullRequest`, `deleteNamespace`,
 *    `deleteRemoteBranch`, workspace `rm`) tolerates "already gone".
 *  - On teardown success, the row is hard-deleted.
 *  - On teardown failure, the row stays `deleting` and the periodic
 *    `runDeletingSweeper` will retry. Pod restarts are safe — the persisted
 *    `deleting` rows act as the resume queue.
 */
function purgeTask(io: SocketServer, task: Task): void {
  if (task.status !== 'deleting') {
    taskStore.updateTask(task.id, { status: 'deleting' });
    io.emit('task:deleted', { taskId: task.id });
    logger.info({ taskId: task.id }, 'Task marked deleting; scheduling background teardown');
  } else {
    logger.info({ taskId: task.id }, 'Task already deleting; re-scheduling background teardown');
  }

  void (async () => {
    try {
      await teardownTask(task, {
        log: (level, message) =>
          logger[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'](
            { taskId: task.id },
            `purge: ${message}`,
          ),
      });
      taskStore.deleteTask(task.id);
      logger.info({ taskId: task.id }, 'Background teardown complete; row removed');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        { taskId: task.id, err: message },
        'Background teardown raised; row left in deleting state for sweeper retry',
      );
    }
  })();
}

/**
 * Periodic resumer: re-runs background teardown for every task stuck in
 * `deleting`. Runs once on startup and on a fixed interval. Idempotent — if
 * teardown already finished, the row is already gone and this is a no-op.
 */
export function runDeletingSweeper(io: SocketServer): void {
  const tick = () => {
    let stuck: Task[];
    try {
      stuck = taskStore.listDeletingTasks();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: msg }, 'Deleting-sweeper: list failed');
      return;
    }
    if (stuck.length === 0) return;
    logger.info({ count: stuck.length }, '🧹 Deleting-sweeper: retrying teardown');
    for (const t of stuck) {
      purgeTask(io, t);
    }
  };
  // Kick once on startup, then every 5 min.
  tick();
  setInterval(tick, 5 * 60 * 1000).unref();
}

export function createWorkstreamsRouter(io: SocketServer): Router {
  const router = Router();

  // ─── Workstreams CRUD ─────────────────────────────────────

  router.get('/api/workstreams', (req: Request, res: Response) => {
    try {
      const repository = (req.query['repository'] as string | undefined)?.trim();
      const workstreams = wsStore.listWorkstreams(repository || undefined);
      res.json({ workstreams });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, 'Failed to list workstreams');
      res.status(500).json({ error: 'Failed to list workstreams', details: message });
    }
  });

  router.post('/api/workstreams', (req: Request, res: Response) => {
    try {
      const { repository, name, description } = req.body as CreateWorkstreamRequest;
      if (!repository || !name) {
        res.status(400).json({ error: 'repository and name are required' });
        return;
      }
      const ws = wsStore.createWorkstream(repository.trim(), name.trim(), description?.trim());
      res.status(201).json({ workstream: ws });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, 'Failed to create workstream');
      res.status(500).json({ error: 'Failed to create workstream', details: message });
    }
  });

  // ─── Preview endpoints ────────────────────────────────────

  router.get('/api/tasks/:id/delete-preview', (req: Request, res: Response) => {
    const task = taskStore.getTask(req.params['id'] as string);
    if (!task || task.status === 'deleting') {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.json({ preview: buildPreviewForTasks([task], 'task', task.title) });
  });

  router.get('/api/workstreams/:id/delete-preview', (req: Request, res: Response) => {
    const id = req.params['id'] as string;
    const ws = wsStore.getWorkstream(id);
    if (!ws) {
      res.status(404).json({ error: 'Workstream not found' });
      return;
    }
    const tasks = taskStore.listTasksByWorkstream(id);
    res.json({
      preview: buildPreviewForTasks(tasks, 'workstream', `${ws.repository} / ${ws.name}`, [
        { id: ws.id, name: ws.name },
      ]),
    });
  });

  router.get('/api/repo-groups/:repo/delete-preview', (req: Request, res: Response) => {
    const repo = decodeURIComponent(req.params['repo'] as string);
    const tasks = taskStore.listTasksByRepository(repo);
    const workstreams = wsStore
      .listWorkstreams(repo)
      .map((w) => ({ id: w.id, name: w.name }));
    res.json({ preview: buildPreviewForTasks(tasks, 'repo', repo, workstreams) });
  });

  // ─── Hard delete endpoints ────────────────────────────────

  router.delete('/api/tasks/:id', (req: Request, res: Response) => {
    try {
      const task = taskStore.getTask(req.params['id'] as string);
      if (!task) {
        // Row already gone — DELETE is idempotent. Return 204 so retrying
        // a delete after a partial failure or pod restart is a no-op.
        res.status(204).send();
        return;
      }
      purgeTask(io, task);
      res.status(204).send();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, 'Failed to delete task');
      res.status(500).json({ error: 'Failed to delete task', details: message });
    }
  });

  router.delete('/api/workstreams/:id', (req: Request, res: Response) => {
    try {
      const id = req.params['id'] as string;
      const ws = wsStore.getWorkstream(id);
      // Iterate over ALL tasks for this workstream including ones already
      // mid-teardown — purgeTask is idempotent and will just re-schedule.
      const tasks = taskStore.listTasksByWorkstream(id);
      for (const t of tasks) {
        purgeTask(io, t);
      }
      if (ws) {
        wsStore.deleteWorkstream(id);
        io.emit('workstream:deleted', { workstreamId: id });
      }
      logger.info(
        { workstreamId: id, taskCount: tasks.length, wsExisted: !!ws },
        'Workstream purge requested',
      );
      res.status(204).send();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, 'Failed to delete workstream');
      res.status(500).json({ error: 'Failed to delete workstream', details: message });
    }
  });

  router.delete('/api/repo-groups/:repo', (req: Request, res: Response) => {
    try {
      const repo = decodeURIComponent(req.params['repo'] as string);
      const tasks = taskStore.listTasksByRepository(repo);
      for (const t of tasks) {
        purgeTask(io, t);
      }
      const ids = wsStore.listWorkstreamIdsForRepo(repo);
      for (const id of ids) wsStore.deleteWorkstream(id);
      io.emit('repo-group:deleted', { repository: repo });
      logger.info(
        { repository: repo, taskCount: tasks.length, workstreamCount: ids.length },
        'Repo group purge requested',
      );
      res.status(204).send();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, 'Failed to delete repo group');
      res.status(500).json({ error: 'Failed to delete repo group', details: message });
    }
  });

  return router;
}
