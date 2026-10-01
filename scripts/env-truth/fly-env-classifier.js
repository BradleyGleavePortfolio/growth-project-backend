'use strict';
/*
 * scripts/env-truth/fly-env-classifier.js (S-ENVTRUTH)
 *
 * Read-only env-truth classifier. Runs INSIDE the production Fly machine (see
 * .github/workflows/fly-env-truth.yml) so secret values never leave it. For
 * every registered env name (src/common/env-validation.ts ENV_RULES) and every
 * env var actually present in the process environment it reports:
 *
 *   present / missing, empty, placeholder-pattern id, duplicate-group id
 *   (keys that share one value), length bucket, registered or not, plus
 *   pass/fail value-shape checks for APPLE_AUDIENCES (first entry is the iOS
 *   bundle id) and ANDROID_CERT_SHA256_FINGERPRINTS (colon-hex SHA-256 list).
 *
 * VALUE SAFETY (the whole point of this file):
 *   - Values are read only to compute booleans, a pattern id, a length bucket
 *     and an in-memory hash. No value, prefix, suffix, digest or hash is ever
 *     written to stdout, a file or a return value.
 *   - Duplicate detection hashes sha256(salt || value) with a random 32-byte
 *     per-run salt generated in-process and discarded on exit. Hashes are used
 *     only as Map keys; the report carries opaque group ids (D1, D2, ...).
 *   - Placeholder detection returns a fixed pattern id, never the match text.
 *
 * Zero dependencies (Node built-ins only) and CommonJS, so it can be shipped
 * inline (base64) through `flyctl ssh console -C` without depending on the
 * deployed image's contents beyond a `node` binary.
 *
 * The same module is used on the CI runner to extract the registered names
 * from env-validation.ts and to render the job summary from the JSON report.
 */

const crypto = require('crypto');

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const REPORT_MARKER = 'ENV_TRUTH_REPORT_JSON:';

/**
 * Placeholder patterns, checked in order. Each entry is [id, predicate]. The
 * predicate receives the RAW value; it must not retain it. Keep these narrow:
 * a false positive here only produces a report line (it never blocks boot),
 * but a noisy report hides the real fakes.
 */
