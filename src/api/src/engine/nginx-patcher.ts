/**
 * Patch the `nginx-config` ConfigMap that fronts liliput-gateway so the
 * gateway exposes per-task dev environments at:
 *
 *   http://4.165.50.135/dev/<owner>/<repo>/<branch>/...
 *
 * This works by maintaining a Liliput-managed marker block inside nginx.conf:
 *
 *   # === LILIPUT-DEV-ENVS-BEGIN ===
 *   <generated location blocks>
 *   # === LILIPUT-DEV-ENVS-END ===
 *
 * On each call we read the ConfigMap, regenerate the block from the active
 * routes table (passed in), write the ConfigMap back, then SIGHUP the nginx
 * process inside the gateway pod via pods/exec.
 *
 * State for the routes table lives in the agent-engine module — this file is
 * pure rendering + patching.
 */

import * as k8s from '@kubernetes/client-node';
import { execInPod } from './k8s-deployer.js';

const NS = 'liliput';
const CM_NAME = 'nginx-config';
const NGINX_KEY = 'nginx.conf';
const BEGIN = '# === LILIPUT-DEV-ENVS-BEGIN ===';
const END = '# === LILIPUT-DEV-ENVS-END ===';

const kc = new k8s.KubeConfig();
let configured = false;

function api(): k8s.CoreV1Api {
  if (!configured) {
    try {
      kc.loadFromCluster();
    } catch {
      kc.loadFromDefault();
    }
    configured = true;
  }
  return kc.makeApiClient(k8s.CoreV1Api);
}

export interface DevRoute {
  /** Path prefix without trailing slash — e.g. "/dev/owner/repo/branch" */
  pathPrefix: string;
  /** Service hostname (cluster-internal DNS) e.g. "app.dev-owner-repo-main.svc.cluster.local" */
  upstreamHost: string;
  /** Upstream port (the Service port, usually 80) */
  upstreamPort: number;
}

export function renderRoutesBlock(routes: DevRoute[]): string {
  if (routes.length === 0) return `${BEGIN}\n${END}`;
  const blocks = routes
    .map((r) => {
      const safeName = r.pathPrefix.replace(/[^a-z0-9]+/gi, '_');
      return [
        `        location ${r.pathPrefix}/ {`,
        `          # ${safeName}`,
        `          rewrite ^${r.pathPrefix}/(.*)$ /$1 break;`,
        `          rewrite ^${r.pathPrefix}$ / break;`,
        `          proxy_pass http://${r.upstreamHost}:${r.upstreamPort};`,
        `          proxy_set_header Host $host;`,
        `          proxy_set_header X-Real-IP $remote_addr;`,
        `          proxy_set_header X-Forwarded-Proto $scheme;`,
        `          proxy_set_header X-Forwarded-Prefix ${r.pathPrefix};`,
        `          proxy_http_version 1.1;`,
        `          proxy_set_header Upgrade $http_upgrade;`,
        `          proxy_set_header Connection "upgrade";`,
        `        }`,
      ].join('\n');
    })
    .join('\n\n');
  return `${BEGIN}\n${blocks}\n        ${END}`;
}

export function injectRoutesBlock(currentNginxConf: string, block: string): string {
  if (currentNginxConf.includes(BEGIN) && currentNginxConf.includes(END)) {
    return currentNginxConf.replace(
      new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}`),
      block,
    );
  }
  // Inject before the final `}` that closes the server block.
  // Find the last `# Everything else` location and prepend the block before it.
  const serverEnd = currentNginxConf.lastIndexOf('location / {');
  if (serverEnd === -1) {
    // Fallback: append before the very last closing brace.
    return currentNginxConf.replace(/\n\}\s*\}\s*$/, `\n        ${block}\n      }\n    }`);
  }
  return (
    currentNginxConf.substring(0, serverEnd) +
    `${block}\n\n        ` +
    currentNginxConf.substring(serverEnd)
  );
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function syncRoutes(routes: DevRoute[]): Promise<void> {
  const core = api();
  const cm = await core.readNamespacedConfigMap({ name: CM_NAME, namespace: NS });
  const current = cm.data?.[NGINX_KEY] ?? '';
  const block = renderRoutesBlock(routes);
  const next = injectRoutesBlock(current, block);

  if (next === current) return;

  await core.replaceNamespacedConfigMap({
    name: CM_NAME,
    namespace: NS,
    body: {
      ...cm,
      data: { ...cm.data, [NGINX_KEY]: next },
    },
  });

  await reloadGateway();
}

export async function reloadGateway(): Promise<void> {
  // ConfigMap projected as subPath does NOT auto-update the file inside the pod.
  // We need to either restart the pod or — for nginx specifically — use the
  // ConfigMap projection refresh window. The simplest reliable approach is to
  // delete the pod (Recreate strategy means a new one will start with the
  // fresh CM mount).
  const core = api();
  const list = await core.listNamespacedPod({
    namespace: NS,
    labelSelector: 'app=liliput-gateway',
  });
  for (const pod of list.items) {
    if (!pod.metadata?.name) continue;
    try {
      // Try a lightweight reload via exec first — works only if the CM was
      // mounted via the projected-volume kubelet update, which typically
      // happens within ~60s. So the safer fallback is to delete the pod.
      await execInPod(NS, 'app=liliput-gateway', ['nginx', '-s', 'reload']);
      return;
    } catch {
      // Fall through to pod restart
    }
    await core.deleteNamespacedPod({ name: pod.metadata.name, namespace: NS });
  }
}
