# Exec into the Liliput devbox pod. Starts/attaches a tmux session so your
# agents survive kubectl exec disconnects and laptop sleep.

[CmdletBinding()]
param(
    [string]$NamePrefix = 'crgar-liliput',
    [string]$Session    = 'agent'
)

$ErrorActionPreference = 'Stop'
$rgName  = "$NamePrefix-rg"
$aksName = "$NamePrefix-aks"

# Make sure kubeconfig points at the right cluster
az aks get-credentials -g $rgName -n $aksName --overwrite-existing --only-show-errors | Out-Null

# tmux new -A attaches if the session exists, otherwise creates it.
kubectl -n devbox exec -it devbox-0 -- bash -lc "tmux new -A -s $Session"
