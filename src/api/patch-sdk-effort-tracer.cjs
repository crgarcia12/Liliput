// Sed-patches the bundled @github/copilot SDK so getCompletionOptions
// emits the *actual* reasoning_effort that's about to go on the wire to CAPI.
// Runs once at Docker build time. Hard-fails if the needle is gone (drift detector).
const fs = require('fs');
const path = require('path');

const target = process.argv[2] || '/build/src/api/node_modules/@github/copilot/app.js';
const needle = 'if(o)return{reasoning_effort:o,';
const src = fs.readFileSync(target, 'utf8');

if (src.indexOf(needle) === -1) {
  console.error('SDK patch: needle not found in', target, '— SDK version drift?');
  process.exit(1);
}

if (src.indexOf('[effort-trace-sdk-patch]') !== -1) {
  console.log('SDK patch: already applied, skipping');
  process.exit(0);
}

// The replacement is built as a JS string. The "\n" below is a real
// 2-char escape inside the source we're WRITING — when node parses the
// patched app.js, "\n" will mean a single newline char in the string literal.
const trace =
  'try{process.stderr.write(JSON.stringify({' +
  'level:30,' +
  'time:Date.now(),' +
  'pid:process.pid,' +
  'proc:"sdk-patch",' +
  'reasoning_effort:o,' +
  'defaultReasoningEffort:this.clientOptions&&this.clientOptions.defaultReasoningEffort,' +
  'clientOptionsModel:this.clientOptions&&this.clientOptions.model,' +
  'msg:"[effort-trace-sdk-patch] getCompletionOptions"' +
  '})+"\\n")}catch(_){}';

const replacement = 'if(o){' + trace + 'return{reasoning_effort:o,';
const patched = src.replace(needle, replacement);

fs.writeFileSync(target, patched);
console.log('SDK patched: getCompletionOptions tracer injected at', target);
