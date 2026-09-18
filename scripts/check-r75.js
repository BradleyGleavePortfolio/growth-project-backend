#!/usr/bin/env node
// R75 / R100.A2 banned-token substitution gate — the single implementation shared
// by the CI job (.github/workflows/r100-quality-gate.yml) and the pre-commit hook
// (lefthook.yml). Two divergent shell greps were deleted in favour of this.
//
//   node scripts/check-r75.js --mode=range --base=<ref> [--head=<ref>]
//   node scripts/check-r75.js --mode=staged
//
// Exit 0 = no net additions in any token class. Exit 1 = violation. Exit 2 =
// operational failure, which never degrades to empty input and a green pass.
//
// Net is per token class, every occurrence counts, a documented suppression
// discounts only that directive, and test sources are in scope.

'use strict';

const { spawnSync } = require('child_process');

const POLICY_IN_REPO = '.github/r75-policy.json';
const KNOWN_ARGS = new Set(['mode', 'base', 'head']);
const EXIT_OK = 0;
const EXIT_VIOLATION = 1;
const EXIT_OPERATIONAL = 2;

class OperationalError extends Error {}

function fail(message) {
  throw new OperationalError(message);
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([A-Za-z][A-Za-z0-9-]*)(?:=(.*))?$/.exec(arg);
    if (!m) fail(`unrecognised argument: ${arg}`);
    const key = m[1];
    if (!KNOWN_ARGS.has(key)) fail(`unknown option --${key}`);
    if (Object.prototype.hasOwnProperty.call(out, key))
      fail(`option --${key} given more than once`);
    if (m[2] === undefined) fail(`option --${key} requires a value`);
    out[key] = m[2];
  }
  return out;
}

// stderr is inherited, never suppressed, so a Git failure is visible in the job
// log instead of silently yielding no input.
function git(args, cwd) {
  const res = spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (res.error) fail(`git ${args.join(' ')} failed to spawn: ${res.error.message}`);
  if (res.status !== 0) {
    fail(
      `git ${args.join(' ')} exited ${res.status === null ? `on signal ${res.signal}` : res.status}`,
    );
  }
  return res.stdout;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function requireStringArray(value, label, { allowEmptyList }) {
  if (!Array.isArray(value)) fail(`R75 policy is unusable: ${label} must be an array`);
  if (!allowEmptyList && value.length === 0) {
    fail(`R75 policy is unusable: ${label} must not be empty`);
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) {
      // An empty selector is the dangerous case: an empty excludeSegments entry
      // matches every path and turns the gate green.
      fail(`R75 policy is unusable: ${label} contains an empty or non-string entry`);
    }
  }
  return value;
}

function buildPolicy(raw, source) {
  let policy;
  try {
    policy = JSON.parse(raw);
  } catch (err) {
    fail(`R75 policy from ${source} is not valid JSON: ${err.message}`);
  }
  const scan = policy && policy.scan;
  if (!scan || typeof scan !== 'object') fail('R75 policy is unusable: no scan section');

  requireStringArray(scan.includeExtensions, 'scan.includeExtensions', { allowEmptyList: false });
  const roots = requireStringArray(scan.includeRoots || [], 'scan.includeRoots', {
    allowEmptyList: true,
  });
  const files = requireStringArray(scan.includeFiles || [], 'scan.includeFiles', {
    allowEmptyList: true,
  });
  // Without at least one positive selector nothing is ever scanned and the gate
  // reports a green pass over an unmeasured diff.
  if (roots.length === 0 && files.length === 0) {
    fail('R75 policy is unusable: scan needs at least one includeRoots or includeFiles entry');
  }
  requireStringArray(scan.excludeSuffixes || [], 'scan.excludeSuffixes', { allowEmptyList: true });
  requireStringArray(scan.excludeSegments || [], 'scan.excludeSegments', { allowEmptyList: true });

  const tokens = [];
  for (const t of Array.isArray(policy.literalTokens) ? policy.literalTokens : []) {
    if (!t || typeof t.literal !== 'string' || t.literal.length === 0) {
      fail(`R75 policy is unusable: literalToken ${JSON.stringify(t)} has no literal`);
    }
    tokens.push({ name: t.name || t.literal, regex: new RegExp(escapeRegExp(t.literal), 'g') });
  }
  for (const t of Array.isArray(policy.patternTokens) ? policy.patternTokens : []) {
    if (!t || typeof t.pattern !== 'string' || t.pattern.length === 0) {
      fail(`R75 policy is unusable: patternToken ${JSON.stringify(t)} has no pattern`);
    }
    if (typeof t.name !== 'string' || t.name.length === 0) {
      fail(`R75 policy is unusable: patternToken ${t.pattern} has no name`);
    }
    let regex;
    try {
      regex = new RegExp(t.pattern, 'g');
    } catch (err) {
      fail(`R75 policy is unusable: patternToken ${t.name} has an invalid pattern: ${err.message}`);
    }
    if (regex.test('')) {
      fail(`R75 policy is unusable: patternToken ${t.name} matches the empty string`);
    }
    tokens.push({ name: t.name, regex });
  }
  if (tokens.length === 0) fail('R75 policy is unusable: no literalTokens or patternTokens');
  const names = tokens.map((t) => t.name);
  if (new Set(names).size !== names.length) {
    fail('R75 policy is unusable: duplicate token names');
  }

  const suppressed = new Set();
  for (const s of Array.isArray(policy.suppressions) ? policy.suppressions : []) {
    if (!s || typeof s.token !== 'string' || !names.includes(s.token)) {
      fail(`R75 policy is unusable: suppression ${JSON.stringify(s)} names no known token`);
    }
    suppressed.add(s.token);
  }
  return { scan, tokens, suppressed };
}

