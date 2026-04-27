# 🏰 Liliput

**A meta-app for spinning up other apps.**

Liliput is a small army of Liliputian agents that take a target GitHub repo + a
plain-English task, hand the work to an LLM (via the Copilot SDK), preview the
result on this AKS cluster, and — on your approval — push it back to the source
repo as a pull request.

## What it does

Open the UI, paste a target repo and describe what you want:

> **Target repo:** `crgarcia12/widget-shop`  
> **Task:** "Add a `/health` endpoint that returns the build SHA."

Liliput will:

1. **Clone** `crgarcia12/widget-shop` into the API pod.
2. **Spec** what to do (Spec Liliputian — `claude-sonnet-4`). You approve.
3. **Edit** the code (Coder Liliputian — same model, JSON edit-plan format).
4. **Build** a container image with `az acr build` (no Docker daemon needed —
   ACR builds remotely, the pod just submits the source).
5. **Deploy** it into a fresh `dev-<owner>-<repo>-<branch>` namespace in this
   cluster, behind the existing nginx gateway at:

       http://4.165.50.135/dev/<owner>/<repo>/<branch>/

   (the gateway's ConfigMap is patched in-place; route is added/removed live).
6. **Wait** for you to click **Ship** or **Discard** on the task page:
   - **Ship** → opens a PR (or auto-merges in `direct` mode).
   - **Discard** → tears down the namespace, removes the gateway route, and
     deletes the remote branch.

While the build is running, every step is streamed to the chat and the 3D
island shows which Liliputians are working.

## How it runs

| Component | Where | What |
|---|---|---|
| `liliput-web` | k8s deployment in `liliput` ns | Next.js UI |
| `liliput-api` | k8s deployment in `liliput` ns | Express + Socket.IO + agent engine |
| `liliput-gateway` | k8s deployment, `nginx:1-alpine` | Reverse proxy + dev-env router |
| `liliput-agent` | k8s ServiceAccount | Federated to `liliput-agent-identity` UAMI; has `AcrPush` + cluster-wide RBAC for namespaces / deployments / services / configmaps |
| `crgarliliputacr` | Azure Container Registry | Both Liliput images and dev-env app images |
| `crgar-liliput-aks` | Azure Kubernetes Service | Hosts everything (1 node, `Standard_D2s_v5`) |

### Agent capabilities (in the API pod)

The API pod ships with `git`, `azure-cli` and a workload-identity-bound service
account, so an agent can:

- `git clone` / `branch` / `commit` / `push` (using the `COPILOT_GITHUB_TOKEN`
  injected from a GH-secrets-synced `Secret`)
- `az acr build` (UAMI auth, no Docker daemon)
- Apply k8s manifests (`@kubernetes/client-node` against the in-cluster API
  using the pod's SA token)
- Edit the gateway ConfigMap and reload nginx (via `pods/exec` or pod-recreate)
- Open / merge GitHub PRs via the REST API

### Path-prefix routing for dev envs

Each dev env is reachable at `/dev/<owner>/<repo>/<branch>/`. The gateway's
nginx config has a Liliput-managed marker block:

```
# === LILIPUT-DEV-ENVS-BEGIN ===
location /dev/<owner>/<repo>/<branch>/ {
  rewrite ^/dev/<owner>/<repo>/<branch>/(.*)$ /$1 break;
  proxy_pass http://app.dev-<owner>-<repo>-<branch>.svc.cluster.local;
  proxy_set_header X-Forwarded-Prefix /dev/<owner>/<repo>/<branch>;
  ...
}
# === LILIPUT-DEV-ENVS-END ===
```

The app receives `BASE_PATH` / `NEXT_PUBLIC_BASE_PATH` env vars so it can
render asset URLs correctly. The agent is hinted to honour them.

## Limitations / TODOs

- **In-memory dev-env map**: a pod restart drops the map; the next gateway sync
  will wipe all routes. Workaround: re-create the affected tasks. Fix: read the
  marker block on startup and rebuild the map.
- **GitHub auth**: the `gho_` token currently used can only write to repos owned
  by `crgarcia12`. For multi-user, swap in a classic PAT or per-user OAuth.
- **Concurrency cap**: cluster has 1 node / 2 vCPUs — practically ~3 dev envs
  in parallel. No hard cap is enforced yet.
- **Agent loop is single-shot**: prompt → JSON edit plan → apply. No
  multi-iteration tool-use / test-execute loop yet.

## Local dev

```powershell
cd src/api && npm install && npm run dev   # API on :5001
cd src/web && npm install && npm run dev   # Web on :3000
```

For the agent pipeline you need a real cluster — point your `KUBECONFIG` at
`crgar-liliput-aks` and set `ACR_NAME=crgarliliputacr`,
`COPILOT_GITHUB_TOKEN=...` in your shell.

## Deploy

```powershell
git push origin main   # GH Actions deploys to AKS
```

The `deploy-liliput.yml` workflow:
1. Builds + pushes both images to ACR.
2. Syncs `COPILOT_GITHUB_TOKEN` from GH Secrets into a k8s `Secret`.
3. `kubectl apply -f k8s/liliput.yaml`.
4. `kubectl rollout status` on both deployments.
