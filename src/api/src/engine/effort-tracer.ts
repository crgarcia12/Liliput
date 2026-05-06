/**
 * E2E reasoning_effort tracer.
 *
 * Wraps globalThis.fetch so every outgoing request to the Copilot CAPI is
 * inspected. We log the URL, method, and (if it's a JSON POST) the values of
 * `model` and `reasoning_effort` from the request body. This is the *only*
 * source of truth for "what reasoning_effort actually went on the wire" — all
 * the layers above (createSession, setModel, updateOptions) can silently
 * mutate the value.
 *
 * Activated once at process start by importing this module from index.ts.
 * No-op on subsequent imports.
 */
import { logger } from '../logger.js';

let installed = false;

const CAPI_HOST_PATTERNS = [
  'githubcopilot.com',
  'api.individual.githubcopilot.com',
  'api.business.githubcopilot.com',
  'api.enterprise.githubcopilot.com',
  'proxy.individual.githubcopilot.com',
  'proxy.business.githubcopilot.com',
  'proxy.enterprise.githubcopilot.com',
];

function isCapiUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return CAPI_HOST_PATTERNS.some((p) => u.hostname.includes(p));
  } catch {
    return false;
  }
}

function summarizeBody(raw: string): {
  model?: unknown;
  reasoning_effort?: unknown;
  effort?: unknown;
  thinking?: unknown;
  bodyBytes: number;
  parseOk: boolean;
} {
  const bodyBytes = raw.length;
  try {
    const parsed = JSON.parse(raw);
    return {
      model: parsed.model,
      reasoning_effort: parsed.reasoning_effort,
      effort: parsed.outputConfig?.effort ?? parsed.effort,
      thinking: parsed.thinking?.budget_tokens ?? parsed.thinking?.type,
      bodyBytes,
      parseOk: true,
    };
  } catch {
    return { bodyBytes, parseOk: false };
  }
}

async function readBody(input: unknown): Promise<string> {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (input instanceof URLSearchParams) return input.toString();
  if (input instanceof ArrayBuffer) {
    return Buffer.from(input).toString('utf8');
  }
  if (ArrayBuffer.isView(input)) {
    const view = input as ArrayBufferView;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('utf8');
  }
  // Blob / FormData / ReadableStream — too noisy to drain, just note the type
  const ctorName = (input as { constructor?: { name?: string } }).constructor?.name ?? typeof input;
  return `[non-string body: ${ctorName}]`;
}

export function installEffortTracer(): void {
  if (installed) return;
  installed = true;

  // If the CJS preload already wrapped fetch, defer to it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((globalThis as any).__effortTraceInstalled) {
    logger.info('[effort-trace] CJS preload already installed fetch wrapper — skipping ESM install');
    return;
  }

  const originalFetch: typeof fetch = globalThis.fetch.bind(globalThis);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = async function tracedFetch(
    input: unknown,
    init?: RequestInit,
  ): Promise<Response> {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as { url?: string })?.url ?? '';
    const reqMethod =
      init?.method ?? (input && typeof input === 'object' && 'method' in input ? (input as { method?: string }).method : undefined);
    const method = (reqMethod ?? 'GET').toUpperCase();

    if (method === 'POST' && isCapiUrl(url)) {
      let bodySource: unknown = init?.body;
      if (bodySource == null && input && typeof input === 'object' && 'clone' in input) {
        try {
          bodySource = await (input as Request).clone().text();
        } catch {
          // ignore — Request already consumed elsewhere
        }
      }
      try {
        const raw = await readBody(bodySource);
        if (raw && raw[0] === '{') {
          const summary = summarizeBody(raw);
          logger.info(
            {
              capiUrl: url,
              method,
              ...summary,
            },
            '[effort-trace] outgoing CAPI POST',
          );
        }
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), url },
          '[effort-trace] failed to inspect outgoing body',
        );
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return originalFetch(input as any, init);
  };

  logger.info('[effort-trace] global fetch wrapper installed');
}
