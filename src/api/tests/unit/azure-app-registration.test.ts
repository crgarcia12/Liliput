import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the k8s-secret module before importing the engine — vitest hoists vi.mock.
const k8sSecretStore = new Map<string, Record<string, string>>();
vi.mock('../../src/engine/k8s-secret.js', () => ({
  ensureK8sSecret: vi.fn(async (opts: { namespace: string; name: string; data: Record<string, string> }) => {
    k8sSecretStore.set(`${opts.namespace}/${opts.name}`, { ...opts.data });
  }),
  readK8sSecret: vi.fn(async (ns: string, name: string) => {
    return k8sSecretStore.get(`${ns}/${name}`) ?? null;
  }),
  sanitiseSecretKey: (k: string) => k.replace(/[^A-Za-z0-9_.-]+/g, '_'),
}));

// Silence pino in tests
vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  ensureAppRegistration,
  type Dependencies,
  type GraphLikeClient,
  type AuthLikeClient,
} from '../../src/engine/azure-app-registration.js';

interface FakeApp {
  id: string;
  appId: string;
  displayName: string;
  tags?: string[];
  passwordCredentials?: Array<{ keyId: string; endDateTime: string; displayName?: string }>;
}

interface FakeSP {
  id: string;
  appId: string;
}

function makeFakeGraph(state: {
  apps: FakeApp[];
  sps: FakeSP[];
  mintCounter: { n: number };
  removedKeys: string[];
}): GraphLikeClient {
  // Helper to dispatch by URL pattern.
  return {
    api(path: string) {
      const ctx: { filter?: string; select?: string } = {};

      const exec = async (
        method: 'GET' | 'POST' | 'DELETE',
        body?: unknown,
      ): Promise<unknown> => {
        // /applications (collection)
        if (path === '/applications') {
          if (method === 'GET') {
            const m = ctx.filter ? /displayName eq '([^']+)'/.exec(ctx.filter) : null;
            const dn = m?.[1];
            const value = dn
              ? state.apps.filter((a) => a.displayName === dn)
              : state.apps;
            return { value };
          }
          if (method === 'POST') {
            const b = body as Partial<FakeApp>;
            const newApp: FakeApp = {
              id: `obj-${state.apps.length + 1}`,
              appId: `app-${state.apps.length + 1}`,
              displayName: b.displayName ?? '',
              tags: b.tags ?? [],
              passwordCredentials: [],
            };
            state.apps.push(newApp);
            return newApp;
          }
        }

        // /servicePrincipals
        if (path === '/servicePrincipals') {
          if (method === 'GET') {
            const m = ctx.filter ? /appId eq '([^']+)'/.exec(ctx.filter) : null;
            const ap = m?.[1];
            const value = ap ? state.sps.filter((s) => s.appId === ap) : state.sps;
            return { value };
          }
          if (method === 'POST') {
            const b = body as { appId: string };
            const sp: FakeSP = { id: `sp-${state.sps.length + 1}`, appId: b.appId };
            state.sps.push(sp);
            return sp;
          }
        }

        // /applications/{id}/addPassword
        const addPwMatch = /^\/applications\/([^/]+)\/addPassword$/.exec(path);
        if (addPwMatch && method === 'POST') {
          state.mintCounter.n += 1;
          const keyId = `key-${state.mintCounter.n}`;
          const endDateTime = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
          const app = state.apps.find((a) => a.id === addPwMatch[1]);
          if (app) {
            app.passwordCredentials = [
              ...(app.passwordCredentials ?? []),
              { keyId, endDateTime, displayName: 'liliput-rotated' },
            ];
          }
          return { keyId, secretText: `super-secret-${state.mintCounter.n}`, endDateTime };
        }

        // /applications/{id}/removePassword
        const rmPwMatch = /^\/applications\/([^/]+)\/removePassword$/.exec(path);
        if (rmPwMatch && method === 'POST') {
          const b = body as { keyId: string };
          state.removedKeys.push(b.keyId);
          const app = state.apps.find((a) => a.id === rmPwMatch[1]);
          if (app && app.passwordCredentials) {
            app.passwordCredentials = app.passwordCredentials.filter((p) => p.keyId !== b.keyId);
          }
          return undefined;
        }

        // /applications/{id} (single, with select)
        const oneMatch = /^\/applications\/([^/]+)$/.exec(path);
        if (oneMatch && method === 'GET') {
          const a = state.apps.find((x) => x.id === oneMatch[1]);
          return a ?? {};
        }

        throw new Error(`fake graph: unhandled ${method} ${path} (filter=${ctx.filter})`);
      };

      const make = (): {
        get<T>(): Promise<T>;
        post<T>(body: unknown): Promise<T>;
        delete(): Promise<void>;
        filter(q: string): { get<T>(): Promise<T> };
        select(fields: string): { get<T>(): Promise<T> };
      } => ({
        async get<T>(): Promise<T> {
          return (await exec('GET')) as T;
        },
        async post<T>(b: unknown): Promise<T> {
          return (await exec('POST', b)) as T;
        },
        async delete(): Promise<void> {
          await exec('DELETE');
        },
        filter(q: string) {
          ctx.filter = q;
          return make();
        },
        select(fields: string) {
          ctx.select = fields;
          return make();
        },
      });
      return make();
    },
  };
}

