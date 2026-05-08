/**
 * Per-repo Azure App Registration tool.
 *
 * Liliput's orchestrator can call `ensureAppRegistration({ repo, namespace })`
 * to provision (or refresh) an Entra ID app registration + service principal
 * for a target GitHub repository, assign it AI Foundry / Cognitive Services
 * RBAC roles, and project the resulting credentials into a Kubernetes Secret
 * inside the dev-env namespace. The dev container consumes the credentials
 * via env vars (AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET).
 *
 * Identity model
 * --------------
 *   * One app registration *per repo* (not per branch). Multiple branches/
 *     dev-envs of the same repo share the SP.
 *   * Apps are double-keyed: `displayName == liliput-{env}-{owner}-{repo}`
 *     AND tags contain `liliput-managed-{env}` AND `repo:{owner}/{repo}`.
 *     We refuse to mutate apps that match by name but lack the tags.
 *   * Source of truth for the live `clientSecret` value is a central
 *     Kubernetes Secret in the `liliput` namespace named
 *     `azure-sp-{owner}-{repo}`. Per-env Secrets are projections of it.
 *     Graph only returns the secret value at creation time, so we MUST
 *     persist it ourselves to be able to refresh per-env Secrets without
 *     rotating on every call.
 *   * Role assignments use deterministic UUIDv5 names derived from
 *     (scope + principalId + roleDefinitionId), so re-runs are no-ops
 *     and there is no GUID race.
 *
 * Permissions required for Liliput's identity
 * -------------------------------------------
 *   * Microsoft Graph: `Application.ReadWrite.OwnedBy` (admin-consented).
 *   * ARM: `User Access Administrator` or `Owner` at the
 *     `LILIPUT_AI_FOUNDRY_SCOPE` resource scope (RG or subscription).
 *   * Kubernetes: existing `liliput-agent` ClusterRole already grants
 *     read/write on Secrets across namespaces.
 *
 * See `docs/azure-permissions.md` for the one-time setup script.
 */

import { randomUUID } from 'node:crypto';
import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';
import { AuthorizationManagementClient } from '@azure/arm-authorization';
import { Client as GraphClient } from '@microsoft/microsoft-graph-client';
import 'isomorphic-fetch';
import { v5 as uuidv5 } from 'uuid';

import { logger } from '../logger.js';
import { ensureK8sSecret, readK8sSecret, sanitiseSecretKey } from './k8s-secret.js';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

/** Built-in role definition GUIDs (Azure data-plane roles). */
const ROLE_DEFINITIONS: Record<string, string> = {
  // https://learn.microsoft.com/azure/role-based-access-control/built-in-roles
  'cognitive-services-openai-user': '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd',
  'ai-foundry-user': '64702f94-c441-49e6-a78b-ef80e0188fee', // Azure AI Developer
  'ai-foundry-contributor': '53ca6127-db72-4b80-b1b0-d745d6d5456d', // Azure AI Inference Deployment Operator
  'storage-blob-data-contributor': 'ba92f5b4-2d11-453d-a403-e96b0029c9fe',
  'azure-ai-search-contributor': '8ebe5a00-799e-43f5-93ac-243d3dce84a7', // Search Index Data Contributor
};

/** Reverse: role-definition-id → human alias (for logging). */
const ROLE_ALIASES: Record<string, string> = Object.fromEntries(
  Object.entries(ROLE_DEFINITIONS).map(([alias, id]) => [id, alias]),
);

/** Default roles assigned when the caller doesn't override. */
export const DEFAULT_ROLE_ALIASES: readonly string[] = [
  'cognitive-services-openai-user',
  'ai-foundry-user',
  'ai-foundry-contributor',
  'storage-blob-data-contributor',
  'azure-ai-search-contributor',
];

/** UUIDv5 namespace — arbitrary stable GUID for Liliput role-assignment IDs. */
const ROLE_ASSIGNMENT_NS = '0c5ad2d6-5b4c-4f60-9f65-0e7a8a5bb3e1';

/** Default password lifetime — 30 days. */
const DEFAULT_SECRET_LIFETIME_DAYS = 30;

/** Refresh window — rotate when remaining lifetime is below this. */
const REFRESH_WINDOW_DAYS = 7;

/** Liliput's "namespace" for storing central per-repo Secrets. */
const CENTRAL_NAMESPACE = process.env['LILIPUT_NAMESPACE'] ?? 'liliput';

