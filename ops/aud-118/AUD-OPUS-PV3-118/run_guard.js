const g = require('./guard_extract.js');
const { readFileSync } = require('fs'); const { join, relative } = require('path');
const root = process.argv[2] + '/src';
let scanned = 0; const exc = {}; const found = []; const all = [];
for (const file of g.sourceFiles(root)) {
  const src = readFileSync(file, 'utf8');
  const rel = relative(join(root, '..'), file);
  const ctx = { encodesAddress: g.ENCODES_ADDRESS.test(src) };
  for (const call of g.logCalls(src)) {
    scanned++;
    const v = g.violations(call.code, ctx);
    all.push({ rel, line: call.line, code: call.code.replace(/\s+/g, ' ').trim(), v });
    if (v.includes('exception-text')) exc[rel] = (exc[rel] ?? 0) + 1;
    const strict = v.filter((x) => x !== 'exception-text');
    if (strict.length) found.push(`${rel}:${call.line} [${strict}] ${call.code}`);
  }
}
const sum = Object.values(exc).reduce((a, b) => a + b, 0);
const base = g.LEGACY_EXCEPTION_TEXT;
const bsum = Object.values(base).reduce((a, b) => a + b, 0);
console.log('scanned', scanned, 'excFiles', Object.keys(exc).length, 'excSum', sum, 'baselineFiles', Object.keys(base).length, 'baselineSum', bsum, 'strictFound', found.length);
const diffs = [];
for (const k of new Set([...Object.keys(exc), ...Object.keys(base)])) if (exc[k] !== base[k]) diffs.push([k, exc[k], base[k]]);
console.log('diffs', JSON.stringify(diffs));
require('fs').writeFileSync('guard_all_calls.json', JSON.stringify(all, null, 0));
