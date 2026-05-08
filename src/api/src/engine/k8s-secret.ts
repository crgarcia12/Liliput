/**
 * Kubernetes Secret CRUD wrapper.
 *
 * Used by `azure-app-registration.ts` to project credentials into dev-env
 * namespaces. Uses Server-Side Apply with a dedicated field manager so we
 * own only the keys we set and never clobber labels/annotations/data added
 * by other tools.
 */

import * as k8s from '@kubernetes/client-node';
import { logger } from '../logger.js';

const kc = new k8s.KubeConfig();
let configured = false;

function getKc(): k8s.KubeConfig {
  if (!configured) {
    try {
      kc.loadFromCluster();
    } catch {
      kc.loadFromDefault();
    }
    configured = true;
  }
  return kc;
}

function coreApi(): k8s.CoreV1Api {
  return getKc().makeApiClient(k8s.CoreV1Api);
}

export interface EnsureSecretOptions {
  namespace: string;
  name: string;
  data: Record<string, string>;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  /** Field-manager identity for Server-Side Apply. */
  fieldManager: string;
}

/**
 * Create or update a Kubernetes Secret using strategic Server-Side Apply.
 *
 * Field manager isolation means re-applies only own the configured keys;
 * other keys/labels/annotations added by other actors are preserved.
 */
export async function ensureK8sSecret(opts: EnsureSecretOptions): Promise<void> {
  const api = coreApi();
  const dataB64: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.data)) {
    dataB64[sanitiseSecretKey(k)] = Buffer.from(v, 'utf8').toString('base64');
  }

  const body: k8s.V1Secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: opts.name,
      namespace: opts.namespace,
      labels: opts.labels,
      annotations: opts.annotations,
    },
    type: 'Opaque',
    data: dataB64,
  };

  // Use patch with apply content type for SSA. Falls back to read-modify-replace
  // on older kube-clients that don't expose patchNamespacedSecret with apply.
  try {
    await api.patchNamespacedSecret(
      {
        name: opts.name,
        namespace: opts.namespace,
        body,
        force: true,
        fieldManager: opts.fieldManager,
      } as Parameters<typeof api.patchNamespacedSecret>[0],
      {
        headers: { 'Content-Type': 'application/apply-patch+yaml' },
      } as never,
    );
    return;
  } catch (err) {
    // Fall through to legacy create-or-replace.
    const code = (err as { code?: number; statusCode?: number }).statusCode;
    if (code && code !== 404) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), name: opts.name, namespace: opts.namespace },
        'Server-side apply failed; falling back to create-or-replace',
      );
    }
  }

  try {
    await api.replaceNamespacedSecret({ name: opts.name, namespace: opts.namespace, body });
  } catch (err) {
    if (isNotFound(err)) {
      await api.createNamespacedSecret({ namespace: opts.namespace, body });
    } else {
      throw err;
    }
  }
}

/** Read a Secret's decoded string data, or null if the secret doesn't exist. */
export async function readK8sSecret(
  namespace: string,
  name: string,
): Promise<Record<string, string> | null> {
  const api = coreApi();
  try {
    const sec = await api.readNamespacedSecret({ name, namespace });
    const data = sec.data ?? {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
      out[k] = Buffer.from(v, 'base64').toString('utf8');
    }
    return out;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Sanitise an arbitrary string into a valid Kubernetes Secret key
 *  (DNS-1123 + dot-separated). Replaces invalid chars with `_`. */
export function sanitiseSecretKey(input: string): string {
  let s = input.replace(/[^A-Za-z0-9_.-]+/g, '_');
  s = s.replace(/^_+|_+$/g, '');
  if (!s) s = 'KEY';
  return s.slice(0, 253);
}

function isNotFound(err: unknown): boolean {
  const e = err as { code?: number; statusCode?: number; body?: { code?: number } };
  return e?.code === 404 || e?.statusCode === 404 || e?.body?.code === 404;
}
