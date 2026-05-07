import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Server as SocketServer } from 'socket.io';
import type { CreateTaskRequest, ChatRequest, ModelsResponse } from '../../../shared/types/index.js';
import { DEFAULT_MODEL_ID } from '../../../shared/types/index.js';
import { listAvailableModels } from '../engine/copilot-client.js';
import * as store from '../stores/task-store.js';
import * as wsStore from '../stores/workstream-store.js';
import { generateSpec as defaultGenerateSpec, type SpecGenerator } from '../engine/spec-generator.js';
import { listDevPods, getPodLogs } from '../engine/k8s-deployer.js';
import { startBuild, shipTask, discardTask, iterateTask, canIterate, enqueueChatForAgent, hasInFlightAgent, stopDevEnvForTask, startDevEnvForTask, deleteDevEnvForTask } from '../engine/agent-engine.js';
import { verifyRepositoryAccess } from '../engine/github-pr.js';
import { runFeatureDecomposer } from '../engine/feature-decomposer-runner.js';
import * as featureStore from '../stores/feature-store.js';
import { logger } from '../logger.js';

/**
 * Run the LLM decomposer and persist Feature rows for a workstream.
 *
 * Best-effort: any failure is swallowed (logged only). Skips if the
 * workstream already has features (idempotent for repeat spec edits).
 */
async function decomposeAndPersist(
  workstreamId: string,
  title: string,
  spec: string,
  model?: string,
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh',
): Promise<void> {
  const existing = featureStore.listFeaturesByWorkstream(workstreamId);
  if (existing.length > 0) {
    logger.info(
      { workstreamId, existing: existing.length },
      'decomposer: workstream already has features — skipping',
    );
    return;
  }
  const decomp = await runFeatureDecomposer({ workstreamId, title, spec }, model, reasoningEffort);
  if (!decomp) {
    logger.info({ workstreamId }, 'decomposer: no decomposition — single-feature fallback');
    return;
  }
  for (const f of decomp.features) {
    featureStore.createFeature({
      workstreamId,
      name: f.name,
      slug: f.slug,
      kind: 'feature',
      ...(f.description ? { description: f.description } : {}),
      ...(f.specPath ? { specPath: f.specPath } : {}),
      position: f.position,
      ...(f.dependsOn?.length ? { dependsOn: f.dependsOn } : {}),
    });
  }
  if (decomp.integration) {
    const i = decomp.integration;
    featureStore.createFeature({
      workstreamId,
      name: i.name,
      slug: i.slug,
      kind: 'integration',
      ...(i.description ? { description: i.description } : {}),
      ...(i.specPath ? { specPath: i.specPath } : {}),
      position: 999,
    });
  }
  logger.info(
    {
      workstreamId,
      features: decomp.features.length,
      hasIntegration: !!decomp.integration,
    },
    'decomposer: persisted features',
  );
}

