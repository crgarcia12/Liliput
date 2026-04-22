# Deploy Liliput devbox: AKS + ACR + containerized Copilot CLI with persistent volume.
#
# Usage:
#   pwsh .devbox/deploy.ps1                       # full deploy to swedencentral
#   pwsh .devbox/deploy.ps1 -Location westeurope  # override region
#
# Requires: az CLI (logged in), kubectl, pwsh.

[CmdletBinding()]
param(
    [string]$NamePrefix   = 'crgar-liliput',
    [string]$Location     = 'swedencentral',
    [string]$ImageTag     = 'latest',
    [switch]$SkipInfra,
    [switch]$SkipImage
)

$ErrorActionPreference = 'Stop'
$repoRoot  = Split-Path -Parent $PSScriptRoot
$devboxDir = $PSScriptRoot

$rgName    = "$NamePrefix-rg"
$aksName   = "$NamePrefix-aks"
$acrName   = ($NamePrefix -replace '-', '') + 'acr'

Write-Host ""
Write-Host "=== Liliput Devbox Deploy ==="    -ForegroundColor Cyan
Write-Host "RG:       $rgName"
Write-Host "AKS:      $aksName"
Write-Host "ACR:      $acrName"
Write-Host "Location: $Location"
Write-Host ""

# ---- 1. Provision infra ---------------------------------------------------
if (-not $SkipInfra) {
    Write-Host ">> Provisioning infrastructure (AKS + ACR + Log Analytics)..." -ForegroundColor Cyan
    az deployment sub create `
        --name "liliput-devbox-$(Get-Date -Format 'yyyyMMddHHmmss')" `
        --location $Location `
        --template-file  "$devboxDir\infra\main.bicep" `
        --parameters     "$devboxDir\infra\main.parameters.json" `
        --parameters     namePrefix=$NamePrefix location=$Location `
        --output none
    if ($LASTEXITCODE -ne 0) { throw "Bicep deployment failed" }
}

# ---- 2. Build + push image via ACR Tasks (no local Docker needed) ---------
$acrLoginServer = az acr show -n $acrName -g $rgName --query loginServer -o tsv
if (-not $acrLoginServer) { throw "ACR $acrName not found" }
Write-Host ">> ACR login server: $acrLoginServer"

if (-not $SkipImage) {
    Write-Host ">> Building devbox image in ACR..." -ForegroundColor Cyan
    az acr build `
        --registry $acrName `
        --image "devbox:$ImageTag" `
        --file "$devboxDir\Dockerfile" `
        $devboxDir
    if ($LASTEXITCODE -ne 0) { throw "ACR build failed" }
}

# ---- 3. Get AKS credentials ------------------------------------------------
Write-Host ">> Fetching AKS credentials..." -ForegroundColor Cyan
az aks get-credentials --resource-group $rgName --name $aksName --overwrite-existing --only-show-errors
if ($LASTEXITCODE -ne 0) { throw "get-credentials failed" }

# ---- 4. Apply k8s manifest -------------------------------------------------
Write-Host ">> Applying k8s manifest..." -ForegroundColor Cyan
$manifestTemplate = Get-Content "$devboxDir\k8s\devbox.yaml" -Raw
$manifest         = $manifestTemplate.Replace('__ACR_LOGIN_SERVER__', $acrLoginServer)
$tmpManifest      = Join-Path $env:TEMP "devbox-$([guid]::NewGuid().ToString('N')).yaml"
$manifest | Set-Content $tmpManifest -Encoding utf8
try {
    kubectl apply -f $tmpManifest
    if ($LASTEXITCODE -ne 0) { throw "kubectl apply failed" }
} finally {
    Remove-Item $tmpManifest -ErrorAction SilentlyContinue
}

# ---- 5. Wait for the pod to be Ready ---------------------------------------
Write-Host ">> Waiting for devbox pod to become Ready..." -ForegroundColor Cyan
kubectl -n devbox rollout status statefulset/devbox --timeout=10m
if ($LASTEXITCODE -ne 0) { throw "pod never became ready" }

Write-Host ""
Write-Host "=== Devbox is up. ===" -ForegroundColor Green
Write-Host ""
Write-Host "Connect:"
Write-Host "  pwsh .devbox\connect.ps1"
Write-Host ""
Write-Host "Or manually:"
Write-Host "  kubectl -n devbox exec -it devbox-0 -- bash"
Write-Host ""
Write-Host "First-time auth (inside the pod):"
Write-Host "  gh auth login --web -s 'read:user,repo,workflow'"
Write-Host "  # then use: copilot    (the GitHub Copilot CLI)"
Write-Host ""
Write-Host "Run agents that survive disconnects:"
Write-Host "  tmux new -s agent      # start"
Write-Host "  Ctrl+B then D          # detach (agent keeps running)"
Write-Host "  tmux attach -t agent   # re-attach later"
Write-Host ""