// R75 permits a suppression directive when the same line carries a reason. Canon
// says non-empty and nothing more, so this checks exactly that: at least one
// non-whitespace character after the directive. No minimum length, no ASCII or
// alphanumeric requirement, no issue-tracker lookup, no language classifier — a
// one-character or non-Latin reason is a valid reason.
function hasReason(rest) {
  return rest.replace(/\*\/\s*$/, '').trim().length > 0;
}

function inScope(filePath, scan) {
  if (!filePath) return false;
  for (const seg of scan.excludeSegments || []) {
    if (filePath.startsWith(seg) || filePath.includes(`/${seg}`)) return false;
  }
  for (const suf of scan.excludeSuffixes || []) {
    if (filePath.endsWith(suf)) return false;
  }
  if ((scan.includeFiles || []).includes(filePath)) return true;
  if (!scan.includeExtensions.some((e) => filePath.endsWith(e))) return false;
  return (scan.includeRoots || []).some((r) => filePath.startsWith(r));
}

// Changed paths come from `--name-status -z`, so names are raw NUL-delimited
// bytes: no quoting, and embedded spaces, tabs or newlines survive intact. The
// old `+++ b/<path>` header parser mangled all three and skipped content lines
// that themselves began with `+++`. --no-renames is deliberate: a rename is
// reported as a delete plus an add, so a file moved from an unscanned path INTO
// scope has its full content measured as added (the --find-renames form produced
// no hunks at all and let newly-scoped violations through), while a rename within
// scope nets to zero because the same occurrences are added and removed.
function changedPaths(diffArgs, cwd) {
  const out = git([...diffArgs, '--name-status', '--no-renames', '-z'], cwd);
  const fields = out.split('\0');
  const paths = [];
  for (let i = 0; i < fields.length; i += 1) {
    const status = fields[i];
    if (!status) continue;
    const name = fields[i + 1];
    i += 1;
    if (name === undefined || name === '') {
      fail(`git --name-status -z returned status ${status} with no path`);
    }
    paths.push({ status: status[0], path: name });
  }
  return paths;
}

// Parse one file's `--unified=0` diff. Only hunk bodies are read: everything
// before the first @@ is header, and inside a hunk the FIRST BYTE is the marker,
// so a content line of "+++x" (which arrives as "++++x") is counted correctly.
function parseFileDiff(diffText, addedPath, removedPath) {
  const added = [];
  const removed = [];
  let newLine = 0;
  let inHunk = false;
  for (const raw of diffText.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = parseInt(hunk[1], 10);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
    if (raw.startsWith('+')) {
      added.push({ file: addedPath, line: newLine, text: raw.slice(1) });
      newLine += 1;
    } else if (raw.startsWith('-')) {
      removed.push({ file: removedPath, line: null, text: raw.slice(1) });
    } else if (raw.startsWith(' ')) {
      newLine += 1;
    }
  }
  return { added, removed };
}

function collectLines(diffArgs, cwd, scan) {
  const added = [];
  const removed = [];
  for (const entry of changedPaths(diffArgs, cwd)) {
    if (!inScope(entry.path, scan)) continue;
    const text = git(
      [
        ...diffArgs,
        '--unified=0',
        '--no-color',
        '--no-ext-diff',
        '--no-renames',
        '--',
        `:(literal)${entry.path}`,
      ],
      cwd,
    );
    const addedPath = entry.status === 'D' ? null : entry.path;
    const removedPath = entry.status === 'A' ? null : entry.path;
    const parsed = parseFileDiff(text, addedPath, removedPath);
    added.push(...parsed.added);
    removed.push(...parsed.removed);
  }
  return { added, removed };
}

function countOccurrences(text, token, suppressed) {
  token.regex.lastIndex = 0;
  let count = 0;
  let m;
  while ((m = token.regex.exec(text)) !== null) {
    if (suppressed.has(token.name) && hasReason(text.slice(m.index + m[0].length))) {
      continue; // this directive is documented; other tokens on the line still count
    }
    count += 1;
  }
  return count;
}

