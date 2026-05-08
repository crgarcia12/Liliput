#!/usr/bin/env bash
# One-time grant of permissions Liliput needs to run the
# `azure-app-registration` tool.
#
# Required:
#   LILIPUT_MI_OBJECT_ID  - object ID of the Liliput managed identity
#   LILIPUT_AI_FOUNDRY_SCOPE - ARM resource scope (e.g.
#                             /subscriptions/<sub>/resourceGroups/<rg>)
#
# Idempotent: re-running is safe.
set -euo pipefail

: "${LILIPUT_MI_OBJECT_ID:?LILIPUT_MI_OBJECT_ID is required}"
: "${LILIPUT_AI_FOUNDRY_SCOPE:?LILIPUT_AI_FOUNDRY_SCOPE is required}"

echo "==> Granting Microsoft Graph: Application.ReadWrite.OwnedBy"
GRAPH_SP_OBJECT_ID=$(az ad sp list \
  --filter "appId eq '00000003-0000-0000-c000-000000000000'" \
  --query "[0].id" -o tsv)
APP_ROLE_ID="18a4783c-866b-4cc7-a460-3d5e5662c884"

set +e
az rest --method POST \
  --uri "https://graph.microsoft.com/v1.0/servicePrincipals/${LILIPUT_MI_OBJECT_ID}/appRoleAssignments" \
  --body "{
    \"principalId\": \"${LILIPUT_MI_OBJECT_ID}\",
    \"resourceId\": \"${GRAPH_SP_OBJECT_ID}\",
    \"appRoleId\": \"${APP_ROLE_ID}\"
  }" 2>/dev/null
set -e
echo "    (already-granted errors above are fine)"

echo "==> Granting ARM: User Access Administrator (constrained) at ${LILIPUT_AI_FOUNDRY_SCOPE}"
az role assignment create \
  --assignee-object-id "${LILIPUT_MI_OBJECT_ID}" \
  --assignee-principal-type ServicePrincipal \
  --role "User Access Administrator" \
  --scope "${LILIPUT_AI_FOUNDRY_SCOPE}" \
  --condition-version "2.0" \
  --condition "(!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'}) OR @Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals { 5e0bd9bd-7b93-4f28-af87-19fc36ad61bd, 64702f94-c441-49e6-a78b-ef80e0188fee, 53ca6127-db72-4b80-b1b0-d745d6d5456d, ba92f5b4-2d11-453d-a403-e96b0029c9fe, 8ebe5a00-799e-43f5-93ac-243d3dce84a7 })" \
  || echo "    (already-granted error above is fine)"

echo "==> Done. Wait ~1-2 minutes for Graph propagation before first use."
