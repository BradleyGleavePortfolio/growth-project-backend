#!/usr/bin/env node
// R75 / R100.A2 banned-cast substitution gate — the single implementation shared
// by the CI job (.github/workflows/r100-quality-gate.yml) and the pre-commit hook
// (lefthook.yml). Two divergent shell greps were deleted in favour of this.
//
// Usage:
//   node scripts/check-r75.js --mode=range --base=<ref> [--head=<ref>]
//   node scripts/check-r75.js --mode=staged
//
// Exit codes: 0 = no net additions, 1 = R75 violation, 2 = operational failure
// (bad mode, missing/malformed base, invalid Git object, Git failure, unusable
// policy). An operational failure NEVER degrades to empty input and a green pass.
//
// Measurement semantics that the previous shell gate got wrong:
//   1. Net is computed PER TOKEN. Deleting an unrelated banned token can never
//      pay for introducing a different one (the substitution loophole R75 exists
//      to close).
//   2. Every OCCURRENCE counts, not every matching line.
//   3. A documented suppression discounts only that directive occurrence; other
//      banned tokens on the same line are still counted.
//   4. Test and co-located spec sources are scanned, not excluded.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const POLICY_PATH = path.join(__dirname, '..', '.github', 'r75-policy.json');
const EXIT_OK = 0;
const EXIT_VIOLATION = 1;
const EXIT_OPERATIONAL = 2;

class OperationalError extends Error {}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([A-Za-z][A-Za-z0-9-]*)(?:=(.*))?$/.exec(arg);
    if (!m) throw new OperationalError(`unrecognised argument: ${arg}`);
    out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

// Every Git invocation is checked. stderr is inherited, never suppressed, so a
// Git failure is visible in the job log instead of silently yielding no input.
function git(args, cwd) {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (res.error)
    throw new OperationalError(`git ${args.join(' ')} failed to spawn: ${res.error.message}`);
  if (res.status !== 0) {
    throw new OperationalError(
      `git ${args.join(' ')} exited ${res.status === null ? `on signal ${res.signal}` : res.status}`,
    );
  }
  return res.stdout;
}

function loadPolicy(policyPath) {
  let raw;
  try {
    raw = fs.readFileSync(policyPath, 'utf8');
  } catch (err) {
    throw new OperationalError(`cannot read R75 policy at ${policyPath}: ${err.message}`);
  }
  let policy;
  try {
    policy = JSON.parse(raw);
  } catch (err) {
    throw new OperationalError(`R75 policy at ${policyPath} is not valid JSON: ${err.message}`);
  }
  const scan = policy && policy.scan;
  if (!scan || !Array.isArray(scan.includeExtensions) || scan.includeExtensions.length === 0) {
    throw new OperationalError(
      'R75 policy is unusable: scan.includeExtensions must be a non-empty array',
    );
  }
  const literals = Array.isArray(policy.literalTokens) ? policy.literalTokens : [];
  const patterns = Array.isArray(policy.patternTokens) ? policy.patternTokens : [];
  if (literals.length + patterns.length === 0) {
    throw new OperationalError(
      'R75 policy is unusable: no literalTokens or patternTokens declared',
    );
  }
  const tokens = [];
  for (const t of literals) {
    if (!t || typeof t.literal !== 'string' || t.literal.length === 0) {
      throw new OperationalError(
        `R75 policy is unusable: literalToken ${JSON.stringify(t)} has no literal`,
      );
    }
    tokens.push({ name: t.name || t.literal, regex: new RegExp(escapeRegExp(t.literal), 'g') });
  }
  for (const t of patterns) {
    if (!t || typeof t.pattern !== 'string' || t.pattern.length === 0) {
      throw new OperationalError(
        `R75 policy is unusable: patternToken ${JSON.stringify(t)} has no pattern`,
      );
    }
    let regex;
    try {
      regex = new RegExp(t.pattern, 'g');
    } catch (err) {
      throw new OperationalError(
        `R75 policy is unusable: patternToken ${t.name} has an invalid pattern: ${err.message}`,
      );
    }
    tokens.push({ name: t.name || t.pattern, regex });
  }
  const names = tokens.map((t) => t.name);
  if (new Set(names).size !== names.length) {
    throw new OperationalError('R75 policy is unusable: duplicate token names');
  }
  const suppressions = new Map();
  for (const s of Array.isArray(policy.suppressions) ? policy.suppressions : []) {
    if (!s || typeof s.token !== 'string') {
      throw new OperationalError(
        `R75 policy is unusable: suppression ${JSON.stringify(s)} has no token`,
      );
    }
    if (!names.includes(s.token)) {
      throw new OperationalError(
        `R75 policy is unusable: suppression names unknown token ${s.token}`,
      );
    }
    suppressions.set(s.token, {
      reasonMinChars: Number.isInteger(s.reasonMinChars) ? s.reasonMinChars : 1,
    });
  }
  return { scan, tokens, suppressions };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Bounded reason validation: non-empty, at least reasonMinChars of substance,
// and at least one alphanumeric character. Deliberately NOT an issue-tracker
// lookup and NOT a natural-language classifier — R75 requires only a non-empty
// same-line reason.
function hasMeaningfulReason(rest, reasonMinChars) {
  const cleaned = rest
    .replace(/^[\s:;,.\-–—*/=>]+/, '')
    .replace(/\*\/\s*$/, '')
    .trim();
  if (cleaned.length < reasonMinChars) return false;
  return /[A-Za-z0-9]/.test(cleaned);
}

function inScope(filePath, scan) {
  if (!filePath) return false;
  for (const seg of scan.excludeSegments || []) {
    if (filePath === seg || filePath.startsWith(seg) || filePath.includes(`/${seg}`)) return false;
  }
  for (const suf of scan.excludeSuffixes || []) {
    if (filePath.endsWith(suf)) return false;
  }
  if ((scan.includeFiles || []).includes(filePath)) return true;
  const hasExt = (scan.includeExtensions || []).some((e) => filePath.endsWith(e));
  if (!hasExt) return false;
  return (scan.includeRoots || []).some((r) => filePath.startsWith(r));
}

// Parse `git diff --unified=0` into added/removed lines with their file and, for
// added lines, their new-file line number (kept for failure diagnostics).
function parseDiff(diffText) {
  const added = [];
  const removed = [];
  let newPath = null;
  let oldPath = null;
  let newLine = 0;
  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      newPath = null;
      oldPath = null;
      continue;
    }
    if (raw.startsWith('--- ')) {
      const p = raw.slice(4);
      oldPath = p === '/dev/null' ? null : p.replace(/^[ab]\//, '');
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4);
      newPath = p === '/dev/null' ? null : p.replace(/^[ab]\//, '');
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = parseInt(hunk[1], 10);
      continue;
    }
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      added.push({ file: newPath, line: newLine, text: raw.slice(1) });
      newLine += 1;
      continue;
    }
    if (raw.startsWith('-') && !raw.startsWith('---')) {
      removed.push({ file: oldPath, line: null, text: raw.slice(1) });
    }
  }
  return { added, removed };
}

