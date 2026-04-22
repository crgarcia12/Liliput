$ErrorActionPreference = "Stop"

Write-Host "Post-provision configuration..." -ForegroundColor Green

$ROOT_DIR = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$SETTINGS_FILE = Join-Path $ROOT_DIR "apphost.settings.json"
$TEMPLATE_FILE = Join-Path $ROOT_DIR "apphost.settings.template.json"

# Check if settings file exists, if not, copy from template
if (-not (Test-Path $SETTINGS_FILE)) {
    Write-Host "apphost.settings.json not found. Copying from template..." -ForegroundColor Yellow
    if (Test-Path $TEMPLATE_FILE) {
        Copy-Item $TEMPLATE_FILE $SETTINGS_FILE
        Write-Host "Template copied successfully." -ForegroundColor Green
    } else {
        Write-Host "Warning: Template file not found at $TEMPLATE_FILE - skipping." -ForegroundColor Yellow
    }
}

# Read environment variables from azd
$azdEnvOutput = azd env get-values
$envVars = @{}
foreach ($line in $azdEnvOutput) {
    if ($line -match '^([^=]+)=(.*)$') {
        $envVars[$matches[1]] = $matches[2] -replace '^"?(.*?)"?$', '$1'
    }
}

Write-Host "Provisioning complete!" -ForegroundColor Green
Write-Host "  - Resource Group: $($envVars['AZURE_RESOURCE_GROUP'])" -ForegroundColor Cyan
Write-Host "  - AI Project: $($envVars['AZURE_AI_PROJECT_NAME'])" -ForegroundColor Cyan
Write-Host "  - Container Registry: $($envVars['AZURE_CONTAINER_REGISTRY_ENDPOINT'])" -ForegroundColor Cyan
