import { CopilotClient } from '@github/copilot-sdk';
import { logger } from '../logger.js';

let clientPromise: Promise<CopilotClient> | undefined;

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
