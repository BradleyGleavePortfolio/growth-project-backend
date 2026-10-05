const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const root = '/home/user/workspace/growth-project-backend';
const here = '/home/user/workspace/ops/aud-121/AUD-SOL-D5-121';
function git(...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}
function canonicalPatch(from, to) {
  return git('diff', '--no-prefix', '--unified=0', from, to)
    .split('\n').filter(l => !l.startsWith('index ') && !l.startsWith('@@')).join('\n');
}
const rows = [];
for (const [number, old, lower, merge, fixBase] of [
  [710, '3572b209', '8d3cf36c', '1b9a2d8a', 'd9cf7ad9'],
  [711, 'db7fa3bf', '654b048a', '071ccda2', '3572b209'],
]) {
  let raw;
  try {
    raw = git('merge-tree', '--write-tree', old, lower);
  } catch (e) {
    if (e.status !== 1) throw e;
    raw = e.stdout;
  }
  fs.writeFileSync(`${here}/${number}-merge-tree.txt`, raw);
  const computed = raw.split('\n')[0];
  const differing = git('diff', '--name-only', computed, merge).trim().split('\n');
  const conflict = 'test/messaging/messaging-core-v2.spec.ts';
  if (differing.length !== 1 || differing[0] !== conflict) {
    throw new Error(`${number}: unexpected resolution paths ${differing.join(',')}`);
  }
  const upstream = canonicalPatch(fixBase, lower);
  const merged = canonicalPatch(old, merge);
  fs.writeFileSync(`${here}/${number}-upstream-canonical.diff`, upstream);
  fs.writeFileSync(`${here}/${number}-merged-canonical.diff`, merged);
  if (upstream !== merged) {
    throw new Error(`${number}: resolved merge has changes beyond the exact lower-piece fix`);
  }
  const candidate = git('show', `${merge}:${conflict}`);
  if (/^(<<<<<<<|=======|>>>>>>>)/m.test(candidate)) {
    throw new Error(`${number}: resolution markers remain`);
  }
  rows.push({
    number, old, lower, merge,
    computedConflictTree: computed,
    actualMergeTree: git('rev-parse', `${merge}^{tree}`).trim(),
    onlyConflictPath: conflict,
    upstreamFixPatchEqualsResolvedMergePatch: true,
  });
}
fs.writeFileSync(`${here}/restack-verification.json`, JSON.stringify(rows, null, 2) + '\n');
console.log(JSON.stringify(rows, null, 2));