const PLACEHOLDER_PATTERNS = [
  ['angle-brackets', (v) => /^<[^>]*>$/.test(v.trim())],
  [
    'sentinel-word',
    (v) =>
      new Set([
        'changeme',
        'change_me',
        'change-me',
        'placeholder',
        'replace_me',
        'replace-me',
        'replaceme',
        'todo',
        'tbd',
        'fixme',
        'your-key-here',
        'your_key_here',
        'yourkeyhere',
        'xxx',
        'dummy',
        'fake',
        'stub',
        'sample',
        'example',
        'test',
        'secret',
        'password',
        'none',
        'null',
        'undefined',
        'n/a',
        'na',
        '-',
        'false-placeholder',
      ]).has(v.trim().toLowerCase()),
  ],
  ['x-run', (v) => /([xX])\1{7,}/.test(v)],
  ['repeated-char', (v) => v.trim().length >= 4 && /^(.)\1+$/.test(v.trim())],
  [
    'known-dev-default',
    (v) => new Set(['change-me-in-production-min32chars!', 'tm3-public-cursor-dev']).has(v.trim()),
  ],
  [
    'placeholder-prefix',
    (v) => /^(test|dummy|fake|example|placeholder|sample|your)[-_ ]/i.test(v.trim()),
  ],
  ['todo-marker', (v) => /\b(TODO|FIXME|REPLACE[_ ]?ME|CHANGE[_ ]?ME)\b/i.test(v)],
  ['example-domain', (v) => /\bexample\.(com|org|net)\b/i.test(v)],
  ['localhost', (v) => /\b(localhost|127\.0\.0\.1|0\.0\.0\.0)\b/i.test(v)],
  ['test-mode-key', (v) => /^(sk|pk|rk|whsec)_test_/.test(v.trim())],
  ['wrapped-in-quotes', (v) => /^(['"]).*\1$/.test(v.trim()) && v.trim().length >= 2],
  ['surrounding-whitespace', (v) => v.length > 0 && v !== v.trim() && v.trim().length > 0],
];

/**
 * Value-shape checks (operator 2026-10-01). Each returns true/false only; the
 * report carries 'pass' | 'fail' | 'missing', never the value or the entry
 * that failed.
 */
const IOS_BUNDLE_ID = 'com.growthproject.app';
const COLON_HEX_SHA256 = /^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/;
const SHAPE_CHECKS = [
  {
    name: 'APPLE_AUDIENCES',
    check: 'first-entry-is-ios-bundle-id',
    describe: `comma list whose first entry is exactly ${IOS_BUNDLE_ID} (Sign in with Apple + deletion-time token revocation)`,
    test: (v) => v.split(',')[0].trim() === IOS_BUNDLE_ID,
  },
  {
    name: 'ANDROID_CERT_SHA256_FINGERPRINTS',
    check: 'non-empty-colon-hex-sha256',
    describe: 'non-empty; every comma entry is a colon-separated SHA-256 (32 hex byte pairs)',
    test: (v) => {
      const entries = v
        .split(',')
        .map((e) => e.trim())
        .filter((e) => e.length > 0);
      return entries.length > 0 && entries.every((e) => COLON_HEX_SHA256.test(e));
    },
  },
];

/** Run the value-shape checks. Returns [{name, check, describe, result}] with result pass|fail|missing. */
function shapeChecks(env) {
  return SHAPE_CHECKS.map((c) => {
    const v = env[c.name];
    let result;
    if (typeof v !== 'string' || v.trim().length === 0) result = 'missing';
    else result = c.test(v) ? 'pass' : 'fail';
    return { name: c.name, check: c.check, describe: c.describe, result };
  });
}

/** Return the first matching placeholder pattern id, or null. Never returns the value. */
function placeholderPattern(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  for (const [id, test] of PLACEHOLDER_PATTERNS) {
    if (test(value)) return id;
  }
  return null;
}

/** Coarse length bucket so a 1-char or truncated secret stands out. */
function lengthBucket(len) {
  if (len <= 0) return '0';
  if (len < 8) return '1-7';
  if (len < 16) return '8-15';
  if (len < 32) return '16-31';
  if (len < 64) return '32-63';
  if (len < 128) return '64-127';
  return '128+';
}

/** True for names that look truncated or malformed (e.g. `E`, `E_MB`). */
function suspiciousName(name) {
  if (!ENV_NAME_RE.test(name)) return true;
  return name.length <= 2;
}

/**
 * Group keys that share one non-empty value. Returns Map<name, groupId>.
 * Hashing is salted with `salt` (random per run unless injected by a test).
 * Group ids are assigned in sorted-name order so output is deterministic for
 * a given env, and carry no information about the value.
 */
function duplicateGroups(env, names, salt) {
  const s = salt || crypto.randomBytes(32);
  const byHash = new Map();
  for (const name of names) {
    const v = env[name];
    if (typeof v !== 'string' || v.length === 0) continue;
    const h = crypto.createHash('sha256').update(s).update('\0').update(v, 'utf8').digest('hex');
    const list = byHash.get(h) || [];
    list.push(name);
    byHash.set(h, list);
  }
  const groups = [...byHash.values()]
    .filter((l) => l.length > 1)
    .map((l) => l.slice().sort())
    .sort((a, b) => a[0].localeCompare(b[0]));
  const out = new Map();
  groups.forEach((members, i) => {
    for (const m of members) out.set(m, `D${i + 1}`);
  });
  byHash.clear();
  return out;
}

/**
 * Classify an environment. `registered` is the list of registry names.
 * Returns a value-free report object.
 */
function classifyEnv(env, registered, opts) {
  const options = opts || {};
  const reg = new Set(registered);
  const presentNames = Object.keys(env).filter((k) => typeof env[k] === 'string');
  const all = [...new Set([...reg, ...presentNames])].sort();
  const dup = duplicateGroups(env, all, options.salt);
  const rows = all.map((name) => {
    const raw = env[name];
    const present = typeof raw === 'string';
    const value = present ? raw : '';
    return {
      name,
      registered: reg.has(name),
      present,
      empty: present && value.trim().length === 0,
      placeholder: present ? placeholderPattern(value) : null,
      duplicateGroup: dup.get(name) || null,
      lengthBucket: lengthBucket(value.length),
      suspiciousName: suspiciousName(name),
    };
  });
  const count = (f) => rows.filter(f).length;
  const groupIds = new Set(rows.map((r) => r.duplicateGroup).filter(Boolean));
  const shapes = shapeChecks(env);
  return {
    schema: 'env-truth/v1',
    generatedAt: options.now || new Date().toISOString(),
    summary: {
      registered: reg.size,
      present: count((r) => r.present),
      registeredMissing: count((r) => r.registered && !r.present),
      empty: count((r) => r.empty),
      placeholder: count((r) => r.placeholder !== null),
      duplicateGroups: groupIds.size,
      duplicateKeys: count((r) => r.duplicateGroup !== null),
      unregisteredPresent: count((r) => r.present && !r.registered),
      suspiciousNames: count((r) => r.present && r.suspiciousName),
      shapeChecksFailing: shapes.filter((c) => c.result !== 'pass').length,
    },
    shapeChecks: shapes,
    rows,
  };
}

/**
 * Extract ENV_RULES names from the env-validation.ts source text without a
 * TypeScript toolchain (the CI runner step has no npm ci). The jest spec
 * asserts this equals the AST extraction used by the H4 board.
 */
function extractRegisteredNames(source) {
  const start = source.indexOf('export const ENV_RULES');
  if (start < 0) throw new Error('ENV_RULES not found');
  const end = source.indexOf('\n];', start);
  if (end < 0) throw new Error('ENV_RULES array end not found');
  const body = source.slice(start, end);
  const names = new Set();
  const re = /^\s{4}name:\s*'([A-Z][A-Z0-9_]*)',\s*$/gm;
  let m;
  while ((m = re.exec(body)) !== null) names.add(m[1]);
  return [...names].sort();
}

function mdEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

/** Render a value-free markdown summary (job summary / artifact). */
function renderMarkdown(report, app) {
  const s = report.summary;
  const out = [];
  out.push(`# Env truth: ${mdEscape(app || 'fly app')}`);
  out.push('');
  out.push(
    `Generated ${report.generatedAt}. Values never left the machine; this report holds names, flags, pattern ids, opaque duplicate-group ids and length buckets only.`,
  );
  out.push('');
  out.push('| Metric | Count |');
  out.push('|---|---|');
  out.push(`| Registered names | ${s.registered} |`);
  out.push(`| Env vars present | ${s.present} |`);
  out.push(`| Registered but missing | ${s.registeredMissing} |`);
  out.push(`| Empty | ${s.empty} |`);
  out.push(`| Placeholder pattern hit | ${s.placeholder} |`);
  out.push(`| Duplicate groups (keys) | ${s.duplicateGroups} (${s.duplicateKeys}) |`);
  out.push(`| Present but unregistered | ${s.unregisteredPresent} |`);
  out.push(`| Suspicious names | ${s.suspiciousNames} |`);
  out.push(`| Value-shape checks not passing | ${s.shapeChecksFailing} |`);
  out.push('');
  out.push('## Value-shape checks');
  out.push('');
  out.push('| Name | Check | Result |');
  out.push('|---|---|---|');
  for (const c of report.shapeChecks || []) {
    out.push(`| ${mdEscape(c.name)} | ${mdEscape(c.describe)} | ${c.result} |`);
  }
  out.push('');
  const flagged = report.rows.filter(
    (r) => r.present && (r.empty || r.placeholder || r.duplicateGroup || r.suspiciousName),
  );
  out.push('## Flagged (present)');
  out.push('');
  if (flagged.length === 0) out.push('None.');
  else {
    out.push(
      '| Name | Registered | Empty | Placeholder | Duplicate group | Length | Suspicious name |',
    );
    out.push('|---|---|---|---|---|---|---|');
    for (const r of flagged) {
      out.push(
        `| ${mdEscape(r.name)} | ${r.registered ? 'yes' : 'no'} | ${r.empty ? 'yes' : ''} | ${r.placeholder || ''} | ${r.duplicateGroup || ''} | ${r.lengthBucket} | ${r.suspiciousName ? 'yes' : ''} |`,
      );
    }
  }
  out.push('');
  out.push('## Registered but missing');
  out.push('');
  const missing = report.rows.filter((r) => r.registered && !r.present).map((r) => r.name);
  out.push(missing.length ? missing.map((n) => `\`${n}\``).join(', ') : 'None.');
  out.push('');
  out.push('## Present but unregistered');
  out.push('');
  const unreg = report.rows.filter((r) => r.present && !r.registered).map((r) => r.name);
  out.push(unreg.length ? unreg.map((n) => `\`${mdEscape(n)}\``).join(', ') : 'None.');
  out.push('');
  return out.join('\n');
}

/** Env var that carries the registered names (base64 JSON) into the machine. */
const NAMES_ENV = 'ENV_TRUTH_NAMES_B64';

/**
 * Build the self-contained JS program that runs inside the machine: this
 * module's source followed by a FIXED call to runRemote. No data is spliced
 * into the program text; the registered names travel separately in the
 * ENV_TRUTH_NAMES_B64 env var (see buildRemoteCommand).
 */
function buildRemoteProgram(moduleSource) {
  return `${moduleSource}\n;module.exports.runRemote(module.exports.namesFromEnv(process.env));\n`;
}

/** Base64 JSON of the registered names, for the ENV_TRUTH_NAMES_B64 env var. */
function encodeNames(names) {
  return Buffer.from(JSON.stringify([...names]), 'utf8').toString('base64');
}

/** Decode the registered names from ENV_TRUTH_NAMES_B64 (strict: array of env-name strings). */
function namesFromEnv(env) {
  const raw = env[NAMES_ENV];
  if (typeof raw !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(raw)) {
    throw new Error(`${NAMES_ENV} missing or not base64`);
  }
  const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  if (
    !Array.isArray(parsed) ||
    !parsed.every((n) => typeof n === 'string' && ENV_NAME_RE.test(n))
  ) {
    throw new Error(`${NAMES_ENV} is not a list of env names`);
  }
  return parsed;
}

/**
 * The `flyctl ssh console -C` command: `env ENV_TRUTH_NAMES_B64=<b64> node -e
 * "eval(<base64 program>)"`. Both payloads are base64 ([A-Za-z0-9+/=] only), so
 * the command needs no shell escaping; the program text itself is constant.
 */
function buildRemoteCommand(moduleSource, names) {
  const prog = Buffer.from(buildRemoteProgram(moduleSource), 'utf8').toString('base64');
  const namesB64 = encodeNames(names);
  if (!/^[A-Za-z0-9+/=]+$/.test(prog) || !/^[A-Za-z0-9+/=]+$/.test(namesB64)) {
    throw new Error('payload is not base64');
  }
  return `env ${NAMES_ENV}=${namesB64} node -e "eval(Buffer.from('${prog}','base64').toString('utf8'))"`;
}

/** Entry point inside the machine: classify process.env and print one marked line. */
function runRemote(names) {
  const env = { ...process.env };
  delete env[NAMES_ENV];
  const report = classifyEnv(env, names);
  process.stdout.write(`${REPORT_MARKER}${JSON.stringify(report)}\n`);
}

/** Pull the report JSON out of captured ssh output. */
function parseRemoteOutput(text) {
  const line = String(text)
    .split(/\r?\n/)
    .find((l) => l.startsWith(REPORT_MARKER));
  if (!line) throw new Error('env-truth report marker not found in remote output');
  const report = JSON.parse(line.slice(REPORT_MARKER.length));
  if (report.schema !== 'env-truth/v1') throw new Error('unexpected env-truth report schema');
  return report;
}

module.exports = {
  ENV_NAME_RE,
  REPORT_MARKER,
  PLACEHOLDER_PATTERNS,
  IOS_BUNDLE_ID,
  SHAPE_CHECKS,
  shapeChecks,
  placeholderPattern,
  lengthBucket,
  suspiciousName,
  duplicateGroups,
  classifyEnv,
  extractRegisteredNames,
  renderMarkdown,
  NAMES_ENV,
  buildRemoteProgram,
  buildRemoteCommand,
  encodeNames,
  namesFromEnv,
  runRemote,
  parseRemoteOutput,
};

/*
 * CLI (CI runner side; never handles values):
 *   node fly-env-classifier.js names <env-validation.ts>          -> JSON array of names
 *   node fly-env-classifier.js command <env-validation.ts>        -> the ssh -C command
 *   node fly-env-classifier.js parse <ssh-output.txt> <out.json>  -> value-free report JSON
 *   node fly-env-classifier.js render <report.json> <app>         -> markdown on stdout
 */
if (typeof require !== 'undefined' && require.main === module && process.argv.length > 2) {
  const fs = require('fs');
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'names') {
    process.stdout.write(`${JSON.stringify(extractRegisteredNames(fs.readFileSync(a, 'utf8')))}\n`);
  } else if (cmd === 'command') {
    const names = extractRegisteredNames(fs.readFileSync(a, 'utf8'));
    process.stdout.write(buildRemoteCommand(fs.readFileSync(__filename, 'utf8'), names));
  } else if (cmd === 'parse') {
    const report = parseRemoteOutput(fs.readFileSync(a, 'utf8'));
    fs.writeFileSync(b, `${JSON.stringify(report, null, 2)}\n`);
  } else if (cmd === 'render') {
    const report = JSON.parse(fs.readFileSync(a, 'utf8'));
    process.stdout.write(renderMarkdown(report, b));
  } else {
    process.stderr.write(`unknown command: ${cmd}\n`);
    process.exit(2);
  }
}
