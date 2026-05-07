/**
 * Pod identity + multi-replica safety guards.
 *
 * Today Liliput runs as a single replica (k8s/liliput.yaml uses
 * `strategy: Recreate` and `replicas: 1`). The auto-resume mechanism
 * (see `autoResumeInterruptedTasks`) assumes exactly one pod owns the
 * SQLite DB + workspaces PVC. Running >1 replica on the same DB +
 * RWO PVC will corrupt state — this module surfaces that loud and clear.
 *
 * Forward-compat for scale-out:
 *   - PodId is a stable per-pod identifier (k8s sets HOSTNAME to the pod
 *     name; outside k8s we generate a random UUID).
 *   - The `tasks.owner_pod_id` + `tasks.lease_expires_at` columns let
 *     a future leasing implementation claim tasks safely. Phase 2 work
 *     would: (a) heartbeat-extend the lease while a task is active,
 *     (b) only auto-resume tasks whose lease is expired, (c) reject
 *     cross-pod chat messages or proxy them to the owning pod.
 *
 * Today we only WRITE these fields (so the audit trail is meaningful)
 * — we do not enforce them.
 */

import { randomUUID } from 'node:crypto';

const POD_ID = process.env['HOSTNAME'] ?? `local-${randomUUID().slice(0, 8)}`;

export function getPodId(): string {
  return POD_ID;
}

/**
 * Default lease duration. Future scale-out will heartbeat-extend leases
 * for active tasks and only let another pod claim a task once its lease
 * has expired.
 */
export const LEASE_DURATION_MS = 90_000;

/**
 * `true` when the deployment is opting into auto-resume on boot.
 * Default is `true` — single-pod is safe and matches the user's request.
 * Set `LILIPUT_AUTO_RESUME=false` to disable (e.g., during a multi-pod
 * rollout before lease enforcement is implemented).
 */
export function isAutoResumeEnabled(): boolean {
  const v = (process.env['LILIPUT_AUTO_RESUME'] ?? 'true').toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

/** Max number of tasks to resume in parallel on boot. Keeps the API breathing. */
export function autoResumeConcurrency(): number {
  const n = parseInt(process.env['LILIPUT_AUTO_RESUME_CONCURRENCY'] ?? '3', 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
}
