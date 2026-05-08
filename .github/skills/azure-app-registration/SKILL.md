---
name: azure-app-registration
description: Provision an Entra ID app registration + service principal for the current GitHub repo, assign AI Foundry / OpenAI / Storage / AI Search RBAC roles, and project the resulting Azure credentials into the dev-env's `liliput-azure-sp` Kubernetes Secret. Use this when a Liliput-managed app needs to access Azure AI Foundry, Azure OpenAI, or related data-plane services from inside its dev container.
---

# Azure App Registration (per repo)

## When to use

Invoke this skill when:

- The user asks for "Azure access", "AI Foundry credentials", "Azure OpenAI from this app", "service principal", or similar in the current workstream.
- A Liliput-managed app you are building needs to call Azure AI Foundry, Azure OpenAI, Storage, or AI Search at runtime from its container.
- You see code that reads `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` / `AZURE_TENANT_ID` and they are missing in the dev-env.

Do NOT invoke this skill when:

- The user only needs Liliput itself (the orchestrator) to talk to Azure — Liliput already runs as a managed identity.
- The current task does not need Azure data-plane access. Don't pre-provision credentials "just in case".

## What it does

For the repo currently being worked on (e.g. `acme/widgets`):

1. Finds (or creates) an Entra ID app registration named `liliput-{env}-{owner}-{repo}`, double-keyed by Liliput-owned tags so it cannot collide with manually-created apps.
2. Ensures the app has a service principal in your tenant.
3. Mints a fresh client secret if the current one expires within 7 days (default 30-day lifetime). Otherwise reuses the existing secret value (kept in `liliput/azure-sp-{owner}-{repo}` as the source of truth).
4. Assigns the SP a default role bundle on the resource scope given by `LILIPUT_AI_FOUNDRY_SCOPE`:
   - `Cognitive Services OpenAI User`
   - `Azure AI Developer` (AI Foundry user)
   - `Azure AI Inference Deployment Operator` (AI Foundry contributor)
   - `Storage Blob Data Contributor`
   - `Search Index Data Contributor`
5. Writes a Kubernetes Secret named `liliput-azure-sp` into the dev-env namespace with these keys: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, plus `AZURE_AI_FOUNDRY_ENDPOINT` / `AZURE_OPENAI_ENDPOINT` / `AZURE_AI_PROJECT_ENDPOINT` if configured for this Liliput instance.

The dev-pod consumes the secret via `envFrom: secretRef: name: liliput-azure-sp`. The Deployment manifest you generate must reference it.

## How to call

Loopback-only HTTP endpoint inside the orchestrator pod. From a `bash` step:

```bash
curl -sS -X POST \
  -H "Content-Type: application/json" \
  -H "X-Liliput-Internal: $LILIPUT_INTERNAL_TOKEN" \
  http://127.0.0.1:5002/api/azure/app-registration/ensure \
  -d '{
    "repo": "acme/widgets",
    "namespace": "dev-acme-widgets-main"
  }'
```

Response JSON: `appId`, `appObjectId`, `servicePrincipalId`, `tenantId`, `secretName`, `rotated`, `expiresAt`, `rolesAssigned`. The `clientSecret` value is *never* returned over HTTP — it lands in the Kubernetes Secret only.

## Wiring the secret into the deployment

```yaml
spec:
  template:
    spec:
      containers:
        - name: app
          envFrom:
            - secretRef:
                name: liliput-azure-sp
```

In the app code, `DefaultAzureCredential` picks up the three env vars automatically:

```ts
import { DefaultAzureCredential } from '@azure/identity';
const credential = new DefaultAzureCredential();
```

## Optional parameters

```jsonc
{
  "repo": "acme/widgets",
  "namespace": "dev-acme-widgets-main",
  "roleAliases": ["cognitive-services-openai-user", "ai-foundry-user"],
  "scope": "/subscriptions/<sub>/resourceGroups/<rg>",
  "extraSecretData": { "AZURE_AI_PROJECT_NAME": "my-project" },
  "forceRotate": false
}
```

## Failure modes

- **`LILIPUT_AI_FOUNDRY_SCOPE` unset** → tool refuses with clear error. Ask the user to set it (ARM resource ID).
- **Conflicting app exists without Liliput tags** → tool refuses to mutate. User must rename/delete the conflicting app or change `LILIPUT_ENV`.
- **Graph permission denied** → Liliput's MI is missing `Application.ReadWrite.OwnedBy`. See `docs/azure-permissions.md`.
- **ARM permission denied** → Liliput's MI lacks `User Access Administrator` at the configured scope. Same doc.
- **Endpoint returns 503** → `LILIPUT_INTERNAL_TOKEN` not set. Ask user to set it via the deploy workflow.

## Important constraints

- **One app reg per repo** (not per branch). Branches share the SP.
- **Secret value is only known at mint time.** If a valid secret exists in the central record, it is reused; the tool does NOT rotate just because a namespace is new.
- **Rotation does not auto-restart pods.** When `rotated: true`, suggest `kubectl rollout restart deploy/<name> -n <ns>` to consumers.
- **Never log the response body verbatim** — treat the endpoint as credential-issuing even though it does not return the secret today.
