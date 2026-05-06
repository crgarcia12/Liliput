/* eslint-disable */
// CommonJS preload for NODE_OPTIONS=--require.
// Loaded in BOTH the parent liliput-api process and the Copilot SDK CLI
// subprocess (subprocess inherits process.env from parent). This is the only
// place we can intercept the actual outgoing CAPI HTTP request and prove what
// reasoning_effort the SDK is sending.
//
// We log to stderr as JSON lines tagged "[effort-trace-preload]" so the
// k8s log aggregator picks them up regardless of which process they come from.
'use strict';

(function installFetchTracer() {
  if (typeof globalThis.fetch !== 'function') return;
  if (globalThis.__effortTraceInstalled) return;
  globalThis.__effortTraceInstalled = true;

  const CAPI_HOST_PATTERNS = [
    'githubcopilot.com',
    'individual.githubcopilot.com',
    'business.githubcopilot.com',
    'enterprise.githubcopilot.com',
  ];

  function isCapiUrl(url) {
    try {
      const u = new URL(url);
      return CAPI_HOST_PATTERNS.some((p) => u.hostname.includes(p));
    } catch {
      return false;
    }
  }

  function summarizeBody(raw) {
    try {
      const parsed = JSON.parse(raw);
      const out = {
        model: parsed.model,
        reasoning_effort: parsed.reasoning_effort,
      };
      if (parsed.outputConfig && parsed.outputConfig.effort) out.outputConfigEffort = parsed.outputConfig.effort;
      if (parsed.thinking) out.thinking = parsed.thinking.budget_tokens || parsed.thinking.type;
      return out;
    } catch {
      return null;
    }
  }

  function readBody(input) {
    if (input == null) return '';
    if (typeof input === 'string') return input;
    if (input instanceof URLSearchParams) return input.toString();
    try {
      if (input instanceof ArrayBuffer) return Buffer.from(input).toString('utf8');
      if (ArrayBuffer.isView(input)) {
        return Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString('utf8');
      }
    } catch {}
    return '';
  }

  function emit(obj) {
    try {
      // Pino-compatible JSON line so it merges into structured logs.
      const line = JSON.stringify({
        level: 30,
        time: Date.now(),
        pid: process.pid,
        proc: process.argv[1] && process.argv[1].includes('copilot') ? 'cli-subprocess' : 'parent',
        ...obj,
        msg: '[effort-trace-preload] outgoing CAPI POST',
      });
      process.stderr.write(line + '\n');
    } catch {}
  }

  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async function tracedFetch(input, init) {
    let url = '';
    let method = 'GET';
    try {
      url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input && input.url) || '';
      method = (init && init.method) || (input && input.method) || 'GET';
      method = String(method).toUpperCase();
    } catch {}

    if (method === 'POST' && isCapiUrl(url)) {
      let bodySource = init && init.body;
      if (bodySource == null && input && typeof input.clone === 'function') {
        try { bodySource = await input.clone().text(); } catch {}
      }
      const raw = readBody(bodySource);
      if (raw && raw[0] === '{') {
        const summary = summarizeBody(raw);
        if (summary) emit({ capiUrl: url, ...summary, bodyBytes: raw.length });
      }
    }

    return originalFetch(input, init);
  };

  // Confirmation line so we can prove the preload loaded in each process.
  try {
    process.stderr.write(
      JSON.stringify({
        level: 30,
        time: Date.now(),
        pid: process.pid,
        proc: process.argv[1] && process.argv[1].includes('copilot') ? 'cli-subprocess' : 'parent',
        msg: '[effort-trace-preload] fetch wrapper installed',
      }) + '\n',
    );
  } catch {}
})();
