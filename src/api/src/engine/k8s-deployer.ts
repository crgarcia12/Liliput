/**
 * Per-task k8s deployment helpers.
 *
 * Creates a dedicated namespace per (repo, branch) and deploys a single
 * container app to it. Uses the in-cluster service account (which is
 * `liliput-agent` — see k8s/liliput.yaml) for authentication.
 *
 * Cluster RBAC required (see k8s/liliput.yaml `liliput-agent-clusterrole`):
 *   - namespaces: get/create/delete
 *   - deployments, services, pods (in any ns): full
 *   - configmaps in the `liliput` namespace: get/update
 *   - pods/exec in the `liliput` namespace: create
 */

import * as k8s from '@kubernetes/client-node';
import { logger } from '../logger.js';

const kc = new k8s.KubeConfig();
let configured = false;

function getKubeConfig(): k8s.KubeConfig {
  if (!configured) {
    try {
      kc.loadFromCluster();
    } catch {
      // Fall back to user kubeconfig (useful when running locally for dev)
      kc.loadFromDefault();
    }
    configured = true;
  }
  return kc;
}

function coreApi(): k8s.CoreV1Api {
  return getKubeConfig().makeApiClient(k8s.CoreV1Api);
}

function appsApi(): k8s.AppsV1Api {
  return getKubeConfig().makeApiClient(k8s.AppsV1Api);
}

/**
 * Sanitise an arbitrary string into a valid k8s name (DNS-1123 subdomain).
 * - lowercase
 * - replace invalid chars with `-`
 * - collapse runs of `-`
 * - trim leading/trailing `-`
 * - max 50 chars
 */
export function sanitiseK8sName(input: string): string {
  let s = input.toLowerCase();
  s = s.replace(/[^a-z0-9-]+/g, '-');
  s = s.replace(/-{2,}/g, '-');
  s = s.replace(/^-+|-+$/g, '');
  if (s.length > 50) s = s.substring(0, 50).replace(/-+$/, '');
  if (s.length === 0) s = 'env';
  return s;
}

export function devEnvName(repo: string, branch: string): string {
  // repo: "owner/repo"
  const [owner = 'unknown', name = 'repo'] = repo.split('/');
  const safeOwner = sanitiseK8sName(owner);
  const safeName = sanitiseK8sName(name);
  const safeBranch = sanitiseK8sName(branch);
  return sanitiseK8sName(`dev-${safeOwner}-${safeName}-${safeBranch}`);
}

export interface EnsureNamespaceOptions {
  name: string;
  labels?: Record<string, string>;
}

export async function ensureNamespace(opts: EnsureNamespaceOptions): Promise<void> {
  const api = coreApi();
  try {
    await api.readNamespace({ name: opts.name });
    return; // already exists
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await api.createNamespace({
    body: {
      metadata: {
        name: opts.name,
        labels: { 'liliput.dev/dev-env': 'true', ...opts.labels },
      },
    },
  });
}

export async function deleteNamespace(name: string): Promise<void> {
  const api = coreApi();
  try {
    await api.deleteNamespace({ name });
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
}

export interface DeployAppOptions {
  namespace: string;
  appName: string;       // sanitised app name (used for deploy + svc + label)
  image: string;         // full image ref (e.g. acr.io/repo:tag)
  port: number;          // container port
  env?: Record<string, string>;
  /** Path-prefix the app is served under (e.g. "/dev/owner/repo/branch"). */
  pathPrefix?: string;
}

export async function deployApp(opts: DeployAppOptions): Promise<void> {
  const apps = appsApi();
  const core = coreApi();

  const labels = { app: opts.appName, 'liliput.dev/managed': 'true' };
  const envEntries: k8s.V1EnvVar[] = Object.entries(opts.env ?? {}).map(([name, value]) => ({
    name,
    value,
  }));

  // Many web apps need a base-path env hint so they generate correct asset URLs.
  if (opts.pathPrefix) {
    envEntries.push({ name: 'BASE_PATH', value: opts.pathPrefix });
    envEntries.push({ name: 'NEXT_PUBLIC_BASE_PATH', value: opts.pathPrefix });
  }

  const deploymentBody: k8s.V1Deployment = {
    metadata: { name: opts.appName, namespace: opts.namespace, labels },
    spec: {
      replicas: 1,
      strategy: { type: 'Recreate' },
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          containers: [
            {
              name: 'app',
              image: opts.image,
              imagePullPolicy: 'Always',
              ports: [{ containerPort: opts.port }],
              env: envEntries,
              resources: {
                requests: { cpu: '10m', memory: '64Mi' },
                limits: { cpu: '500m', memory: '512Mi' },
              },
            },
          ],
        },
      },
    },
  };

  // Upsert deployment
  try {
    await apps.replaceNamespacedDeployment({
      name: opts.appName,
      namespace: opts.namespace,
      body: deploymentBody,
    });
  } catch (err) {
    if (isNotFound(err)) {
      await apps.createNamespacedDeployment({
        namespace: opts.namespace,
        body: deploymentBody,
      });
    } else {
      throw err;
    }
  }

  // Upsert service
  const serviceBody: k8s.V1Service = {
    metadata: { name: opts.appName, namespace: opts.namespace, labels },
    spec: {
      selector: labels,
      ports: [{ port: 80, targetPort: opts.port }],
      type: 'ClusterIP',
    },
  };
  try {
    await core.replaceNamespacedService({
      name: opts.appName,
      namespace: opts.namespace,
      body: serviceBody,
    });
  } catch (err) {
    if (isNotFound(err)) {
      await core.createNamespacedService({
        namespace: opts.namespace,
        body: serviceBody,
      });
    } else if (isImmutable(err)) {
      // Some service fields are immutable; delete + recreate is fine for dev envs.
      await core.deleteNamespacedService({ name: opts.appName, namespace: opts.namespace });
      await core.createNamespacedService({
        namespace: opts.namespace,
        body: serviceBody,
      });
    } else {
      throw err;
    }
  }
}