/** Optional environment qualifier (e.g. "test", "dev") to disambiguate
 *  multiple Liliput instances sharing one tenant. */
const LILIPUT_ENV = process.env['LILIPUT_ENV'] ?? 'default';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface EnsureAppRegistrationOptions {
  /** GitHub repo full name "owner/repo". */
  repo: string;
  /** Dev-env Kubernetes namespace receiving the projected secret. */
  namespace: string;
  /** Override default role list. Pass aliases from `DEFAULT_ROLE_ALIASES`. */
  roleAliases?: readonly string[];
  /** Override the resource scope. Defaults to `LILIPUT_AI_FOUNDRY_SCOPE` env. */
  scope?: string;
  /** Extra env vars to merge into the per-env Secret (e.g. endpoint URLs). */
  extraSecretData?: Record<string, string>;
  /** Force a password rotation even if the current secret is still fresh. */
  forceRotate?: boolean;
}

export interface EnsureAppRegistrationResult {
  appId: string;
  appObjectId: string;
  servicePrincipalId: string;
  tenantId: string;
  /** Kubernetes Secret name in the dev-env namespace (always
   *  `liliput-azure-sp`; here for the caller's convenience). */
  secretName: 'liliput-azure-sp';
  /** Whether a new password was minted on this call. */
  rotated: boolean;
  /** ISO8601 expiry of the active client secret. */
  expiresAt: string;
  /** Roles successfully present on the SP after the call. */
  rolesAssigned: string[];
}

/** Minimal Graph "application" shape we care about. */
interface GraphApplication {
  id: string;
  appId: string;
  displayName: string;
  tags?: string[];
  passwordCredentials?: Array<{
    keyId: string;
    endDateTime: string;
    displayName?: string;
  }>;
}

interface GraphServicePrincipal {
  id: string;
  appId: string;
}

/** Wire-level Graph client surface our code uses. Allows test injection. */
export interface GraphLikeClient {
  api(path: string): {
    get<T>(): Promise<T>;
    post<T>(body: unknown): Promise<T>;
    delete(): Promise<void>;
    filter(q: string): {
      get<T>(): Promise<T>;
    };
    select(fields: string): {
      get<T>(): Promise<T>;
    };
  };
}

/** Slimmest ARM-authorization surface our code uses. Allows test injection. */
export interface AuthLikeClient {
  roleAssignments: {
    create(
      scope: string,
      assignmentName: string,
      body: { properties: { roleDefinitionId: string; principalId: string; principalType?: string } },
    ): Promise<unknown>;
  };
}

export interface Dependencies {
  graph: GraphLikeClient;
  auth: AuthLikeClient;
  /** Tenant ID of the credential used. Resolved on first use. */
  tenantId: string;
  /** Subscription ID parsed from `scope` or env. */
  subscriptionId: string;
}

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

