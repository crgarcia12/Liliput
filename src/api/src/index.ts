import http from 'node:http';
import { Server as SocketServer } from 'socket.io';
import { createApp } from './app.js';
import { setupWebSocket } from './ws/handler.js';
import { stopCopilotClient } from './engine/copilot-client.js';
import { reconcileOrphanedRuns, backfillDefaultWorkstreams } from './stores/task-store.js';
import { purgeOrphanWorkspaces, restoreDevRoutesFromStore } from './engine/agent-engine.js';
import { logger } from './logger.js';

const PORT = parseInt(process.env['PORT'] ?? '5001', 10);

const server = http.createServer();
const io = new SocketServer(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const app = createApp(io);
server.on('request', app);

setupWebSocket(io);

// Sweep orphaned in-flight state from any previous container.
const reconciled = reconcileOrphanedRuns();
if (reconciled.agentsReset > 0 || reconciled.tasksFailed > 0) {
  logger.warn(reconciled, '🧹 Reconciled orphaned runs from previous container');
} else {
  logger.info('🧹 No orphaned runs to reconcile');
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

server.listen(PORT, () => {
  logger.info({ port: PORT }, '🏝️  Liliput API listening');
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutting down');
  await stopCopilotClient();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
