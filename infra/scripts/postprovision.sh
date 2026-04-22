#!/bin/bash
set -e

echo -e "\033[0;32mPost-provision configuration...\033[0m"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SETTINGS_FILE="$ROOT_DIR/apphost.settings.json"
TEMPLATE_FILE="$ROOT_DIR/apphost.settings.template.json"

# Check if settings file exists, if not, copy from template
if [ ! -f "$SETTINGS_FILE" ]; then
    echo -e "\033[0;33mapphost.settings.json not found. Copying from template...\033[0m"
    if [ -f "$TEMPLATE_FILE" ]; then
        cp "$TEMPLATE_FILE" "$SETTINGS_FILE"
        echo -e "\033[0;32mTemplate copied successfully.\033[0m"
    else
        echo -e "\033[0;33mWarning: Template file not found at $TEMPLATE_FILE — skipping.\033[0m"
    fi
fi

# Read environment variables from azd
eval "$(azd env get-values)"

echo -e "\033[0;32mProvisioning complete!\033[0m"
echo -e "\033[0;36m  - Resource Group: ${AZURE_RESOURCE_GROUP:-not set}\033[0m"
echo -e "\033[0;36m  - AI Project: ${AZURE_AI_PROJECT_NAME:-not set}\033[0m"
echo -e "\033[0;36m  - Container Registry: ${AZURE_CONTAINER_REGISTRY_ENDPOINT:-not set}\033[0m"