export async function ensureAppRegistration(
  opts: EnsureAppRegistrationOptions,
  deps?: Dependencies,
): Promise<EnsureAppRegistrationResult> {
  const repo = normaliseRepo(opts.repo);
  const namespace = opts.namespace.trim();
  if (!namespace) throw new Error('namespace is required');

  const scope = opts.scope ?? process.env['LILIPUT_AI_FOUNDRY_SCOPE'];
  if (!scope) {
    throw new Error(
      'LILIPUT_AI_FOUNDRY_SCOPE is not set. Provide an ARM resource ID (e.g. /subscriptions/.../resourceGroups/...) for role-assignment scope.',
    );
  }

  const aliases = opts.roleAliases ?? DEFAULT_ROLE_ALIASES;
  const roleDefinitionIds = aliases.map((a) => {
    const id = ROLE_DEFINITIONS[a];
    if (!id) throw new Error(`Unknown role alias: ${a}`);
    return { alias: a, id };
  });

  const d = deps ?? (await defaultDependencies(scope));

  // 1. Find or create the app registration (double-keyed by name + tags).
  const expectedName = appDisplayName(repo);
  const expectedTags = appTags(repo);
  const app = await findOrCreateApp(d.graph, expectedName, expectedTags, repo);

  // 2. Ensure the service principal for the app.
  const sp = await ensureServicePrincipal(d.graph, app.appId);

  // 3. Read or refresh the central secret store.
  const central = await readCentralSecret(repo);
  const needRotate =
    opts.forceRotate ||
    !central ||
    !central.expiresAt ||
    isExpiringSoon(central.expiresAt) ||
    central.appId !== app.appId;

  let clientSecret: string;
  let expiresAt: string;
  let rotated = false;
  if (needRotate) {
    const minted = await mintClientSecret(d.graph, app.id);
    clientSecret = minted.secretText;
    expiresAt = minted.expiresAt;
    rotated = true;
    await writeCentralSecret(repo, {
      tenantId: d.tenantId,
      appId: app.appId,
      clientSecret,
      expiresAt,
    });
    await pruneStalePasswords(d.graph, app.id, minted.keyId);
    logger.info(
      { repo, appId: app.appId, expiresAt },
      'Rotated client secret for repo SP',
    );
  } else {
    clientSecret = central!.clientSecret;
    expiresAt = central!.expiresAt;
  }

  // 4. Assign roles (deterministic GUIDs → idempotent).
  const rolesAssigned: string[] = [];
  for (const r of roleDefinitionIds) {
    const ok = await assignRole(d.auth, scope, sp.id, r.id, d.subscriptionId);
    if (ok) rolesAssigned.push(r.alias);
  }

  // 5. Project to the dev-env namespace's `liliput-azure-sp` Secret.
  const projectedData: Record<string, string> = {
    AZURE_TENANT_ID: d.tenantId,
    AZURE_CLIENT_ID: app.appId,
    AZURE_CLIENT_SECRET: clientSecret,
  };
  // Useful endpoints — only include if present in env to avoid stale data.
  for (const k of [
    'AZURE_AI_FOUNDRY_ENDPOINT',
    'AZURE_OPENAI_ENDPOINT',
    'AZURE_AI_PROJECT_ENDPOINT',
  ]) {
    if (process.env[k]) projectedData[k] = process.env[k]!;
  }
  for (const [k, v] of Object.entries(opts.extraSecretData ?? {})) {
    projectedData[sanitiseSecretKey(k)] = v;
  }

  await ensureK8sSecret({
    namespace,
    name: 'liliput-azure-sp',
    fieldManager: 'liliput-azure-app-reg',
    data: projectedData,
    labels: {
      'liliput.dev/managed': 'true',
      'liliput.dev/repo': repoLabel(repo),
    },
  });

  logger.info(
    {
      repo,
      namespace,
      appId: app.appId,
      rotated,
      rolesAssigned,
      expiresAt,
    },
    'Ensured Azure app registration for repo',
  );

  return {
    appId: app.appId,
    appObjectId: app.id,
    servicePrincipalId: sp.id,
    tenantId: d.tenantId,
    secretName: 'liliput-azure-sp',
    rotated,
    expiresAt,
    rolesAssigned,
  };
}

// -----------------------------------------------------------------------------
// Graph helpers
// -----------------------------------------------------------------------------

async function findOrCreateApp(
  graph: GraphLikeClient,
  expectedName: string,
  expectedTags: string[],
  repo: string,
): Promise<GraphApplication> {
  // Filter by displayName first — Graph supports filter on this property.
  const filter = `displayName eq '${expectedName.replace(/'/g, "''")}'`;
  const resp = await graph.api('/applications').filter(filter).get<{ value: GraphApplication[] }>();
  const matches = resp.value ?? [];

  for (const app of matches) {
    const tags = app.tags ?? [];
    const ours = expectedTags.every((t) => tags.includes(t));
    if (ours) return app;
    // Same name, but missing our tags — refuse to touch it.
    throw new Error(
      `Found an app with displayName "${expectedName}" but missing Liliput tags ` +
        `(${expectedTags.join(', ')}). Refusing to mutate. Either delete the conflicting app ` +
        `or rename Liliput's expected name (LILIPUT_ENV).`,
    );
  }

  const created = await graph.api('/applications').post<GraphApplication>({
    displayName: expectedName,
    tags: expectedTags,
    description: `Managed by Liliput — repo ${repo}. Do not edit manually.`,
    signInAudience: 'AzureADMyOrg',
  });
  return created;
}

async function ensureServicePrincipal(
  graph: GraphLikeClient,
  appId: string,
): Promise<GraphServicePrincipal> {
  const filter = `appId eq '${appId}'`;
  const resp = await graph
    .api('/servicePrincipals')
    .filter(filter)
    .get<{ value: GraphServicePrincipal[] }>();
  const existing = (resp.value ?? [])[0];
  if (existing) return existing;
  return graph.api('/servicePrincipals').post<GraphServicePrincipal>({ appId });
}

