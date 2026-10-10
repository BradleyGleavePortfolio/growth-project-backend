#!/usr/bin/env node
// scripts/ci/run-rls-suites.mjs
//
// D5 (REL-01): the rls-live-tests job runs EVERY RLS suite, not a hand-picked
// few. Suites = test/rls/**/*.spec.ts + test/rls-*.spec.ts (the same globs as
// jest.rls.config.js). Each suite gets its own fresh database, copied from a
// template the job built beforehand:
//   rls_replay  the whole migration chain replayed from empty on the Supabase
//               shim (the default: suites assert against real migration output)
//   rls_scoped  the older scoped bootstrap some suites were written against
//   rls_empty   the shim plus an empty `app` schema the API roles may use, for
//               suites that build their own schema
// Each suite runs with CI=true and TEST_DATABASE_URL pointing at its copy.
// Verdicts:
//   PASS     every test ran and passed (no failed, skipped or todo tests)
//   FAIL     a suite NOT in rls-suites-pending.json did not PASS
//   PENDING  a listed suite still does not pass (allowed, reason is printed)
//   STALE    a listed suite now passes, or its file is gone: delete the entry
// The job fails on any FAIL or STALE. Usage: node scripts/ci/run-rls-suites.mjs [paths...]
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ADMIN_URL = process.env.RLS_ADMIN_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/postgres';
const PENDING_FILE = 'scripts/ci/rls-suites-pending.json';
const OUT_DIR = process.env.RLS_SUITE_REPORT_DIR || '/tmp/rls-suites';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'postgres']);

// How each suite's database is set up. A suite not listed gets a superuser
// connection to a copy of rls_replay, so new suites assert against the real
// chain by default. owner: connect as the non-superuser, NOINHERIT owner of
// the copy, so FORCE ROW LEVEL SECURITY binds the suite's own connection (a
// superuser bypasses RLS even when forced); 'member' may SET ROLE anon/
// authenticated/service_role like Supabase's postgres role, 'plain' may not.
// env: extra variables the suite reads (RLS_AUTHED_ROLE: the request role).
const SCOPED = { db: 'rls_scoped' };
const SELF = { db: 'rls_empty', env: { RLS_AUTHED_ROLE: 'authenticated' } };
const SETUP = JSON.parse(process.env.RLS_SUITE_SETUP_OVERRIDE || 'null') || {
  ...Object.fromEntries(['ai-processing-consent-ledger-rls', 'clinic-engagement-rls', 'coachless-rls',
    'cwa-coach-manage-client-tenancy-rls', 'data-export-storage-bucket-rls', 'food-item-custom-privacy-rls',
    'helper-functions', 'onboarding-intake-rls'].map((n) => [`test/rls/${n}.spec.ts`, SCOPED])),
  ...Object.fromEntries(['rls/roman-rls', 'rls-b5-contracts-policies', 'rls-helper-search-path',
    'rls-mwb1-workout-builder-policies', 'rls-mwb2-clone-concurrency', 'rls-mwb3-autosave-undo',
    'rls-mwb5-ai-gateway-drafts', 'rls-tier2-policies', 'rls-tier2-sessions-policies',
    'rls-tier3-nutrition-policies', 'rls-tier3-workouts-policies'].map((n) => [`test/${n}.spec.ts`, SELF])),
  'test/rls-tier1-policies.spec.ts': { ...SELF, owner: 'member' },
  'test/rls-tier5-policies.spec.ts': { ...SELF, owner: 'member' },
  'test/rls-tier4-learning-analytics-policies.spec.ts': { ...SELF, owner: 'plain' },
};
const OWNERS = { plain: 'rls_suite_owner', member: 'rls_suite_member' };

function die(msg) {
  console.error(`[rls-suites] ${msg}`);
  process.exit(1);
}
if (!LOCAL_HOSTS.has(new URL(ADMIN_URL).hostname)) die('refusing a non-local database host.');

function listSuites() {
  const found = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.spec.ts')) found.push(p);
    }
  };
  walk('test/rls');
  for (const f of readdirSync('test')) if (/^rls-.*\.spec\.ts$/.test(f)) found.push(`test/${f}`);
  return found.sort();
}

const pendingDoc = JSON.parse(readFileSync(PENDING_FILE, 'utf8'));
const pending = new Map();
for (const p of pendingDoc.suites || []) {
  if (!p.path || !p.reason) die(`${PENDING_FILE}: every entry needs path and reason: ${JSON.stringify(p)}`);
  if (pending.has(p.path)) die(`${PENDING_FILE}: duplicate entry ${p.path}`);
  pending.set(p.path, p.reason);
}

const all = listSuites();
const only = process.argv.slice(2);
const suites = only.length ? all.filter((s) => only.includes(s)) : all;
const psql = (...args) => execFileSync('psql', [ADMIN_URL, '-XAtq', '-v', 'ON_ERROR_STOP=1', ...args.flatMap((c) => ['-c', c])], { encoding: 'utf8' });
mkdirSync(OUT_DIR, { recursive: true });

