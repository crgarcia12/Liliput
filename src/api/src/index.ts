import { installEffortTracer } from './engine/effort-tracer.js';
// IMPORTANT: install the fetch wrapper before any other module imports the
// Copilot SDK — the SDK captures globalThis.fetch at load time on some paths.
installEffortTracer();

import http from 'node:http';
import { Server as SocketServer } from 'socket.io';
import { createApp } from './app.js';
import { setupWebSocket } from './ws/handler.js';
import { stopCopilotClient } from './engine/copilot-client.js';
import { reconcileOrphanedRuns, backfillDefaultWorkstreams } from './stores/task-store.js';
import {
  purgeOrphanWorkspaces,
  restoreDevRoutesFromStore,
  autoResumeInterruptedTasks,
  interruptTaskAgentTurn,
  iterateTask,
  resumeCampaignTask,
  startBuild,
} from './engine/agent-engine.js';
import { runDeletingSweeper } from './routes/workstreams.js';
import { ensureAzLogin } from './engine/azure-builder.js';
import { startReconciler } from './engine/loop-reconciler.js';
import { logger } from './logger.js';
import { isAutoResumeEnabled, autoResumeConcurrency, getPodId } from './engine/pod-identity.js';
import { startInternalServer } from './internal-server.js';
import { startAutonomousCampaignCoordinator } from './engine/autonomous-campaign-coordinator.js';
import { cancelAutonomousCampaignProposal } from './engine/autonomous-campaign-proposal.js';
import { findPullRequestByHead } from './engine/github-pr.js';

const PORT = parseInt(process.env['PORT'] ?? '5001', 10);

const server = http.createServer();
const io = new SocketServer(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const app = createApp(io, {
  campaignControl: {
    owner: getPodId(),
    interruptTask: interruptTaskAgentTurn,
    resumeTask: (taskId) =>
      resumeCampaignTask(io, taskId, { queueIfActive: true }),
    cancelProposal: cancelAutonomousCampaignProposal,
  },
});
server.on('request', app);

setupWebSocket(io);

// Sweep orphaned in-flight state from any previous container.
const reconciled = reconcileOrphanedRuns();
if (reconciled.agentsReset > 0 || reconciled.tasksFailed > 0) {
  logger.warn(reconciled, '🧹 Reconciled orphaned runs from previous container');
} else {
  logger.info('🧹 No orphaned runs to reconcile');
}

// Auto-resume tasks that were mid-`building` when we died. See
// `autoResumeInterruptedTasks` for the multi-pod safety caveat.
const replicaCount = parseInt(process.env['LILIPUT_REPLICA_COUNT'] ?? '1', 10);
if (reconciled.resumable.length > 0 && isAutoResumeEnabled()) {
  if (Number.isFinite(replicaCount) && replicaCount > 1) {
    logger.warn(
      { podId: getPodId(), replicaCount, candidates: reconciled.resumable.length },
      '⚠️  Auto-resume is unsafe with >1 replica (no lease enforcement yet) — skipping',
    );
  } else {
    logger.info(
      { podId: getPodId(), candidates: reconciled.resumable.length },
      '🔁 Auto-resuming tasks interrupted by previous container',
    );
    autoResumeInterruptedTasks(io, reconciled.resumable, {
      concurrency: autoResumeConcurrency(),
    })
      .then((res) => logger.info(res, '🔁 Auto-resume kicked off'))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ err: msg }, 'Auto-resume failed (non-fatal)');
      });
  }
} else if (reconciled.resumable.length > 0) {
  logger.info(
    { candidates: reconciled.resumable.length },
    '🔁 Auto-resume disabled (LILIPUT_AUTO_RESUME=false) — leaving tasks failed',
  );
}

// Backfill the workstream FK for tasks created before workstreams existed.
const backfill = backfillDefaultWorkstreams();
if (backfill.tasksAssigned > 0 || backfill.workstreamsCreated > 0) {
  logger.info(backfill, '🧬 Backfilled default workstreams for legacy tasks');
}

// Reclaim PVC space from workspaces whose tasks are no longer active.
purgeOrphanWorkspaces()
  .then((res) => {
    if (res.removed > 0) {
      logger.warn(res, '🧹 Purged orphan agent workspaces');
    } else {
      logger.info(res, '🧹 No orphan workspaces to purge');
    }
  })
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, 'Workspace orphan purge failed (non-fatal)');
  });

// Rebuild the gateway route table from previously-deployed tasks. Without
// this, the next deploy after a restart would overwrite nginx with only its
// own route — all older /dev/<owner>/<repo>/<branch> URLs would 404 even
// though their pods are still running.
restoreDevRoutesFromStore()
  .then((res) => {
    if (res.restored > 0) {
      logger.info(res, '🌐 Restored gateway routes for live dev environments');
    } else {
      logger.info('🌐 No dev-env gateway routes to restore');
    }
  })
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, 'Dev-route restore failed (non-fatal)');
  });

// Resume any teardowns that didn't finish before the previous pod died.
// Tasks with status='deleting' get retried; idempotent — every step
// (close PR, delete namespace, delete branch, rm workspace) tolerates
// "already gone".
runDeletingSweeper(io);

// Eager `az login` via workload identity. Best-effort — if creds aren't
// present (local dev), we just log a warning. Doing this at startup means
// the first agent-issued `az ...` command works immediately, instead of
// having to wait for an `acrBuild` call to lazily authenticate the CLI.
ensureAzLogin()
  .then(() => logger.info('🔐 Azure CLI authenticated via workload identity'))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, 'Eager az login failed (non-fatal — agents will see auth errors if they call `az`)');
  });

server.listen(PORT, () => {
  logger.info({ port: PORT }, '🏝️  Liliput API listening');
});

// PM/Dev/RM loop reconciler — polls GitHub for issues/PRs we might have
// missed (webhook down, polling_fallback repos, dropped deliveries). Opt-in
// so unit/integration tests don't accidentally start the timer.
if (process.env['LILIPUT_RECONCILER_ENABLED'] === '1') {
  const interval = parseInt(process.env['LILIPUT_RECONCILER_INTERVAL_MS'] ?? '', 10);
  startReconciler(io, Number.isFinite(interval) && interval > 0 ? { intervalMs: interval } : {});
}

const stopCampaignCoordinator = startAutonomousCampaignCoordinator({
  startTaskPipeline: (taskId) => startBuild(io, taskId),
  resumeTaskPipeline: (taskId) =>
    iterateTask(
      io,
      taskId,
      'Resume the same autonomous campaign delivery attempt from its persisted branch and checkpoints.',
    ),
  interruptTask: interruptTaskAgentTurn,
  findPullRequest: findPullRequestByHead,
});

// Privileged loopback-only listener for orchestrator-driven tools.
const internalServer = startInternalServer();

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutting down');
  stopCampaignCoordinator();
  await stopCopilotClient();
  if (internalServer) internalServer.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