interface MintedSecret {
  keyId: string;
  secretText: string;
  expiresAt: string;
}

async function mintClientSecret(
  graph: GraphLikeClient,
  appObjectId: string,
): Promise<MintedSecret> {
  const startDateTime = new Date().toISOString();
  const endDateTime = new Date(
    Date.now() + DEFAULT_SECRET_LIFETIME_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  type AddPasswordResp = { keyId: string; secretText: string; endDateTime: string };
  const resp = await graph.api(`/applications/${appObjectId}/addPassword`).post<AddPasswordResp>({
    passwordCredential: {
      displayName: 'liliput-rotated',
      startDateTime,
      endDateTime,
    },
  });
  return { keyId: resp.keyId, secretText: resp.secretText, expiresAt: resp.endDateTime };
}

/** Remove any password on the app reg that isn't the freshly-minted one,
 *  except those still within a 1-day grace window (to avoid blowing away a
 *  credential another instance just minted). */
async function pruneStalePasswords(
  graph: GraphLikeClient,
  appObjectId: string,
  keepKeyId: string,
): Promise<void> {
  type AppView = Pick<GraphApplication, 'passwordCredentials'>;
  const app = await graph
    .api(`/applications/${appObjectId}`)
    .select('passwordCredentials')
    .get<AppView>();
  const cutoffMs = Date.now() + 24 * 60 * 60 * 1000;
  for (const pw of app.passwordCredentials ?? []) {
    if (pw.keyId === keepKeyId) continue;
    const endMs = Date.parse(pw.endDateTime);
    if (Number.isFinite(endMs) && endMs > cutoffMs) continue; // still fresh
    try {
      await graph
        .api(`/applications/${appObjectId}/removePassword`)
        .post({ keyId: pw.keyId });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), keyId: pw.keyId },
        'Failed to prune stale password (non-fatal)',
      );
    }
  }
}

// -----------------------------------------------------------------------------
// ARM role assignment helpers
// -----------------------------------------------------------------------------

async function assignRole(
  client: AuthLikeClient,
  scope: string,
  principalId: string,
  roleDefinitionId: string,
  subscriptionId: string,
): Promise<boolean> {
  // Deterministic assignment GUID — re-runs become no-ops.
  const assignmentName = uuidv5(
    `${scope}|${principalId}|${roleDefinitionId}`,
    ROLE_ASSIGNMENT_NS,
  );
  const fullRoleDefId =
    `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${roleDefinitionId}`;
  try {
    await client.roleAssignments.create(scope, assignmentName, {
      properties: {
        roleDefinitionId: fullRoleDefId,
        principalId,
        principalType: 'ServicePrincipal',
      },
    });
    return true;
  } catch (err) {
    const code = (err as { code?: string; statusCode?: number }).code;
    const status = (err as { code?: string; statusCode?: number }).statusCode;
    if (code === 'RoleAssignmentExists' || status === 409) return true;
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        scope,
        principalId,
        roleAlias: ROLE_ALIASES[roleDefinitionId] ?? roleDefinitionId,
      },
      'Failed to assign role (non-fatal — continuing)',
    );
    return false;
  }
}

// -----------------------------------------------------------------------------
// Central secret persistence (k8s-backed)
// -----------------------------------------------------------------------------

interface CentralRecord {
  tenantId: string;
  appId: string;
  clientSecret: string;
  expiresAt: string;
}

function centralSecretName(repo: string): string {
  const [owner, name] = repo.split('/');
  return `azure-sp-${sanitise(owner!)}-${sanitise(name!)}`;
}

async function readCentralSecret(repo: string): Promise<CentralRecord | null> {
  const data = await readK8sSecret(CENTRAL_NAMESPACE, centralSecretName(repo));
  if (!data) return null;
  if (
    !data['AZURE_TENANT_ID'] ||
    !data['AZURE_CLIENT_ID'] ||
    !data['AZURE_CLIENT_SECRET'] ||
    !data['expiresAt']
  ) {
    return null;
  }
  return {
    tenantId: data['AZURE_TENANT_ID'],
    appId: data['AZURE_CLIENT_ID'],
    clientSecret: data['AZURE_CLIENT_SECRET'],
    expiresAt: data['expiresAt'],
  };
}

