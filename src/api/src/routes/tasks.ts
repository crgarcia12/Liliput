import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Server as SocketServer } from 'socket.io';
import type { CreateTaskRequest, ChatRequest } from '../../../shared/types/index.js';
import * as store from '../stores/task-store.js';
import * as wsStore from '../stores/workstream-store.js';
import { generateSpec as defaultGenerateSpec, type SpecGenerator } from '../engine/spec-generator.js';
import { listDevPods, getPodLogs } from '../engine/k8s-deployer.js';
import { startBuild, shipTask, discardTask, iterateTask, canIterate, enqueueChatForAgent, hasInFlightAgent } from '../engine/agent-engine.js';
import { logger } from '../logger.js';

export function createTasksRouter(
  io: SocketServer,
  specGenerator: SpecGenerator = defaultGenerateSpec,
): Router {
  const router = Router();

  // POST /api/tasks — create a new task
  router.post('/api/tasks', (req: Request, res: Response) => {
    try {
      const { title, description, repository, baseBranch, commitMode, workstreamId } =
        req.body as CreateTaskRequest;
      if (!title || !description) {
        res.status(400).json({ error: 'title and description are required' });
        return;
      }

      // Resolve the parent workstream. Explicit ID wins. Otherwise, fall back
      // to the default workstream for the repo (auto-created on first use).
      let resolvedWorkstreamId: string | undefined;
      if (workstreamId) {
        const ws = wsStore.getWorkstream(workstreamId);
        if (!ws) {
          res.status(400).json({ error: `Workstream not found: ${workstreamId}` });
          return;
        }
        resolvedWorkstreamId = ws.id;
      } else if (repository) {
        resolvedWorkstreamId = wsStore.ensureDefaultWorkstream(repository).id;
      }

      const task = store.createTask(title, description, repository, {
        baseBranch,
        commitMode,
        ...(resolvedWorkstreamId ? { workstreamId: resolvedWorkstreamId } : {}),
      });

      // Add system welcome message
      store.addChatMessage(
        task.id,
        'system',
        `Task "${title}" created. Tell me more about what you need, Gulliver!`,
      );

      logger.info({ taskId: task.id }, 'Task created');
      const created = store.getTask(task.id) ?? task;
      res.status(201).json({ task: created });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, 'Failed to create task');
      res.status(500).json({ error: 'Failed to create task', details: message });
    }
  });

  // GET /api/tasks — list all tasks
  router.get('/api/tasks', (_req: Request, res: Response) => {
    try {
      const tasks = store.getTasks();
      res.json({ tasks });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, 'Failed to list tasks');
      res.status(500).json({ error: 'Failed to list tasks', details: message });
    }
  });

  // GET /api/tasks/:id — get task details
  router.get('/api/tasks/:id', (req: Request, res: Response) => {
    try {
      const task = store.getTask(req.params['id'] as string);
      if (!task) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      res.json({ task });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, 'Failed to get task');
      res.status(500).json({ error: 'Failed to get task', details: message });
    }
  });

  // POST /api/tasks/:id/chat — send a chat message
  router.post('/api/tasks/:id/chat', (req: Request, res: Response) => {
    try {
      const task = store.getTask(req.params['id'] as string);
      if (!task) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }

      const { message } = req.body as ChatRequest;
      if (!message) {
        res.status(400).json({ error: 'message is required' });
        return;
      }

      // Record the user (Gulliver) message
      const userMsg = store.addChatMessage(task.id, 'gulliver', message);
      io.to(`task:${task.id}`).emit('chat:message', userMsg);
      logger.info(
        { taskId: task.id, status: task.status, msgPreview: message.substring(0, 80) },
        'Chat message received',
      );

      // Auto-respond based on status
      if (task.status === 'clarifying') {
        store.updateTask(task.id, { status: 'specifying' });
        io.to(`task:${task.id}`).emit('task:status', { taskId: task.id, status: 'specifying' });

        const ackMsg = store.addChatMessage(
          task.id,
          'liliput',
          'Drafting a specification with the LLM — this can take a moment…',
        );
        io.to(`task:${task.id}`).emit('chat:message', ackMsg);

        // Generate spec asynchronously; HTTP response returns immediately.
        // The spec arrives over WebSocket via `task:spec` when ready.
        void specGenerator(task.title, `${task.description}\n\nAdditional context: ${message}`)
          .then((spec) => {
            store.updateTask(task.id, { spec });
            io.to(`task:${task.id}`).emit('task:spec', { taskId: task.id, spec });

            const sysMsg = store.addChatMessage(
              task.id,
              'liliput',
              'I\'ve drafted a specification based on your requirements. Please review and approve it to start building!',
            );
            io.to(`task:${task.id}`).emit('chat:message', sysMsg);
          })
          .catch((specErr: unknown) => {
            const errMessage = specErr instanceof Error ? specErr.message : String(specErr);
            logger.error({ taskId: task.id, err: errMessage }, 'Spec generation failed');
            const sysMsg = store.addChatMessage(
              task.id,
              'system',
              `Spec generation failed: ${errMessage}`,
            );
            io.to(`task:${task.id}`).emit('chat:message', sysMsg);
          });
      } else if (
        (task.status === 'review' || task.status === 'completed' || task.status === 'failed') &&
        canIterate(task.id)
      ) {
        // Follow-up: iterate on the same workspace + branch + PR.
        // canIterate also matches when the in-memory session was lost (pod
        // restart) but the task has enough persisted metadata for us to
        // resurrect it inside iterateTask. 'failed' tasks are also iterable
        // so the user can chat their way out of a broken build.
        const ackText =
          task.status === 'failed'
            ? '🩹 Last run failed — picking it back up on the same branch and trying again with your message…'
            : '🔁 Iterating on the same branch — running another agent turn…';
        const ackMsg = store.addChatMessage(task.id, 'liliput', ackText);
        if (ackMsg) io.to(`task:${task.id}`).emit('chat:message', ackMsg);
        iterateTask(io, task.id, message);
      } else if (hasInFlightAgent(task.id) && enqueueChatForAgent(task.id, message)) {
        // Mid-flight preemption: an agent turn is currently running. Queue the
        // message and abort the in-flight turn so the agent stops and addresses
        // the new instruction on the next turn (same SDK session, full memory).
        const ackMsg = store.addChatMessage(
          task.id,
          'liliput',
          '🛑 Interrupting the agent — it will handle your message on its next turn.',
        );
        if (ackMsg) io.to(`task:${task.id}`).emit('chat:message', ackMsg);
      } else {
        const reason = !task.repository
          ? `repository is not set on this task`
          : !task.branch
          ? `branch is not set yet (the agent hasn't created one)`
          : `task is in "${task.status}" status which doesn't support chat iteration`;
        logger.info({ taskId: task.id, status: task.status, reason }, 'Chat received but task is not iterable');
        const sysMsg = store.addChatMessage(
          task.id,
          'liliput',
          `⚠️ I can't act on this message right now: ${reason}.`,
        );
        io.to(`task:${task.id}`).emit('chat:message', sysMsg);
      }

      const updatedTask = store.getTask(task.id);
      res.json({ task: updatedTask });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, 'Failed to process chat');
      res.status(500).json({ error: 'Failed to process chat', details: message });
    }
  });

  // POST /api/tasks/:id/approve-spec — approve spec and start building
  router.post('/api/tasks/:id/approve-spec', (req: Request, res: Response) => {
    try {
      const task = store.getTask(req.params['id'] as string);
      if (!task) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }

      if (task.status !== 'specifying') {
        res.status(400).json({ error: `Cannot approve spec in "${task.status}" status. Task must be in "specifying" status.` });
        return;
      }

      if (!task.spec) {
        res.status(400).json({ error: 'No spec to approve. Send a chat message first to generate the spec.' });
        return;
      }

      store.updateTask(task.id, { status: 'building' });
      io.to(`task:${task.id}`).emit('task:status', { taskId: task.id, status: 'building' });

      store.addChatMessage(
        task.id,
        'system',
        'Spec approved! Summoning the Liliputians… 🏗️',
      );

      // Start the agent build pipeline
      startBuild(io, task.id);

      const updatedTask = store.getTask(task.id);
      res.json({ task: updatedTask });
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      logger.error({ err: errMessage }, 'Failed to approve spec');
      res.status(500).json({ error: 'Failed to approve spec', details: errMessage });
    }
  });

  // POST /api/tasks/:id/ship — open PR (or auto-merge for direct mode)
  router.post('/api/tasks/:id/ship', async (req: Request, res: Response) => {
    try {
      const taskId = req.params['id'] as string;
      const updated = await shipTask(io, taskId);
      res.json({ task: updated });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, 'Failed to ship task');
      res.status(500).json({ error: 'Failed to ship task', details: message });
    }
  });

  // POST /api/tasks/:id/discard — tear down dev env + delete branch
  router.post('/api/tasks/:id/discard', async (req: Request, res: Response) => {
    try {
      const taskId = req.params['id'] as string;
      const updated = await discardTask(io, taskId);
      res.json({ task: updated });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, 'Failed to discard task');
      res.status(500).json({ error: 'Failed to discard task', details: message });
    }
  });

  // GET /api/tasks/:id/dev-pods — list pods in the task's dev namespace with status
  router.get('/api/tasks/:id/dev-pods', async (req: Request, res: Response) => {
    try {
      const task = store.getTask(req.params['id'] as string);
      if (!task) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      if (!task.devNamespace) {
        res.json({ namespace: null, pods: [] });
        return;
      }
      const pods = await listDevPods(task.devNamespace);
      res.json({ namespace: task.devNamespace, pods });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, 'Failed to list dev pods');
      res.status(500).json({ error: 'Failed to list dev pods', details: message });
    }
  });

  // GET /api/tasks/:id/dev-logs — read logs from a pod in the dev namespace
  // Query params: pod (optional — auto-pick first), container, tail, previous=1
  router.get('/api/tasks/:id/dev-logs', async (req: Request, res: Response) => {
    try {
      const task = store.getTask(req.params['id'] as string);
      if (!task) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      if (!task.devNamespace) {
        res.status(400).json({ error: 'Task has no dev namespace yet' });
        return;
      }
      let podName = (req.query['pod'] as string | undefined)?.trim();
      const container = (req.query['container'] as string | undefined)?.trim() || undefined;
      const tailLines = Math.min(5000, Math.max(50, Number(req.query['tail'] ?? 500)));
      const previous = req.query['previous'] === '1' || req.query['previous'] === 'true';

      if (!podName) {
        const pods = await listDevPods(task.devNamespace);
        if (pods.length === 0) {
          res.json({ namespace: task.devNamespace, pod: null, logs: '(no pods in namespace)' });
          return;
        }
        const running = pods.find((p) => p.phase === 'Running') ?? pods[0]!;
        podName = running.name;
      }

      const logs = await getPodLogs(task.devNamespace, podName, { container, tailLines, previous });
      res.json({ namespace: task.devNamespace, pod: podName, container: container ?? null, logs });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, 'Failed to read dev logs');
      res.status(500).json({ error: 'Failed to read dev logs', details: message });
    }
  });

  return router;
}
