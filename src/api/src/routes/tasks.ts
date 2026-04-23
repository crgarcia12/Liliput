import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Server as SocketServer } from 'socket.io';
import type { CreateTaskRequest, ChatRequest } from '../../../shared/types/index.js';
import * as store from '../stores/task-store.js';
import { generateSpec } from '../engine/spec-generator.js';
import { startBuild } from '../engine/agent-engine.js';
import { logger } from '../logger.js';

export function createTasksRouter(io: SocketServer): Router {
  const router = Router();

  // POST /api/tasks — create a new task
  router.post('/api/tasks', (req: Request, res: Response) => {
    try {
      const { title, description, repository } = req.body as CreateTaskRequest;
      if (!title || !description) {
        res.status(400).json({ error: 'title and description are required' });
        return;
      }

      const task = store.createTask(title, description, repository);

      // Add system welcome message
      store.addChatMessage(
        task.id,
        'system',
        `Task "${title}" created. Tell me more about what you need, Gulliver!`,
      );

      logger.info({ taskId: task.id }, 'Task created');
      res.status(201).json({ task });
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

      // Auto-respond based on status
      if (task.status === 'clarifying') {
        store.updateTask(task.id, { status: 'specifying' });
        io.to(`task:${task.id}`).emit('task:status', { taskId: task.id, status: 'specifying' });

        const spec = generateSpec(task.title, `${task.description}\n\nAdditional context: ${message}`);
        store.updateTask(task.id, { spec });
        io.to(`task:${task.id}`).emit('task:spec', { taskId: task.id, spec });

        const sysMsg = store.addChatMessage(
          task.id,
          'liliput',
          'I\'ve drafted a specification based on your requirements. Please review and approve it to start building!',
        );
        io.to(`task:${task.id}`).emit('chat:message', sysMsg);
      } else {
        const sysMsg = store.addChatMessage(
          task.id,
          'liliput',
          `Noted! The task is currently in "${task.status}" status.`,
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

  // DELETE /api/tasks/:id — cancel/delete a task
  router.delete('/api/tasks/:id', (req: Request, res: Response) => {
    try {
      const taskId = req.params['id'] as string;
      const deleted = store.deleteTask(taskId);
      if (!deleted) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      logger.info({ taskId }, 'Task deleted');
      res.status(204).send();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, 'Failed to delete task');
      res.status(500).json({ error: 'Failed to delete task', details: message });
    }
  });

  return router;
}