async function writeCentralSecret(repo: string, rec: CentralRecord): Promise<void> {
  await ensureK8sSecret({
    namespace: CENTRAL_NAMESPACE,
    name: centralSecretName(repo),
    fieldManager: 'liliput-azure-app-reg',
    data: {
      AZURE_TENANT_ID: rec.tenantId,
      AZURE_CLIENT_ID: rec.appId,
      AZURE_CLIENT_SECRET: rec.clientSecret,
      expiresAt: rec.expiresAt,
    },
    labels: {
      'liliput.dev/managed': 'true',
      'liliput.dev/repo': repoLabel(repo),
      'liliput.dev/role': 'central-azure-sp',
    },
  });
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function isExpiringSoon(iso: string): boolean {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return true;
  return ms - Date.now() < REFRESH_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

function normaliseRepo(repo: string): string {
  const r = repo.trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(r)) {
    throw new Error(`Invalid repo "${repo}" — expected "owner/name"`);
  }
  return r.toLowerCase();
}

function sanitise(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
}

function appDisplayName(repo: string): string {
  const [owner, name] = repo.split('/');
  return `liliput-${sanitise(LILIPUT_ENV)}-${sanitise(owner!)}-${sanitise(name!)}`;
}

function appTags(repo: string): string[] {
  return [`liliput-managed-${sanitise(LILIPUT_ENV)}`, `repo:${repo}`];
}

function repoLabel(repo: string): string {
  // "owner/name" → "owner__name", DNS-label-safe.
  return repo.replace('/', '__');
}

async function defaultDependencies(scope: string): Promise<Dependencies> {
  const credential: TokenCredential = new DefaultAzureCredential();
  const subscriptionId = subscriptionFromScope(scope);
  const auth = new AuthorizationManagementClient(credential, subscriptionId);

  const graph = GraphClient.initWithMiddleware({
    authProvider: {
      getAccessToken: async (): Promise<string> => {
        const tok = await credential.getToken('https://graph.microsoft.com/.default');
        if (!tok) throw new Error('No Graph token available from DefaultAzureCredential');
        return tok.token;
      },
    },
  });

  const tenantId = await resolveTenantId(credential);
  return { graph: wrapGraph(graph), auth: wrapAuth(auth), tenantId, subscriptionId };
}

function subscriptionFromScope(scope: string): string {
  const m = /^\/subscriptions\/([^/]+)/.exec(scope);
  if (!m) throw new Error(`Cannot extract subscriptionId from scope: ${scope}`);
  return m[1]!;
}

async function resolveTenantId(credential: TokenCredential): Promise<string> {
  // Use the ARM token to learn the tenant from JWT claims.
  const tok = await credential.getToken('https://management.azure.com/.default');
  if (!tok) throw new Error('No ARM token available from DefaultAzureCredential');
  const claims = decodeJwtClaims(tok.token);
  const tid = claims['tid'];
  if (typeof tid !== 'string' || !tid) {
    throw new Error('Could not resolve tenant ID from Azure credential token');
  }
  return tid;
}

function decodeJwtClaims(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.');
  if (parts.length < 2) return {};
  const payload = parts[1]!;
  const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
  const json = Buffer.from(padded, 'base64').toString('utf8');
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Normalise the real Graph SDK to our minimal interface. */
function wrapGraph(g: GraphClient): GraphLikeClient {
  return {
    api(path: string) {
      const r = g.api(path);
      const wrap = (req: typeof r): ReturnType<GraphLikeClient['api']> => ({
        async get<T>(): Promise<T> {
          return (await req.get()) as T;
        },
        async post<T>(body: unknown): Promise<T> {
          return (await req.post(body)) as T;
        },
        async delete(): Promise<void> {
          await req.delete();
        },
        filter(q: string) {
          return wrap(req.filter(q)) as { get<T>(): Promise<T> };
        },
        select(fields: string) {
          return wrap(req.select(fields)) as { get<T>(): Promise<T> };
        },
      });
      return wrap(r);
    },
  };
}

/** Normalise the real ARM client to our minimal interface. */
function wrapAuth(c: AuthorizationManagementClient): AuthLikeClient {
  return {
    roleAssignments: {
      async create(
        scope: string,
        name: string,
        body: { properties: { roleDefinitionId: string; principalId: string; principalType?: string } },
      ): Promise<unknown> {
        return c.roleAssignments.create(scope, name, body.properties);
      },
    },
  };
}

// Use randomUUID at least somewhere to keep tsc happy if a future code path
// needs ad-hoc IDs (currently unused — exported for tests).
export const __test_only_randomUUID = randomUUID;
