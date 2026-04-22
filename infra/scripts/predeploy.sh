#!/bin/bash
set -e

# Write Vite backend URL for production builds so the SPA calls the real backend.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WEB_DIR="$ROOT_DIR/src/web"
ENV_FILE="$WEB_DIR/.env.production"

# Load azd environment values
eval "$(azd env get-values)"

# Try API_BASE_URL first (new infra), fall back to API_URL (legacy)
RESOLVED_API_URL="${API_BASE_URL:-$API_URL}"

if [ -z "$RESOLVED_API_URL" ]; then
  echo "Neither API_BASE_URL nor API_URL is set in the azd environment; cannot configure frontend API base" >&2
  exit 1
fi

echo "NEXT_PUBLIC_API_URL=$RESOLVED_API_URL" > "$ENV_FILE"
echo "Wrote API URL to $ENV_FILE"
