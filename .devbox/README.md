# Liliput Devbox

A long-running AKS-hosted "devbox" pod for running **GitHub Copilot CLI** agents
unattended — so your agents keep working while your laptop sleeps or disconnects.

## What gets deployed

| Resource | Name |
|---|---|
| Resource group | `crgar-liliput-rg` |
| AKS cluster | `crgar-liliput-aks` |
| Container registry | `crgarliliputacr` |
| Log Analytics workspace | `crgar-liliput-law` |
| Region | `swedencentral` |

Inside the cluster:

- Namespace: `devbox`
- `StatefulSet/devbox` (1 replica), pod name `devbox-0`
- `PersistentVolumeClaim/devbox-home` — **32 Gi** Azure Disk mounted at `/home/node`
  - `git clone` your repos here → they persist across pod restarts
  - `gh auth` token persists under `~/.config/gh`
  - Copilot CLI state persists under `~/.copilot`

## Prerequisites

- Azure CLI (`az`) logged in — `az login`
- `kubectl`
- PowerShell (pwsh)

## Deploy

```pwsh
pwsh .devbox/deploy.ps1
```

The script will:
1. Deploy AKS + ACR + Log Analytics via Bicep (`infra/main.bicep`)
2. Build the devbox image inside ACR (no local Docker needed — uses `az acr build`)
3. Fetch AKS credentials
4. Apply the k8s manifest (namespace + PVC + StatefulSet)
5. Wait for the pod to be Ready

## First-time authentication (once per fresh PV)

```pwsh
pwsh .devbox/connect.ps1
```

Inside the pod:
```bash
# 1. Log into GitHub (device-flow — paste the code in your browser)
gh auth login --web -s 'read:user,repo,workflow'

# 2. Verify Copilot CLI
copilot --version

# 3. Clone the app repo you want agents to work on
cd ~
git clone https://github.com/<you>/<repo>.git
```

The gh token lives on the PV, so you only do this once.

## Running agents that survive disconnects

The connect script drops you straight into a `tmux` session called `agent`.
Anything running inside tmux keeps running when you disconnect.

```bash
# Inside the pod / tmux session
cd ~/<repo>
copilot                     # start the GitHub Copilot CLI

# Detach without killing: press   Ctrl+B   then   D
# Close your terminal — the agent keeps running.
```

Later (even days later):
```pwsh
pwsh .devbox/connect.ps1     # re-attaches to the same tmux session
```

## Useful commands

```pwsh
# Logs / status
kubectl -n devbox get pod,pvc,sts
kubectl -n devbox describe pod devbox-0

# Restart the pod (PV survives)
kubectl -n devbox rollout restart statefulset/devbox

# Tear everything down
az group delete -n crgar-liliput-rg --yes --no-wait

# Rebuild the image (after Dockerfile changes)
pwsh .devbox/deploy.ps1 -SkipInfra
kubectl -n devbox rollout restart statefulset/devbox
```

## Files

```
.devbox/
├── Dockerfile             # devbox image: node + gh + copilot + az + kubectl + tmux + git
├── deploy.ps1             # one-shot deploy
├── connect.ps1            # kubectl exec into tmux
├── infra/
│   ├── main.bicep         # subscription-scope: RG + AKS + ACR + LAW
│   ├── main.parameters.json
│   └── modules/
│       ├── aks.bicep      # AKS + AcrPull role assignment for kubelet identity
│       ├── acr.bicep
│       └── law.bicep
└── k8s/
    └── devbox.yaml        # Namespace + PVC (32Gi) + StatefulSet
```