export function createTasksRouter(
  io: SocketServer,
  specGenerator: SpecGenerator = defaultGenerateSpec,
): Router {
  const router = Router();

  // POST /api/tasks — create a new task
  router.post('/api/tasks', async (req: Request, res: Response) => {
    try {
      const { title, description, repository, baseBranch, commitMode, workstreamId, model, reasoningEffort } =
        req.body as CreateTaskRequest;
      logger.info(
        {
          path: '/api/tasks',
          repository,
          baseBranch,
          commitMode,
          workstreamId,
          model,
          reasoningEffort,
          hasTitle: !!title,
          hasDescription: !!description,
        },
        'POST /api/tasks received',
      );
      if (!title || !description) {
        res.status(400).json({ error: 'title and description are required' });
        return;
      }

      // Validate model id against the live SDK list (if provided). Reject
      // unknown ids loudly so typos don't silently fall through to a SDK
      // session that may then take 30s to fail. We re-fetch (cached for 5min)
      // from `client.listModels()` so this stays accurate as Copilot ships new
      // models — the curated static list is only a fallback.
      if (model) {
        const { models } = await listAvailableModels();
        if (!models.some((m) => m.id === model)) {
          res.status(400).json({
            error: `Unknown model: ${model}. Allowed: ${models.map((m) => m.id).join(', ')}`,
            field: 'model',
          });
          return;
        }
      }

      // Validate reasoning effort if provided. Allowed: low | medium | high | xhigh.
      const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
      if (reasoningEffort && !REASONING_EFFORTS.includes(reasoningEffort as typeof REASONING_EFFORTS[number])) {
        res.status(400).json({
          error: `Unknown reasoningEffort: ${reasoningEffort}. Allowed: ${REASONING_EFFORTS.join(', ')}`,
          field: 'reasoningEffort',
        });
        return;
      }

      // Fail loudly on typoed / inaccessible repos. Without this an invalid
      // repo silently propagates to the coder phase, which logs a confusing
      // "Repository not found" deep in the agent loop with no UI signal.
      if (repository) {
        const verification = await verifyRepositoryAccess(repository);
        if (!verification.ok) {
          logger.warn(
            { repository, status: verification.status, reason: verification.reason },
            'Rejecting task creation: repository not accessible',
          );
          res.status(verification.status === 502 ? 502 : 400).json({
            error: verification.reason,
            field: 'repository',
          });
          return;
        }
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
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
      });

      // Add system welcome message
      store.addChatMessage(
        task.id,
        'system',
        `Task "${title}" created. Tell me more about what you need, Gulliver!`,
      );

      logger.info({ taskId: task.id, model: task.model ?? 'default' }, 'Task created');
      const created = store.getTask(task.id) ?? task;
      res.status(201).json({ task: created });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, 'Failed to create task');
      res.status(500).json({ error: 'Failed to create task', details: message });
    }
  });

  // GET /api/models — list available Copilot SDK models for the picker.
  // Pulled from `client.listModels()` (5-min cache). Falls back to a small
  // static list when the SDK is unreachable.
  router.get('/api/models', async (_req: Request, res: Response) => {
    try {
      const { models, source } = await listAvailableModels();
      const body: ModelsResponse & { source: string } = {
        options: models,
        default: models.some((m) => m.id === DEFAULT_MODEL_ID) ? DEFAULT_MODEL_ID : (models[0]?.id ?? DEFAULT_MODEL_ID),
        source,
      };
      res.json(body);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, 'Failed to list models');
      res.status(500).json({ error: 'Failed to list models', details: message });
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
      if (!task || task.status === 'deleting') {
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
      if (!task || task.status === 'deleting') {
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

      // Auto-resurrect a stopped/deleted dev env before any status-based routing.
      // We must NOT race with iterateTask (which redeploys), so the resurrection
      // is fire-and-forget but the user's message is queued for the agent (via
      // enqueueChatForAgent) — once the env is back, the agent picks it up on
      // its next turn. The HTTP response returns immediately.
      const devEnvState = task.devEnvState ?? 'active';
      if ((devEnvState === 'stopped' || devEnvState === 'deleted') && task.imageRef && task.devNamespace && task.devPort) {
        const ackMsg = store.addChatMessage(
          task.id,
          'liliput',
          `♻️ Dev environment was ${devEnvState} — bringing it back online before processing your message…`,
        );
        if (ackMsg) io.to(`task:${task.id}`).emit('chat:message', ackMsg);
        void (async () => {
          try {
            await startDevEnvForTask(io, task.id);
          } catch {
            return; // startDevEnvForTask already posted an error chat msg
          }
          // Re-fetch and route as if the message had just arrived.
          const refreshed = store.getTask(task.id);
          if (!refreshed) return;
          if (
            (refreshed.status === 'review' || refreshed.status === 'completed' || refreshed.status === 'failed') &&
            canIterate(refreshed.id)
          ) {
            iterateTask(io, refreshed.id, message);
          }
        })();
        const updatedTask = store.getTask(task.id);
        res.json({ task: updatedTask });
        return;
      }

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
        // Pass repo context so the LLM grounds the spec in what the target
        // repo actually is (README, manifests, tree) instead of guessing
        // from the title — otherwise vague descriptions like "modernize
        // this thing" cause the LLM to invent a project.
        //
        // onProgress turns each stage into a chat message so the user
        // sees what's happening (clone, file read, LLM call) in real time.
        const stageLabels: Record<string, string> = {
          'cloning': '📦 Cloning the target repo (depth=1)',
          'reading-files': '📖 Reading README, manifests, and file tree',
          'extracted': '✅ Repo context extracted',
          'clone-failed': '⚠️ Could not clone the repo — drafting from title/description only',
          'connecting-llm': '🔌 Connecting to the LLM',
          'drafting': '✍️ Drafting the specification',
          'spec-ready': '✅ Specification draft ready',
          'spec-failed': '⚠️ Spec generation failed — falling back to template',
        };
        void specGenerator(
          task.title,
          `${task.description}\n\nAdditional context: ${message}`,
          {
            ...(task.repository ? { repository: task.repository } : {}),
            ...(task.baseBranch ? { baseBranch: task.baseBranch } : {}),
            ...(task.model ? { model: task.model } : {}),
            ...(task.reasoningEffort ? { reasoningEffort: task.reasoningEffort } : {}),
            taskId: task.id,
            onProgress: (stage, detail) => {
              const label = stageLabels[stage] ?? stage;
              const text = detail ? `${label} — ${detail}` : label;
              const msg = store.addChatMessage(task.id, 'liliput', text);
              io.to(`task:${task.id}`).emit('chat:message', msg);
              io.to(`task:${task.id}`).emit('task:progress', {
                taskId: task.id,
                phase: 'specifying',
                stage,
                detail,
              });
            },
          },
        )
          .then((spec) => {
            store.updateTask(task.id, { spec });
            io.to(`task:${task.id}`).emit('task:spec', { taskId: task.id, spec });

            const sysMsg = store.addChatMessage(
              task.id,
              'liliput',
              'I\'ve drafted a specification based on your requirements. Please review and approve it to start building!',
            );
            io.to(`task:${task.id}`).emit('chat:message', sysMsg);

            // Best-effort decomposition (behind feature flag).
            // Splits the spec into feature slices and persists Feature rows
            // for the workstream. NOT YET consumed by the engine — this PR
            // just lights up the data path so we can verify the LLM produces
            // sensible decompositions on real specs before wiring fan-out.
            if (process.env['AUTOPILOT_DECOMPOSE'] === '1' && task.workstreamId) {
              void decomposeAndPersist(task.workstreamId, task.title, spec, task.model, task.reasoningEffort).catch(
                (err: unknown) => {
                  const m = err instanceof Error ? err.message : String(err);
                  logger.warn(
                    { taskId: task.id, err: m },
                    'decomposer: persist step threw — ignoring',
                  );
                },
              );
            }
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
      } else if (
        task.spec &&
        !task.branch &&
        !hasInFlightAgent(task.id) &&
        (task.status === 'failed' || task.status === 'building' || task.status === 'deploying' || task.status === 'shipping')
      ) {
        // Recovery path: the build never produced a branch (e.g. pod died early
        // in startBuild, or the first agent turn crashed before any commit).
        // Spec is persisted, so we can re-kick the full pipeline. This rescues
        // tasks that would otherwise be stranded with "branch is not set yet".
        const ackMsg = store.addChatMessage(
          task.id,
          'liliput',
          '🔁 No branch was created on the previous run — restarting the build from the approved spec with your message as added context…',
        );
        if (ackMsg) io.to(`task:${task.id}`).emit('chat:message', ackMsg);
        const updatedSpec = `${task.spec}\n\n## Additional user guidance\n${message}\n`;
        store.updateTask(task.id, { spec: updatedSpec, status: 'building', errorMessage: undefined });
        io.to(`task:${task.id}`).emit('task:status', { taskId: task.id, status: 'building' });
        startBuild(io, task.id);
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

  // PATCH /api/tasks/:id/title — rename a workstream. Pure metadata, no agent
  // impact. Used by the new-workstream form to backfill the LLM-generated
  // 1-4 word title once /api/title-suggest returns.
  router.patch('/api/tasks/:id/title', (req: Request, res: Response) => {
    try {
      const task = store.getTask(req.params['id'] as string);
      if (!task || task.status === 'deleting') {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      const { title } = (req.body ?? {}) as { title?: string };
      const trimmed = (title ?? '').trim();
      if (!trimmed) {
        res.status(400).json({ error: 'title is required', field: 'title' });
        return;
      }
      const clipped = trimmed.slice(0, 200);
      store.updateTask(task.id, { title: clipped });
      const updated = store.getTask(task.id);
      res.json({ task: updated });
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      logger.error({ err: errMessage }, 'Failed to update task title');
      res.status(500).json({ error: 'Failed to update task title', details: errMessage });
    }
  });

  // PATCH /api/tasks/:id/model — change the Copilot SDK model on a live task.
  // Only takes effect on the NEXT agent turn (we don't kill the in-flight SDK
  // session — that would lose context and is rarely what the operator wants).
  // Allowed in any non-terminal status; rejected on `deleting`.
  router.patch('/api/tasks/:id/model', async (req: Request, res: Response) => {
    try {
      const task = store.getTask(req.params['id'] as string);
      if (!task || task.status === 'deleting') {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      const { model } = (req.body ?? {}) as { model?: string };
      logger.info(
        { taskId: task.id, currentModel: task.model ?? '', incomingBody: req.body, parsedModel: model },
        'PATCH /api/tasks/:id/model received',
      );
      if (!model || !model.trim()) {
        res.status(400).json({ error: 'model is required', field: 'model' });
        return;
      }
      const trimmed = model.trim();
      const { models } = await listAvailableModels();
      if (!models.some((m) => m.id === trimmed)) {
        res.status(400).json({
          error: `Unknown model: ${trimmed}. Allowed: ${models.map((m) => m.id).join(', ')}`,
          field: 'model',
        });
        return;
      }
      const previous = task.model ?? '(default)';
      store.updateTask(task.id, { model: trimmed });
      const sysMsg = store.addChatMessage(
        task.id,
        'system',
        `🔀 Model switched: ${previous} → ${trimmed}. Takes effect on the next agent turn.`,
      );
      io.to(`task:${task.id}`).emit('chat:message', sysMsg);
      const updated = store.getTask(task.id);
      logger.info({ taskId: task.id, from: previous, to: trimmed }, 'Task model updated');
      res.json({ task: updated });
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      logger.error({ err: errMessage }, 'Failed to update task model');
      res.status(500).json({ error: 'Failed to update task model', details: errMessage });
    }
  });

  // PATCH /api/tasks/:id/reasoning-effort — change the SDK reasoning effort
  // hint on a live task. Takes effect on the NEXT agent turn (existing
  // sessions keep their original effort). Pass an empty string or null to
  // clear and let the server auto-derive from the model id (e.g.
  // `claude-opus-4.7-xhigh` -> `xhigh`).
  router.patch('/api/tasks/:id/reasoning-effort', (req: Request, res: Response) => {
    try {
      const task = store.getTask(req.params['id'] as string);
      if (!task || task.status === 'deleting') {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      const { reasoningEffort } = (req.body ?? {}) as { reasoningEffort?: string | null };
      logger.info(
        { taskId: task.id, currentEffort: task.reasoningEffort ?? '', incomingBody: req.body, parsedEffort: reasoningEffort },
        'PATCH /api/tasks/:id/reasoning-effort received',
      );
      const ALLOWED = ['low', 'medium', 'high', 'xhigh'] as const;
      let next: 'low' | 'medium' | 'high' | 'xhigh' | undefined;
      if (reasoningEffort === null || reasoningEffort === '' || reasoningEffort === undefined) {
        next = undefined; // clear -> auto-derive
      } else if (ALLOWED.includes(reasoningEffort as typeof ALLOWED[number])) {
        next = reasoningEffort as typeof ALLOWED[number];
      } else {
        res.status(400).json({
          error: `Unknown reasoningEffort: ${reasoningEffort}. Allowed: ${ALLOWED.join(', ')} (or empty to auto-derive)`,
          field: 'reasoningEffort',
        });
        return;
      }
      const previous = task.reasoningEffort ?? '(auto)';
      // Passing `undefined` falls through the spread merge in updateTask,
      // so the field is dropped from the persisted JSON next round-trip.
      store.updateTask(task.id, { reasoningEffort: next });
      const sysMsg = store.addChatMessage(
        task.id,
        'system',
        `🧠 Reasoning effort: ${previous} → ${next ?? '(auto-derive)'} . Takes effect on the next agent turn.`,
      );
      io.to(`task:${task.id}`).emit('chat:message', sysMsg);
      const updated = store.getTask(task.id);
      logger.info({ taskId: task.id, from: previous, to: next ?? 'auto' }, 'Task reasoningEffort updated');
      res.json({ task: updated });
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : String(err);
      logger.error({ err: errMessage }, 'Failed to update reasoningEffort');
      res.status(500).json({ error: 'Failed to update reasoningEffort', details: errMessage });
    }
  });

  // POST /api/tasks/:id/approve-spec — approve spec and start building
  router.post('/api/tasks/:id/approve-spec', (req: Request, res: Response) => {
    try {
      const task = store.getTask(req.params['id'] as string);
      if (!task || task.status === 'deleting') {
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
      if (!task || task.status === 'deleting') {
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
      if (!task || task.status === 'deleting') {
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

  // ── Dev environment lifecycle ──────────────────────────────────────
  // Stop / Start / Delete the per-task k8s deployment + nginx route.
  // Auto-resurrection on chat is handled in the chat handler above.

  router.post('/api/tasks/:id/dev-env/stop', async (req: Request, res: Response) => {
    try {
      const updated = await stopDevEnvForTask(io, req.params['id'] as string);
      res.json({ task: updated });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err: message }, 'stopDevEnv failed');
      res.status(409).json({ error: 'Failed to stop dev environment', details: message });
    }
  });

  router.post('/api/tasks/:id/dev-env/start', async (req: Request, res: Response) => {
    try {
      const updated = await startDevEnvForTask(io, req.params['id'] as string);
      res.json({ task: updated });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err: message }, 'startDevEnv failed');
      res.status(409).json({ error: 'Failed to start dev environment', details: message });
    }
  });

  router.delete('/api/tasks/:id/dev-env', async (req: Request, res: Response) => {
    try {
      const updated = await deleteDevEnvForTask(io, req.params['id'] as string);
      res.json({ task: updated });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err: message }, 'deleteDevEnv failed');
      res.status(409).json({ error: 'Failed to delete dev environment', details: message });
    }
  });

  return router;
}
