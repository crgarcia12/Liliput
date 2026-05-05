import { CopilotClient } from '@github/copilot-sdk';
import { logger } from '../logger.js';
import { MODEL_OPTIONS as FALLBACK_MODELS, type ModelOption } from '../../../shared/types/index.js';

let clientPromise: Promise<CopilotClient> | undefined;
let modelsCache: { fetchedAt: number; models: ModelOption[] } | undefined;
const MODELS_CACHE_TTL_MS = 5 * 60_000;

/**
 * Lazily create and start a single shared CopilotClient.
 * The bundled Copilot CLI is spawned the first time this is called and
 * reused for every subsequent session.
 */
export function getCopilotClient(): Promise<CopilotClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const client = new CopilotClient({
        logLevel: (process.env['COPILOT_LOG_LEVEL'] as 'error' | 'info' | 'debug' | 'none' | 'warning' | 'all' | undefined) ?? 'warning',
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