function makeFakeAuth(): {
  client: AuthLikeClient;
  calls: Array<{ scope: string; name: string; roleDefinitionId: string; principalId: string }>;
  failNext?: { code?: string; statusCode?: number };
} {
  const calls: Array<{ scope: string; name: string; roleDefinitionId: string; principalId: string }> = [];
  const state: { failNext?: { code?: string; statusCode?: number } } = {};
  return {
    calls,
    get failNext() {
      return state.failNext;
    },
    set failNext(v) {
      state.failNext = v;
    },
    client: {
      roleAssignments: {
        async create(scope, name, body) {
          if (state.failNext) {
            const e = Object.assign(new Error('synthetic'), state.failNext);
            state.failNext = undefined;
            throw e;
          }
          calls.push({
            scope,
            name,
            roleDefinitionId: body.properties.roleDefinitionId,
            principalId: body.properties.principalId,
          });
          return {};
        },
      },
    },
  };
}

function deps(graph: GraphLikeClient, auth: AuthLikeClient): Dependencies {
  return {
    graph,
    auth,
    tenantId: 'tenant-fake',
    subscriptionId: 'sub-fake',
  };
}

const SCOPE = '/subscriptions/sub-fake/resourceGroups/rg-foundry';

describe('ensureAppRegistration', () => {
  beforeEach(() => {
    k8sSecretStore.clear();
    delete process.env['LILIPUT_AI_FOUNDRY_SCOPE'];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('throws when no scope is provided and env is unset', async () => {
    const graph = makeFakeGraph({ apps: [], sps: [], mintCounter: { n: 0 }, removedKeys: [] });
    const auth = makeFakeAuth();
    await expect(
      ensureAppRegistration({ repo: 'acme/widgets', namespace: 'dev-x' }, deps(graph, auth.client)),
    ).rejects.toThrow(/LILIPUT_AI_FOUNDRY_SCOPE/);
  });

  it('creates app + SP, mints secret, assigns roles, projects K8s Secret on first run', async () => {
    const state = { apps: [] as FakeApp[], sps: [] as FakeSP[], mintCounter: { n: 0 }, removedKeys: [] };
    const graph = makeFakeGraph(state);
    const auth = makeFakeAuth();
    const result = await ensureAppRegistration(
      { repo: 'acme/widgets', namespace: 'dev-acme-widgets-main', scope: SCOPE },
      deps(graph, auth.client),
    );

    expect(state.apps).toHaveLength(1);
    expect(state.sps).toHaveLength(1);
    expect(result.rotated).toBe(true);
    expect(result.rolesAssigned).toEqual([
      'cognitive-services-openai-user',
      'ai-foundry-user',
      'ai-foundry-contributor',
      'storage-blob-data-contributor',
      'azure-ai-search-contributor',
    ]);
    expect(auth.calls).toHaveLength(5);
    // per-env Secret projected
    const proj = k8sSecretStore.get('dev-acme-widgets-main/liliput-azure-sp');
    expect(proj?.['AZURE_TENANT_ID']).toBe('tenant-fake');
    expect(proj?.['AZURE_CLIENT_ID']).toBe(state.apps[0]!.appId);
    expect(proj?.['AZURE_CLIENT_SECRET']).toMatch(/^super-secret-/);
    // central source-of-truth populated
    expect(k8sSecretStore.get('liliput/azure-sp-acme-widgets')).toBeDefined();
  });

  it('reuses existing app + secret on second run within freshness window', async () => {
    const state = { apps: [] as FakeApp[], sps: [] as FakeSP[], mintCounter: { n: 0 }, removedKeys: [] };
    const graph = makeFakeGraph(state);
    const auth = makeFakeAuth();
    const opts = { repo: 'acme/widgets', namespace: 'dev-1', scope: SCOPE };
    const first = await ensureAppRegistration(opts, deps(graph, auth.client));
    const second = await ensureAppRegistration(
      { ...opts, namespace: 'dev-2' },
      deps(graph, auth.client),
    );

    expect(state.apps).toHaveLength(1);
    expect(first.rotated).toBe(true);
    expect(second.rotated).toBe(false);
    // Same secret value — re-use confirms central K8s Secret is the source of truth.
    expect(k8sSecretStore.get('dev-1/liliput-azure-sp')?.['AZURE_CLIENT_SECRET']).toBe(
      k8sSecretStore.get('dev-2/liliput-azure-sp')?.['AZURE_CLIENT_SECRET'],
    );
    // Roles re-assigned but with deterministic IDs (same names → 10 calls total).
    const names = auth.calls.map((c) => c.name);
    expect(new Set(names).size).toBe(5);
  });

  it('refuses to mutate an app with matching displayName but missing Liliput tags', async () => {
    const state = {
      apps: [
        {
          id: 'obj-foreign',
          appId: 'app-foreign',
          displayName: 'liliput-default-acme-widgets',
          tags: ['some-other-team'],
        },
      ] as FakeApp[],
      sps: [] as FakeSP[],
      mintCounter: { n: 0 },
      removedKeys: [],
    };
    const graph = makeFakeGraph(state);
    const auth = makeFakeAuth();
    await expect(
      ensureAppRegistration(
        { repo: 'acme/widgets', namespace: 'dev-x', scope: SCOPE },
        deps(graph, auth.client),
      ),
    ).rejects.toThrow(/missing Liliput tags/);
    // No mutation occurred.
    expect(state.apps).toHaveLength(1);
    expect(state.sps).toHaveLength(0);
  });

  it('rotates when forceRotate=true even with a fresh central record', async () => {
    const state = { apps: [] as FakeApp[], sps: [] as FakeSP[], mintCounter: { n: 0 }, removedKeys: [] };
    const graph = makeFakeGraph(state);
    const auth = makeFakeAuth();
    const opts = { repo: 'acme/widgets', namespace: 'dev-1', scope: SCOPE };
    await ensureAppRegistration(opts, deps(graph, auth.client));
    const second = await ensureAppRegistration(
      { ...opts, forceRotate: true },
      deps(graph, auth.client),
    );
    expect(second.rotated).toBe(true);
    expect(state.mintCounter.n).toBe(2);
  });

  it('treats RoleAssignmentExists 409 as success', async () => {
    const state = { apps: [] as FakeApp[], sps: [] as FakeSP[], mintCounter: { n: 0 }, removedKeys: [] };
    const graph = makeFakeGraph(state);
    const auth = makeFakeAuth();
    auth.failNext = { code: 'RoleAssignmentExists', statusCode: 409 };
    const result = await ensureAppRegistration(
      {
        repo: 'acme/widgets',
        namespace: 'dev-x',
        scope: SCOPE,
        roleAliases: ['cognitive-services-openai-user'],
      },
      deps(graph, auth.client),
    );
    expect(result.rolesAssigned).toEqual(['cognitive-services-openai-user']);
  });

  it('uses deterministic role assignment IDs across runs', async () => {
    const state = { apps: [] as FakeApp[], sps: [] as FakeSP[], mintCounter: { n: 0 }, removedKeys: [] };
    const graph = makeFakeGraph(state);
    const auth = makeFakeAuth();
    const opts = {
      repo: 'acme/widgets',
      namespace: 'dev-x',
      scope: SCOPE,
      roleAliases: ['cognitive-services-openai-user'],
    };
    await ensureAppRegistration(opts, deps(graph, auth.client));
    await ensureAppRegistration(opts, deps(graph, auth.client));
    expect(auth.calls).toHaveLength(2);
    expect(auth.calls[0]!.name).toBe(auth.calls[1]!.name);
  });

  it('rejects unknown role aliases', async () => {
    const state = { apps: [] as FakeApp[], sps: [] as FakeSP[], mintCounter: { n: 0 }, removedKeys: [] };
    const graph = makeFakeGraph(state);
    const auth = makeFakeAuth();
    await expect(
      ensureAppRegistration(
        {
          repo: 'acme/widgets',
          namespace: 'dev-x',
          scope: SCOPE,
          roleAliases: ['totally-not-a-role'],
        },
        deps(graph, auth.client),
      ),
    ).rejects.toThrow(/Unknown role alias/);
  });
});