export async function waitDeploymentReady(
  namespace: string,
  appName: string,
  timeoutMs = 180_000,
): Promise<boolean> {
  const apps = appsApi();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const dep = await apps.readNamespacedDeployment({ name: appName, namespace });
      const status = dep.status;
      if (status?.readyReplicas && status.readyReplicas >= 1) return true;
    } catch (err) {
      if (!isNotFound(err)) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Error polling deployment',
        );
      }
    }
    await sleep(2000);
  }
  return false;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface DevPodInfo {
  name: string;
  phase: string;
  ready: boolean;
  restarts: number;
  containers: string[];
  startedAt: string | null;
  reason: string | null;
  message: string | null;
}

/** List all pods in a namespace with status info for the dev-environments UI. */
export async function listDevPods(namespace: string): Promise<DevPodInfo[]> {
  const core = coreApi();
  try {
    const list = await core.listNamespacedPod({ namespace });
    return list.items.map((p) => {
      const cs = p.status?.containerStatuses ?? [];
      const restarts = cs.reduce((sum, c) => sum + (c.restartCount ?? 0), 0);
      const ready = cs.length > 0 && cs.every((c) => c.ready);
      const waiting = cs.find((c) => c.state?.waiting);
      const terminated = cs.find((c) => c.state?.terminated);
      return {
        name: p.metadata?.name ?? '',
        phase: p.status?.phase ?? 'Unknown',
        ready,
        restarts,
        containers: (p.spec?.containers ?? []).map((c) => c.name),
        startedAt: p.status?.startTime ? new Date(p.status.startTime).toISOString() : null,
        reason: waiting?.state?.waiting?.reason ?? terminated?.state?.terminated?.reason ?? null,
        message: waiting?.state?.waiting?.message ?? terminated?.state?.terminated?.message ?? null,
      };
    });
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

/** Read logs from a pod (optionally a specific container, optionally previous instance). */
export async function getPodLogs(
  namespace: string,
  podName: string,
  opts: { container?: string; tailLines?: number; previous?: boolean } = {},
): Promise<string> {
  const core = coreApi();
  const tailLines = opts.tailLines ?? 500;
  const params: {
    name: string;
    namespace: string;
    container?: string;
    tailLines: number;
    previous: boolean;
  } = { name: podName, namespace, tailLines, previous: opts.previous ?? false };
  if (opts.container) params.container = opts.container;
  const log = await core.readNamespacedPodLog(params);
  return typeof log === 'string' ? log : String(log ?? '');
}

/** Exec into a single pod by label selector. Returns combined output. */
export async function execInPod(
  namespace: string,
  labelSelector: string,
  command: string[],
): Promise<ExecResult> {
  const core = coreApi();
  const list = await core.listNamespacedPod({ namespace, labelSelector });
  const pod = list.items.find((p) => p.status?.phase === 'Running');
  if (!pod?.metadata?.name) {
    throw new Error(`No running pod found for selector ${labelSelector} in ${namespace}`);
  }
  const exec = new k8s.Exec(getKubeConfig());

  return new Promise<ExecResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const stdoutStream = new (require('node:stream').Writable)({
      write(chunk: Buffer, _enc: string, cb: () => void): void {
        stdout += chunk.toString();
        cb();
      },
    });
    const stderrStream = new (require('node:stream').Writable)({
      write(chunk: Buffer, _enc: string, cb: () => void): void {
        stderr += chunk.toString();
        cb();
      },
    });

    void exec
      .exec(
        namespace,
        pod.metadata!.name!,
        pod.spec?.containers?.[0]?.name ?? 'app',
        command,
        stdoutStream,
        stderrStream,
        null,
        false,
        (status) => {
          const exitCode = status.status === 'Success' ? 0 : 1;
          resolve({ stdout, stderr, exitCode });
        },
      )
      .catch(reject);
  });
}

function isNotFound(err: unknown): boolean {
  const e = err as { code?: number; statusCode?: number; body?: { code?: number } };
  return e?.code === 404 || e?.statusCode === 404 || e?.body?.code === 404;
}

function isImmutable(err: unknown): boolean {
  const msg =
    err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err);
  return /immutable|may not be changed/i.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