function countOccurrences(text, token, suppressions) {
  const suppression = suppressions.get(token.name);
  token.regex.lastIndex = 0;
  let count = 0;
  let m;
  while ((m = token.regex.exec(text)) !== null) {
    if (m[0].length === 0) {
      token.regex.lastIndex += 1;
      continue;
    }
    if (
      suppression &&
      hasMeaningfulReason(text.slice(m.index + m[0].length), suppression.reasonMinChars)
    ) {
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
    if (!inScope(entry.file, policy.scan)) continue;
    for (const token of policy.tokens) {
      const n = countOccurrences(entry.text, token, policy.suppressions);
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
  if (!out) throw new OperationalError(`ref does not resolve to a commit: ${ref}`);
  return out;
}

function collectDiff(mode, args, cwd) {
  const common = [
    '-c',
    'core.quotepath=false',
    'diff',
    '--unified=0',
    '--no-color',
    '--no-ext-diff',
    '--find-renames',
  ];
  if (mode === 'staged') {
    return { text: git([...common, '--cached'], cwd), label: 'staged index content' };
  }
  if (mode === 'range') {
    const base = typeof args.base === 'string' ? args.base.trim() : '';
    if (!base) {
      throw new OperationalError(
        '--mode=range requires --base=<ref>; refusing to fabricate a base (missing base is a failure, not an empty diff)',
      );
    }
    const head = typeof args.head === 'string' && args.head.trim() ? args.head.trim() : 'HEAD';
    const baseSha = resolveCommit(base, cwd);
    const headSha = resolveCommit(head, cwd);
    // Three-dot: compare against the merge base, the same semantics GitHub uses
    // for a pull-request diff, so unrelated main commits are not attributed here.
    const mergeBase = git(['merge-base', baseSha, headSha], cwd).trim();
    if (!mergeBase) throw new OperationalError(`no merge base between ${baseSha} and ${headSha}`);
    return {
      text: git([...common, `${baseSha}...${headSha}`], cwd),
      label: `${baseSha.slice(0, 12)}...${headSha.slice(0, 12)} (merge base ${mergeBase.slice(0, 12)})`,
    };
  }
  throw new OperationalError(`unsupported --mode=${String(mode)}; expected "range" or "staged"`);
}

function main(argv, cwd) {
  const args = parseArgs(argv);
  const policy = loadPolicy(args.policy || POLICY_PATH);
  const mode = args.mode;
  if (mode === undefined || mode === true) {
    throw new OperationalError('--mode=range|staged is required');
  }
  const { text, label } = collectDiff(mode, args, cwd);
  const { added, removed } = parseDiff(text);
  const addedTally = tally(added, policy);
  const removedTally = tally(removed, policy);

  console.log(`R75 / R100.A2 banned-cast gate — mode=${mode}, scope=${label}`);
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
  console.log('       Net is measured PER TOKEN: removing a different banned token does not');
  console.log('       pay for introducing this one. Fix the underlying type or add a runtime');
  console.log('       guard. See AGENT_RULES.md R75 / R104 / R112. No exemptions.');
  for (const off of offenders) {
    console.log('');
    console.log(`  ${off.token.name}: +${off.a} -${off.r} net +${off.net}`);
    for (const ev of addedTally.evidence.get(off.token.name)) {
      const where = ev.line ? `${ev.file}:${ev.line}` : String(ev.file);
      console.log(`    ${where} (${ev.occurrences}x): ${ev.text}`);
    }
  }
  return EXIT_VIOLATION;
}

if (require.main === module) {
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
}

module.exports = { main, loadPolicy, parseDiff, inScope, hasMeaningfulReason, OperationalError };
