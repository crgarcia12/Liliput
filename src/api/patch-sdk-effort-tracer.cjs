// Sed-patches the bundled @github/copilot SDK so getCompletionOptions
// emits the *actual* reasoning_effort that's about to go on the wire to CAPI.
// Runs once at Docker build time. Hard-fails if the needle is gone (drift detector).
const fs = require('fs');
const path = require('path');

const target = process.argv[2] || '/build/src/api/node_modules/@github/copilot/app.js';
// Inject inside the existing `let n=...,o=...,s=...;` declaration as an extra
// binding `_trace=IIFE()`. This is a no-op for SDK semantics (extra unused
// local) but lets us emit the actual reasoning_effort value to stderr right
// before the request body is built.
const needle = 'o=r?.reasoningEffort??this.clientOptions.defaultReasoningEffort,s=this.clientOptions';
const src = fs.readFileSync(target, 'utf8');

if (src.indexOf(needle) === -1) {
  console.error('SDK patch: needle not found in', target, '— SDK version drift?');
  process.exit(1);
}

if (src.indexOf('[effort-trace-sdk-patch]') !== -1) {
  console.log('SDK patch: already applied, skipping');
  process.exit(0);
}

// Build replacement: `o=...,_trace=IIFE(),s=...`. The IIFE writes a JSON
// line to stderr with the reasoning_effort value about to be used AND
// applies a force-override from /tmp/liliput-current-effort if present.
//
// Why the file override: the SDK's setModel(...,{reasoningEffort}) is
// silently no-op'd by an internal validator for some model families
// (e.g. claude-opus-4.7-high). The force-override is the bulletproof
// last line of defense. The orchestrator writes the per-task effort to
// /tmp/liliput-current-effort right before each turn.
//
// "\n" below is a real 2-char escape inside the source we're WRITING — when
// node parses the patched app.js, "\n" will be a single newline char.
const trace =
  '(function(){' +
    'try{' +
      'var _fs=require("fs");' +
      'try{' +
        'var _f=_fs.readFileSync("/tmp/liliput-current-effort","utf8").trim();' +
        'if(_f)o=_f;' +
      '}catch(_){}' +
      'process.stderr.write(JSON.stringify({' +
        'level:30,' +
        'time:Date.now(),' +
        'pid:process.pid,' +
        'proc:"sdk-patch",' +
        'reasoning_effort:o,' +
        'defaultReasoningEffort:this.clientOptions&&this.clientOptions.defaultReasoningEffort,' +
        'clientOptionsModel:this.clientOptions&&this.clientOptions.model,' +
        'msg:"[effort-trace-sdk-patch] getCompletionOptions"' +
      '})+"\\n");' +
    '}catch(_){}' +
    'return 0;' +
  '}).call(this)';

const replacement =
  'o=r?.reasoningEffort??this.clientOptions.defaultReasoningEffort,_trace=' +
  trace +
  ',s=this.clientOptions';
const patched = src.replace(needle, replacement);

fs.writeFileSync(target, patched);
console.log('SDK patched: getCompletionOptions tracer injected at', target);