function tally(lines, policy) {
  const counts = new Map(policy.tokens.map((t) => [t.name, 0]));
  const evidence = new Map(policy.tokens.map((t) => [t.name, []]));
  for (const entry of lines) {
    for (const token of policy.tokens) {
      const n = countOccurrences(entry.text, token, policy.suppressed);
      if (n === 0) continue;
      counts.set(token.name, counts.get(token.name) + n);
      const ev = evidence.get(token.name);
      if (ev.length < 20) {
        ev.push({
          file: entry.file,
          line: entry.line,
          text: entry.text.trim().slice(0, 160),
          occurrences: n,
        });
      }
    }
  }
  return { counts, evidence };
}

function resolveCommit(ref, cwd) {
  const out = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd).trim();
  if (!out) fail(`ref does not resolve to a commit: ${ref}`);
  return out;
}

// Which Git-visible content the run measures, and where the policy governing it
// comes from. Staged mode reads the index for both, so a dirty working tree
// cannot change the scanned content or the policy applied to it. The executable
// itself is necessarily the working-tree copy — Node has to load a real file —
// so this guarantees policy/content integrity, not checker-source integrity.
function resolveScope(mode, args, cwd) {
  if (mode === 'staged') {
    return { diffArgs: ['diff', '--cached'], policyFrom: ':', label: 'staged index content' };
  }
  if (mode === 'range') {
    const base = (args.base || '').trim();
    if (!base) {
      fail(
        '--mode=range requires --base=<ref>; refusing to fabricate a base (a missing base is a failure, not an empty diff)',
      );
    }
    const baseSha = resolveCommit(base, cwd);
    const headSha = resolveCommit((args.head || '').trim() || 'HEAD', cwd);
    // Three-dot: compare against the merge base, the same semantics GitHub uses
    // for a pull-request diff, so unrelated main commits are not attributed here.
    const mergeBase = git(['merge-base', baseSha, headSha], cwd).trim();
    if (!mergeBase) fail(`no merge base between ${baseSha} and ${headSha}`);
    return {
      diffArgs: ['diff', `${baseSha}...${headSha}`],
      policyFrom: `${headSha}:`,
      label: `${baseSha.slice(0, 12)}...${headSha.slice(0, 12)} (merge base ${mergeBase.slice(0, 12)})`,
    };
  }
  fail(`unsupported --mode=${String(mode)}; expected "range" or "staged"`);
}

function main(argv, cwd) {
  const args = parseArgs(argv);
  const mode = args.mode;
  if (mode === undefined) fail('--mode=range|staged is required');
  const { diffArgs, policyFrom, label } = resolveScope(mode, args, cwd);
  // The policy is read from the same Git content being measured — there is no
  // filesystem override — so the rules that gate a commit are the rules
  // committed with it and cannot be relaxed by an unstaged edit.
  const source = `${policyFrom}${POLICY_IN_REPO}`;
  const policy = buildPolicy(git(['show', source], cwd), source);
  const { added, removed } = collectLines(diffArgs, cwd, policy.scan);
  const addedTally = tally(added, policy);
  const removedTally = tally(removed, policy);

  console.log(`R75 / R100.A2 banned-token gate — mode=${mode}, scope=${label}, policy=${source}`);
  console.log('');
  const offenders = [];
  let anyMovement = false;
  for (const token of policy.tokens) {
    const a = addedTally.counts.get(token.name);
    const r = removedTally.counts.get(token.name);
    const net = a - r;
    if (a !== 0 || r !== 0) {
      anyMovement = true;
      console.log(
        `  ${token.name.padEnd(24)}  +${String(a).padEnd(4)} -${String(r).padEnd(4)} net ${net > 0 ? '+' : ''}${net}`,
      );
    }
    if (net > 0) offenders.push({ token, a, r, net });
  }
  if (!anyMovement) console.log('  (no banned-token occurrences added or removed in scope)');
  console.log('');

  if (offenders.length === 0) {
    console.log('OK — no net banned-token additions in any token class (R75 / R100.A2).');
    return EXIT_OK;
  }
  console.log('FAIL — R75 / R100.A2 violation: net positive additions in the token classes below.');
  console.log('       Net is measured PER TOKEN CLASS: removing a different banned token does');
  console.log('       not pay for introducing this one. Fix the underlying type or add a');
  console.log('       runtime guard. See AGENT_RULES.md R75 / R104 / R112. No exemptions.');
  for (const off of offenders) {
    console.log('');
    console.log(`  ${off.token.name}: +${off.a} -${off.r} net +${off.net}`);
    for (const ev of addedTally.evidence.get(off.token.name)) {
      console.log(`    ${ev.file}:${ev.line} (${ev.occurrences}x): ${ev.text}`);
    }
  }
  return EXIT_VIOLATION;
}

try {
  process.exitCode = main(process.argv.slice(2), process.cwd());
} catch (err) {
  if (err instanceof OperationalError) {
    console.error(`R75 gate operational failure: ${err.message}`);
    process.exitCode = EXIT_OPERATIONAL;
  } else {
    throw err;
  }
}
