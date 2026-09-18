#!/usr/bin/env node
'use strict';
// Shared CI/index gate. Count complete before/after blobs for changed paths:
// their per-class difference is the net change, including multiline matches.
// Raw NUL-delimited Git records avoid filename quoting and hunk-parser bugs.
const { spawnSync } = require('child_process');
const POLICY_PATH = '.github/r75-policy.json';

function fail(message) {
  throw new Error(message);
}

function git(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.error || result.status !== 0) {
    fail(`git failed: ${result.error?.message || result.signal || result.status}`);
  }
  return result.stdout;
}

function argumentsOf(argv) {
  const args = {};
  for (const argument of argv) {
    const match = /^--(mode|base|head)=(.*)$/.exec(argument);
    if (!match || Object.hasOwn(args, match[1])) fail(`invalid or duplicate argument: ${argument}`);
    args[match[1]] = match[2];
  }
  if (args.mode === 'staged') {
    if (Object.hasOwn(args, 'base') || Object.hasOwn(args, 'head')) {
      fail('staged mode does not accept range references');
    }
    return { diff: ['--cached'], policy: `:${POLICY_PATH}`, label: 'staged index' };
  }
  if (args.mode !== 'range' || !args.base?.trim()) fail('range mode requires a nonempty base');
  const resolve = (ref) =>
    git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
  const base = resolve(args.base.trim());
  const head = resolve(args.head?.trim() || 'HEAD');
  const ancestor = git(['merge-base', base, head]).trim();
  if (!ancestor) fail('no merge base');
  return {
    diff: [ancestor, head],
    policy: `${head}:${POLICY_PATH}`,
    label: `${ancestor}..${head}`,
  };
}

function readPolicy(source) {
  const policy = JSON.parse(git(['show', source]));
  const scan = policy.scan;
  if (!scan || typeof scan !== 'object') fail('policy has no scan section');
  for (const key of [
    'includeExtensions',
    'includeRoots',
    'includeFiles',
    'excludeSuffixes',
    'excludeSegments',
  ]) {
    scan[key] ??= [];
    if (
      !Array.isArray(scan[key]) ||
      scan[key].some((value) => typeof value !== 'string' || !value)
    ) {
      fail(`unusable policy selector: ${key}`);
    }
  }
  if (!scan.includeExtensions.length || !(scan.includeRoots.length + scan.includeFiles.length)) {
    fail('policy needs extensions and a positive path selector');
  }
  const tokens = [];
  for (const entry of policy.literalTokens || []) {
    if (typeof entry.literal !== 'string' || !entry.literal) fail('invalid literal token');
    tokens.push({
      name: entry.name || entry.literal,
      regex: new RegExp(entry.literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
    });
  }
  for (const entry of policy.patternTokens || []) {
    if (typeof entry.pattern !== 'string' || !entry.pattern) fail('invalid pattern token');
    const regex = new RegExp(entry.pattern, 'g');
    if (regex.test('')) fail('pattern matches empty input');
    tokens.push({ name: entry.name, regex });
  }
  const names = tokens.map((token) => token.name);
  if (
    !names.length ||
    names.some((name) => typeof name !== 'string' || !name) ||
    new Set(names).size !== names.length
  )
    fail('missing, invalid or duplicate token names');
  const suppressed = new Set();
  for (const entry of policy.suppressions || []) {
    if (!names.includes(entry.token)) fail('suppression names an unknown token');
    suppressed.add(entry.token);
  }
  return { scan, tokens, suppressed };
}

function inScope(path, scan) {
  if (
    scan.excludeSegments.some((part) => path.startsWith(part) || path.includes(`/${part}`)) ||
    scan.excludeSuffixes.some((suffix) => path.endsWith(suffix))
  )
    return false;
  return (
    scan.includeFiles.includes(path) ||
    (scan.includeExtensions.some((suffix) => path.endsWith(suffix)) &&
      scan.includeRoots.some((root) => path.startsWith(root)))
  );
}

function count(text, token, suppressed) {
  let total = 0;
  for (const match of text.matchAll(token.regex)) {
    if (!match[0].length) fail(`zero-width policy match: ${token.name}`);
    const restOfLine = text.slice(match.index + match[0].length).split(/\r?\n/, 1)[0];
    const reason = restOfLine.replace(/\*\/\s*$/, '').trim();
    if (!suppressed.has(token.name) || !reason) total += 1;
  }
  return total;
}

function measure(scope, policy) {
  const records = git([
    'diff',
    ...scope.diff,
    '--raw',
    '--no-abbrev',
    '--no-renames',
    '--no-ext-diff',
    '--no-textconv',
    '-z',
  ]).split('\0');
  if (records.pop() !== '') fail('unterminated Git path records');
  if (records.length % 2) fail('incomplete Git path records');
  const totals = policy.tokens.map((token) => ({ token, before: 0, after: 0, files: [] }));
  for (let index = 0; index < records.length; index += 2) {
    const header = /^:\d{6} \d{6} ([a-f0-9]{40,64}) ([a-f0-9]{40,64}) [AMDT]$/.exec(records[index]);
    const path = records[index + 1];
    if (!header || !path) fail('unsupported Git change record, possibly an unresolved conflict');
    if (!inScope(path, policy.scan)) continue;
    const contents = header
      .slice(1)
      .map((sha) => (/^0+$/.test(sha) ? '' : git(['cat-file', 'blob', sha])));
    for (const total of totals) {
      const before = count(contents[0], total.token, policy.suppressed);
      const after = count(contents[1], total.token, policy.suppressed);
      total.before += before;
      total.after += after;
      if (after > before && total.files.length < 20) total.files.push(path);
    }
  }
  return totals;
}

try {
  const scope = argumentsOf(process.argv.slice(2));
  const totals = measure(scope, readPolicy(scope.policy));
  console.log(`R75 ${scope.label}; policy=${scope.policy}`);
  console.log('Counts are whole-file after (+) and before (-); net is the per-class change.');
  for (const { token, before, after } of totals) {
    if (before || after) console.log(`  ${token.name}  +${after} -${before} net ${after - before}`);
  }
  const offenders = totals.filter((total) => total.after > total.before);
  console.log(
    offenders.length ? 'FAIL: positive per-class token change' : 'OK — no positive token change',
  );
  for (const { token, before, after, files } of offenders) {
    console.log(`${token.name}: +${after} -${before} net +${after - before}`);
    for (const path of files) console.log(`  ${path}`);
  }
  process.exitCode = offenders.length ? 1 : 0;
} catch (error) {
  console.error(`R75 gate operational failure: ${error.message}`);
  process.exitCode = 2;
}
