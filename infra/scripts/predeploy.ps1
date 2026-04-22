#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

# Write backend URL for production builds so the frontend calls the real API.
$rootDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$webDir = Join-Path $rootDir "src/web"
$envFile = Join-Path $webDir ".env.production"

# Try API_BASE_URL first (new infra), fall back to API_URL (legacy)
$apiUrl = azd env get-value API_BASE_URL 2>$null
if (-not $apiUrl) {
    $apiUrl = azd env get-value API_URL 2>$null
}
if (-not $apiUrl) {
    Write-Error "Neither API_BASE_URL nor API_URL is set in the azd environment; cannot configure frontend API base"
}

"NEXT_PUBLIC_API_URL=$apiUrl" | Set-Content -Path $envFile -NoNewline
Write-Host "Wrote API URL to $envFile"
