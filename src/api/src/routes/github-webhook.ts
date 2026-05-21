/**
 * GitHub webhook receive endpoint.
 *
 * Mounted BEFORE `express.json()` because HMAC verification must run on the
 * exact raw bytes GitHub sent — re-stringifying the parsed JSON would change
 * whitespace and invalidate the signature.
 *
 * Responsibilities of THIS module:
 *   1. Parse the raw body to a Buffer.
 *   2. Verify the X-Hub-Signature-256 HMAC against GITHUB_WEBHOOK_SECRET.
 *   3. Dedup by X-GitHub-Delivery via the `github_deliveries` table.
 *   4. Hand the parsed payload to the dispatcher (no-op in PR-2; real
 *      handlers land in PR-5/6).
 *
 * Everything else (dev pickup, RM review) lives in dedicated engine modules.
 *
 * Security notes:
 *   - If GITHUB_WEBHOOK_SECRET is missing, the endpoint refuses ALL requests
 *     with 503 — we never accept unsigned webhooks.
 *   - `timingSafeEqual` is used for the signature comparison.
 *   - The payload is parsed only AFTER signature verification succeeds.
 */

import crypto from 'node:crypto';
import express from 'express';
import type { Request, Response } from 'express';
import { logger } from '../logger.js';
import { getDb } from '../stores/db.js';

const SIGNATURE_HEADER = 'x-hub-signature-256';
const DELIVERY_HEADER = 'x-github-delivery';
const EVENT_HEADER = 'x-github-event';

type DispatcherInput = {
  deliveryId: string;
  event: string;
  action: string | undefined;
  repository: string | undefined;
  payload: unknown;
};

export type WebhookDispatcher = (input: DispatcherInput) => Promise<void> | void;

/** Default dispatcher: log and no-op. Real handlers land in PR-5/6. */
const defaultDispatcher: WebhookDispatcher = ({ deliveryId, event, action, repository }) => {
  logger.info(
    { deliveryId, event, action, repository },
    'github-webhook: received (no-op dispatcher in PR-2)',
  );
};

/**
 * Constant-time string comparison wrapper that returns false for length
 * mismatches instead of throwing.
 */
function safeEqualHex(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export function verifySignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected =
    'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqualHex(header, expected);
}

interface DeliveryRow {
  delivery_id: string;
  status: string;
}

export interface WebhookRouterOptions {
  /** Override the secret source (tests). Falls back to env. */
  secret?: string;
  /** Override the dispatcher (tests / PR-5/6 wiring). */
  dispatcher?: WebhookDispatcher;
}

export function createGitHubWebhookRouter(opts: WebhookRouterOptions = {}): express.Router {
  const router = express.Router();
  const secret = opts.secret ?? process.env['GITHUB_WEBHOOK_SECRET'] ?? '';
  const dispatcher = opts.dispatcher ?? defaultDispatcher;

  // Raw body, capped to 25 MB (GitHub's limit is 25 MB).
  router.post(
    '/api/github/webhook',
    express.raw({ type: '*/*', limit: '25mb' }),
    async (req: Request, res: Response) => {
      if (!secret) {
        // Endpoint mounted but mis-configured. Refuse loudly.
        logger.error({}, 'github-webhook: GITHUB_WEBHOOK_SECRET not set; rejecting');
        res.status(503).json({ error: 'webhook endpoint not configured' });
        return;
      }

      const raw = req.body as Buffer;
      if (!Buffer.isBuffer(raw)) {
        res.status(400).json({ error: 'expected raw body' });
        return;
      }

      const signature = (req.headers[SIGNATURE_HEADER] as string | undefined) ?? undefined;
      if (!verifySignature(secret, raw, signature)) {
        logger.warn({ ip: req.ip }, 'github-webhook: signature mismatch');
        res.status(401).json({ error: 'invalid signature' });
        return;
      }

      const deliveryId = (req.headers[DELIVERY_HEADER] as string | undefined)?.trim();
      const event = (req.headers[EVENT_HEADER] as string | undefined)?.trim();
      if (!deliveryId || !event) {
        res.status(400).json({ error: 'missing delivery or event header' });
        return;
      }

      let payload: { action?: string; repository?: { full_name?: string } } & Record<string, unknown>;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        res.status(400).json({ error: 'invalid json' });
        return;
      }

      const action = typeof payload.action === 'string' ? payload.action : undefined;
      const repository = payload.repository?.full_name;

      // Dedup: try to insert; if delivery_id already exists, this is a redelivery.
      const db = getDb();
      const existing = db
        .prepare('SELECT delivery_id, status FROM github_deliveries WHERE delivery_id = ?')
        .get(deliveryId) as DeliveryRow | undefined;

      if (existing) {
        logger.info(
          { deliveryId, event, action, status: existing.status },
          'github-webhook: duplicate delivery, skipping',
        );
        // Return 200 so GitHub stops retrying.
        res.status(200).json({ ok: true, deduplicated: true });
        return;
      }

      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO github_deliveries
           (delivery_id, event, action, repository, received_at, status)
         VALUES (?, ?, ?, ?, ?, 'received')`,
      ).run(deliveryId, event, action ?? null, repository ?? null, now);

      // Acknowledge synchronously so GitHub doesn't time out; dispatch async.
      res.status(202).json({ ok: true, deliveryId });

      try {
        await dispatcher({ deliveryId, event, action, repository, payload });
        db.prepare(
          `UPDATE github_deliveries SET processed_at = ?, status = 'processed' WHERE delivery_id = ?`,
        ).run(new Date().toISOString(), deliveryId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ deliveryId, err: message }, 'github-webhook: dispatcher failed');
        db.prepare(
          `UPDATE github_deliveries SET processed_at = ?, status = 'error', error = ? WHERE delivery_id = ?`,
        ).run(new Date().toISOString(), message.slice(0, 2000), deliveryId);
      }
    },
  );

  return router;
}