// Login roles for owner-mode suites: no superuser, no BYPASSRLS.
for (const role of Object.values(OWNERS)) {
  psql(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
    CREATE ROLE ${role} LOGIN NOINHERIT PASSWORD '${role}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; END IF; END $$`);
}
psql(`GRANT anon, authenticated, service_role TO ${OWNERS.member}`);
// app_authenticated: the RLS-bound request role some suites grant to; created
// exactly as the mwb-3-live-tests job does (NOLOGIN NOINHERIT NOBYPASSRLS).
psql(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_authenticated') THEN
  CREATE ROLE app_authenticated NOLOGIN NOINHERIT NOBYPASSRLS; END IF; END $$`);
const results = [];
suites.forEach((suite, i) => {
  const setup = SETUP[suite] || SETUP['*'] || {};
  const template = setup.db || 'rls_replay';
  const db = `rls_suite_${String(i + 1).padStart(2, '0')}`;
  const owner = setup.owner ? OWNERS[setup.owner] : null;
  if (setup.owner && !owner) die(`unknown owner mode ${setup.owner} for ${suite}`);
  psql(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`,
    `CREATE DATABASE ${db} TEMPLATE ${template}${owner ? ` OWNER ${owner}` : ''}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${db}`;
  if (owner) {
    // NOINHERIT roles do not use pg_database_owner's rights, so hand over the schemas directly.
    execFileSync('psql', [url.toString(), '-XAtq', '-v', 'ON_ERROR_STOP=1', '-c',
      `ALTER SCHEMA public OWNER TO ${owner}; ALTER SCHEMA app OWNER TO ${owner}`]);
  }
  url.search = 'connection_limit=1';
  if (owner) {
    url.username = owner;
    url.password = owner;
  }
  const report = join(OUT_DIR, `${db}.json`);
  console.log(`::group::${suite} (copy of ${template})`);
  const started = Date.now();
  const run = spawnSync('npx', ['jest', '--config', 'jest.rls.config.js', suite, '--runInBand', '--testTimeout=60000',
    '--json', `--outputFile=${report}`], {
    stdio: 'inherit',
    env: { ...process.env, ...setup.env, CI: 'true', TEST_DATABASE_URL: url.toString(), NODE_OPTIONS: '--max-old-space-size=4096' },
  });
  console.log('::endgroup::');
  let r = null;
  try { r = JSON.parse(readFileSync(report, 'utf8')); } catch { /* jest crashed before writing a report */ }
  const n = r ? { passed: r.numPassedTests, failed: r.numFailedTests, skipped: r.numPendingTests + r.numTodoTests, broken: r.numRuntimeErrorTestSuites } : null;
  const outcome = !n ? 'crashed'
    : n.broken || n.failed ? 'failed'
      : n.skipped ? 'skipped'
        : run.status === 0 && n.passed > 0 ? 'passed' : 'failed';
  const isPending = pending.has(suite);
  const verdict = outcome === 'passed' ? (isPending ? 'STALE' : 'PASS') : (isPending ? 'PENDING' : 'FAIL');
  results.push({ suite, template, verdict, outcome, n, secs: Math.round((Date.now() - started) / 1000) });
  psql(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
});
if (!only.length) {
  for (const [path] of pending) if (!all.includes(path)) results.push({ suite: path, template: '-', verdict: 'STALE', outcome: 'file not found', n: null, secs: 0 });
}

const tests = (n) => (n ? `${n.passed}/${n.failed}/${n.skipped}` : '-');
const pad = (s, k) => String(s).padEnd(k);
const lines = [`${pad('verdict', 8)} ${pad('suite', 58)} ${pad('database', 11)} ${pad('pass/fail/skip', 15)} ${pad('secs', 5)} note`];
for (const x of results) {
  const note = x.verdict === 'PENDING' ? pending.get(x.suite) : x.verdict === 'STALE' ? `listed as pending but ${x.outcome}; remove it from ${PENDING_FILE}` : x.verdict === 'FAIL' ? x.outcome : '';
  lines.push(`${pad(x.verdict, 8)} ${pad(x.suite, 58)} ${pad(x.template, 11)} ${pad(tests(x.n), 15)} ${pad(x.secs, 5)} ${note}`);
  x.note = note;
}
const tally = (v) => results.filter((x) => x.verdict === v).length;
const head = `RLS suites: ${results.length} run; PASS ${tally('PASS')}, PENDING ${tally('PENDING')}, FAIL ${tally('FAIL')}, STALE ${tally('STALE')} (pending list: ${pending.size})`;
console.log([head, '', ...lines].join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) {
  const md = [`## ${head}`, '', '| verdict | suite | database | pass/fail/skip | note |', '|---|---|---|---|---|',
    ...results.map((x) => `| ${x.verdict} | \`${x.suite}\` | ${x.template} | ${tests(x.n)} | ${String(x.note).replace(/\|/g, '\\|')} |`), ''];
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n'));
}
if (tally('FAIL') || tally('STALE')) die(`${tally('FAIL')} failing and ${tally('STALE')} stale suite(s).`);
console.log('[rls-suites] OK');
