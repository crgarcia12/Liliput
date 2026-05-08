# Azure permissions required by Liliput

Liliput's pod needs permissions on **two** Azure planes to run the
`azure-app-registration` tool. Both are one-time grants by an Entra ID admin
+ Azure subscription owner. Without them, the tool will fail closed with a
clear error message.

## 1. Microsoft Graph — `Application.ReadWrite.OwnedBy`

Liliput needs to create app registrations and reset their secrets, but
*only those it owns*. The narrowest Graph permission that allows this is
`Application.ReadWrite.OwnedBy` (application permission, admin-consent
required).

Grant via Azure CLI:

```bash
# Object IDs
LILIPUT_MI_OBJECT_ID="<object id of the Liliput managed identity>"
GRAPH_SP_OBJECT_ID=$(az ad sp list --filter "appId eq '00000003-0000-0000-c000-000000000000'" --query "[0].id" -o tsv)

# Application.ReadWrite.OwnedBy app-role id (constant)
APP_ROLE_ID="18a4783c-866b-4cc7-a460-3d5e5662c884"

az rest --method POST \
  --uri "https://graph.microsoft.com/v1.0/servicePrincipals/${LILIPUT_MI_OBJECT_ID}/appRoleAssignments" \
  --body "{
    \"principalId\": \"${LILIPUT_MI_OBJECT_ID}\",
    \"resourceId\": \"${GRAPH_SP_OBJECT_ID}\",
    \"appRoleId\": \"${APP_ROLE_ID}\"
  }"
```

Verify:

```bash
az rest --method GET \
  --uri "https://graph.microsoft.com/v1.0/servicePrincipals/${LILIPUT_MI_OBJECT_ID}/appRoleAssignments"
```

## 2. ARM — `User Access Administrator` at the AI Foundry scope

Liliput needs to assign roles to the per-repo SPs at the configured AI Foundry
scope. The narrowest built-in role for this is **User Access Administrator**.
If your environment policy forbids that role, **Owner** also works.

Constrain the assignment to a single resource group (recommended) or to the
specific AI Foundry resource:

```bash
LILIPUT_MI_OBJECT_ID="<object id of the Liliput managed identity>"
SCOPE="/subscriptions/<sub>/resourceGroups/<rg>"   # set this to LILIPUT_AI_FOUNDRY_SCOPE

az role assignment create \
  --assignee-object-id "${LILIPUT_MI_OBJECT_ID}" \
  --assignee-principal-type ServicePrincipal \
  --role "User Access Administrator" \
  --scope "${SCOPE}" \
  --condition-version "2.0" \
  --condition "(
    !(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})
    OR
    @Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {
      5e0bd9bd-7b93-4f28-af87-19fc36ad61bd,
      64702f94-c441-49e6-a78b-ef80e0188fee,
      53ca6127-db72-4b80-b1b0-d745d6d5456d,
      ba92f5b4-2d11-453d-a403-e96b0029c9fe,
      8ebe5a00-799e-43f5-93ac-243d3dce84a7
    }
  )"
```

The ABAC condition restricts Liliput to assigning **only** the five roles
defined in `DEFAULT_ROLE_ALIASES` — even though it has UAA, it cannot escalate.

## 3. Required env vars on the Liliput pod

| Var | Required | Purpose |
| --- | --- | --- |
| `LILIPUT_AI_FOUNDRY_SCOPE` | yes | ARM resource ID where role assignments are created |
| `LILIPUT_INTERNAL_TOKEN` | yes | Bearer token for the loopback `/api/azure/...` endpoint |
| `LILIPUT_INTERNAL_PORT` | no (default `5002`) | Port the loopback listener binds to |
| `LILIPUT_ENV` | no (default `prod`) | Used in the app-reg displayName + tag set |
| `LILIPUT_DEV_PREFIX` | no (default `dev`) | Prefix for dev-env namespaces |
| `AZURE_AI_FOUNDRY_ENDPOINT` | optional | Projected into per-repo Secrets if set |
| `AZURE_OPENAI_ENDPOINT` | optional | Projected into per-repo Secrets if set |
| `AZURE_AI_PROJECT_ENDPOINT` | optional | Projected into per-repo Secrets if set |

A helper script lives at `scripts/grant-liliput-azure-permissions.sh`.
