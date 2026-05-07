import { CopilotClient } from '@github/copilot-sdk';
import { logger } from '../logger.js';
import { MODEL_OPTIONS as FALLBACK_MODELS, type ModelOption } from '../../../shared/types/index.js';

let clientPromise: Promise<CopilotClient> | undefined;
let modelsCache: { fetchedAt: number; models: ModelOption[] } | undefined;
const MODELS_CACHE_TTL_MS = 5 * 60_000;

/**
 * Returns true for SDK errors that indicate the underlying CLI subprocess
 * died (stdin/stdout IPC channel closed). Once this happens the singleton
 * is unusable and must be discarded so the next call can spawn a fresh one.
 */
export function isSdkConnectionClosed(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /connection is closed|stream is closed|EPIPE|pipe closed|unexpected end of stream/i.test(msg);
}

/**
 * Tagged error thrown by the agent-loop idle watchdog when the SDK has not
 * fired any event for IDLE_THRESHOLD_MS — meaning the agent's turn is
 * silently wedged (no tool calls, no reasoning, no messages). Treated as
 * recoverable: the iteration layer should resurrect and retry.
 */
export class IdleTimeoutError extends Error {
  readonly idleMs: number;
  constructor(idleMs: number) {
    super(`Agent idle: no SDK event for ${Math.round(idleMs / 1000)}s`);
    this.name = 'IdleTimeoutError';
    this.idleMs = idleMs;
  }
}

/**
 * True when the error indicates a recoverable SDK fault — either the CLI
 * subprocess died (`isSdkConnectionClosed`) or the watchdog tripped because
 * the agent went silent (`IdleTimeoutError`). The iteration layer retries
 * on these; non-recoverable errors propagate to the user.
 */
export function isRecoverableSdkError(err: unknown): boolean {
  if (isSdkConnectionClosed(err)) return true;
  if (err instanceof IdleTimeoutError) return true;
  if (err instanceof Error && err.name === 'IdleTimeoutError') return true;
  return false;
}

/**
 * Discard the current singleton. The next `getCopilotClient()` call will
 * spawn a fresh CLI subprocess. Safe to call concurrently — best-effort
 * stop of the dead client; ignores errors. Call this when a session call
 * throws an SDK-level connection error (see `isSdkConnectionClosed`).
 */
export async function resetCopilotClient(): Promise<void> {
  if (!clientPromise) return;
  const dying = clientPromise;
  clientPromise = undefined;
  modelsCache = undefined;
  try {
    const client = await dying;
    await client.stop();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, 'resetCopilotClient: error stopping dead client (ignored)');
  }
  logger.warn('Copilot SDK client reset — next call will spawn a fresh subprocess');
}

/**
 * Lazily create and start a single shared CopilotClient.
 * The bundled Copilot CLI is spawned the first time this is called and
 * reused for every subsequent session.
 */
export function getCopilotClient(): Promise<CopilotClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const client = new CopilotClient({
        logLevel: (process.env['COPILOT_LOG_LEVEL'] as 'error' | 'info' | 'debug' | 'none' | 'warning' | 'all' | undefined) ?? 'debug',
      });
      await client.start();
      logger.info('Copilot SDK client started');
      return client;
    })().catch((err: unknown) => {
      clientPromise = undefined;
      throw err;
    });
  }
  return clientPromise;
}

export async function stopCopilotClient(): Promise<void> {
  if (!clientPromise) return;
  try {
    const client = await clientPromise;
    await client.stop();
    logger.info('Copilot SDK client stopped');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, 'Error stopping Copilot SDK client');
  } finally {
    clientPromise = undefined;
  }
}

/**
 * Return the real list of models the auth'd Copilot account exposes via
 * `client.listModels()`. Cached for 5 minutes. Falls back to a curated
 * static list when the SDK call fails (e.g. no auth, offline). The static
 * list is deliberately small and may be wrong — `client.listModels()` is
 * the source of truth.
 */
export async function listAvailableModels(): Promise<{ models: ModelOption[]; source: 'sdk' | 'fallback' }> {
  if (modelsCache && Date.now() - modelsCache.fetchedAt < MODELS_CACHE_TTL_MS) {
    return { models: modelsCache.models, source: 'sdk' };
  }
  try {
    const client = await getCopilotClient();
    const raw = await client.listModels();
    const mapped: ModelOption[] = raw.map((m) => ({
      id: m.id,
      label: m.name || m.id,
      family: inferFamily(m.id),
      ...(m.billing && (m.billing as { isPremium?: boolean }).isPremium ? { note: 'premium' } : {}),
    }));
    modelsCache = { fetchedAt: Date.now(), models: mapped };
    logger.info({ count: mapped.length }, 'Fetched Copilot model list from SDK');
    return { models: mapped, source: 'sdk' };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, 'listModels failed — using static fallback list');
    return { models: [...FALLBACK_MODELS], source: 'fallback' };
  }
}

function inferFamily(id: string): ModelOption['family'] {
  const lower = id.toLowerCase();
  if (lower.startsWith('gpt')) return 'gpt';
  if (lower.startsWith('claude')) return 'claude';
  if (lower.startsWith('gemini')) return 'gemini';
  return 'other';
}

/** Test/dev hook to clear the in-memory model cache. */
export function resetModelsCache(): void {
  modelsCache = undefined;
}
