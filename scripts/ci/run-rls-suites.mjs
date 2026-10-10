#!/usr/bin/env node
// scripts/ci/run-rls-suites.mjs
//
// D5 (REL-01): the rls-live-tests job runs EVERY RLS suite, not a hand-picked
// few. Suites = every test/**/*.spec.ts with an `rls` directory, an `rls-`
// prefix or `.rls.` in its path: test/rls/**, test/rls-*.spec.ts (the
// jest.rls.config.js globs) and the RLS suites elsewhere under test/ (run with
// jest.config.js), minus suites another ci.yml job already runs (reported as
// ELSEWHERE). Each suite gets its own fresh database, copied from a
// template the job built beforehand:
//   rls_replay  the whole migration chain replayed from empty on the Supabase
//               shim (the default: suites assert against real migration output)
//   rls_scoped  the older scoped bootstrap some suites were written against
//   rls_empty   the shim plus an empty `app` schema the API roles may use, for
//               suites that build their own schema
// Each suite runs with CI=true and TEST_DATABASE_URL pointing at its copy.
// Verdicts:
//   PASS           every test ran and passed (no failed, skipped or todo tests)
//   FAIL           a suite on neither list did not PASS, or an operator-only
//                  suite was not refused at import with zero tests run
//   PENDING        a listed pending suite still does not pass (reason printed)
//   OPERATOR-ONLY  an operatorOnly suite refused at import, as required
//   STALE          a pending suite now passes, or a listed file is gone
// The job fails on any FAIL or STALE. Usage: node scripts/ci/run-rls-suites.mjs [paths...]
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertLocalDbUrl, cleanEnv } from './local-db-url.mjs';
import { suiteIdentities } from './rls-lists.mjs';

const ADMIN_URL = process.env.RLS_ADMIN_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/postgres';
const PENDING_FILE = 'scripts/ci/rls-suites-pending.json';
const OUT_DIR = process.env.RLS_SUITE_REPORT_DIR || '/tmp/rls-suites';
const RLS_PATH = /(^|\/)rls(\/|-)|\.rls\./;
const REFUSAL = /proof requires (an )?explicit/;

// How each suite's database is set up. A suite not listed gets a superuser
// connection to a copy of rls_replay, so new suites assert against the real
// chain by default. owner: connect as the non-superuser, NOINHERIT owner of
// the copy, so FORCE ROW LEVEL SECURITY binds the suite's own connection (a
// superuser bypasses RLS even when forced); 'member' may SET ROLE anon/
// authenticated/service_role like Supabase's postgres role, 'plain' may not.
// env: extra variables the suite reads (RLS_AUTHED_ROLE: the request role).
const SCOPED = { db: 'rls_scoped' };
const SELF = { db: 'rls_empty', env: { RLS_AUTHED_ROLE: 'authenticated' } };
const EMPTY = { db: 'rls_empty' };
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
  ...Object.fromEntries(['rls/community-classroom-rls', 'rls/community-coach-rls', 'rls/community-voice-rls',
    'community/rls/community-rls', 'community/rls/community-v1-emoji-roundtrip',
    'scout/entities/scout-entities.rls.live'].map((n) => [`test/${n}.spec.ts`, EMPTY])),
};
const OWNERS = { plain: 'rls_suite_owner', member: 'rls_suite_member' };

function die(msg) {
  console.error(`[rls-suites] ${msg}`);
  process.exit(1);
}
try {
  assertLocalDbUrl(ADMIN_URL, 'RLS_ADMIN_DATABASE_URL');
} catch (e) {
  die(e.message);
}
const childEnv = cleanEnv();

// Jobs other than rls-live-tests in ci.yml, with comments dropped, so a suite
// outside the two jest.rls.config.js globs that one of them runs
// (community-live-tests) is not run twice. Suites in the globs always run here.
const IN_GLOBS = /^test\/rls(\/|-)/;
const otherJobs = readFileSync('.github/workflows/ci.yml', 'utf8').split(/^jobs:/m)[1].split(/^ {2}(?=[\w-]+:\s*$)/m).slice(1)
  .filter((j) => !j.startsWith('rls-live-tests:')).map((j) => j.replace(/^\s*#.*$/gm, ''));
function listSuites() {
  const found = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.spec.ts') && RLS_PATH.test(p.slice('test/'.length))) found.push(p);
    }
  };
  walk('test');
  return found.sort();
}

const lists = new Map();
try {
  for (const { section, entry } of suiteIdentities(JSON.parse(readFileSync(PENDING_FILE, 'utf8')), PENDING_FILE).values()) {
    lists.set(entry.path, { section, reason: entry.reason });
  }
} catch (e) {
  die(e.message);
}
const pending = new Map([...lists].filter(([, v]) => v.section === 'suites').map(([k, v]) => [k, v.reason]));
const operatorOnly = new Map([...lists].filter(([, v]) => v.section === 'operatorOnly').map(([k, v]) => [k, v.reason]));

const discovered = listSuites();
const elsewhere = discovered.filter((s) => !IN_GLOBS.test(s) && otherJobs.some((j) => j.includes(s)));
const all = discovered.filter((s) => !elsewhere.includes(s));
const only = process.argv.slice(2);
const suites = only.length ? all.filter((s) => only.includes(s)) : all;
const psql = (...args) => execFileSync('psql', [ADMIN_URL, '-XAtq', '-v', 'ON_ERROR_STOP=1', ...args.flatMap((c) => ['-c', c])], { encoding: 'utf8', env: childEnv });
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
      `ALTER SCHEMA public OWNER TO ${owner}; ALTER SCHEMA app OWNER TO ${owner}`], { env: childEnv });
  }
  url.search = 'connection_limit=1';
  if (owner) {
    url.username = owner;
    url.password = owner;
  }
  const report = join(OUT_DIR, `${db}.json`);
  console.log(`::group::${suite} (copy of ${template})`);
  const started = Date.now();
  const config = IN_GLOBS.test(suite) ? 'jest.rls.config.js' : 'jest.config.js';
  const run = spawnSync('npx', ['jest', '--config', config, suite, '--runInBand', '--testTimeout=60000',
    '--json', `--outputFile=${report}`], {
    stdio: 'inherit',
    env: { ...childEnv, ...setup.env, CI: 'true', TEST_DATABASE_URL: url.toString(), NODE_OPTIONS: '--max-old-space-size=4096' },
  });
  console.log('::endgroup::');
  let r = null;
  try { r = JSON.parse(readFileSync(report, 'utf8')); } catch { /* jest crashed before writing a report */ }
  const n = r ? { passed: r.numPassedTests, failed: r.numFailedTests, skipped: r.numPendingTests + r.numTodoTests, broken: r.numRuntimeErrorTestSuites, total: r.numTotalTests } : null;
  const refused = !!n && n.total === 0 && n.broken > 0 && r.testResults.some((t) => REFUSAL.test(t.message || ''));
  const outcome = !n ? 'crashed'
    : refused ? 'refused at import'
      : n.broken || n.failed ? 'failed'
        : n.skipped ? 'skipped'
          : run.status === 0 && n.passed > 0 ? 'passed' : 'failed';
  const verdict = operatorOnly.has(suite) ? (refused ? 'OPERATOR-ONLY' : 'FAIL')
    : outcome === 'passed' ? (pending.has(suite) ? 'STALE' : 'PASS') : (pending.has(suite) ? 'PENDING' : 'FAIL');
  results.push({ suite, template, verdict, outcome, n, secs: Math.round((Date.now() - started) / 1000) });
  psql(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
});
if (!only.length) {
  for (const path of lists.keys()) if (!all.includes(path)) results.push({ suite: path, template: '-', verdict: 'STALE', outcome: 'file not found', n: null, secs: 0 });
}

const tests = (n) => (n ? `${n.passed}/${n.failed}/${n.skipped}` : '-');
const pad = (s, k) => String(s).padEnd(k);
const lines = [`${pad('verdict', 8)} ${pad('suite', 58)} ${pad('database', 11)} ${pad('pass/fail/skip', 15)} ${pad('secs', 5)} note`];
for (const x of results) {
  const note = x.verdict === 'PENDING' ? pending.get(x.suite) : x.verdict === 'OPERATOR-ONLY' ? 'refused at import, 0 tests run'
    : x.verdict === 'STALE' ? `listed but ${x.outcome}; remove it from ${PENDING_FILE}`
      : x.verdict === 'FAIL' ? (operatorOnly.has(x.suite) ? `operator-only suite was not refused at import (${x.outcome})` : x.outcome) : '';
  lines.push(`${pad(x.verdict, 8)} ${pad(x.suite, 58)} ${pad(x.template, 11)} ${pad(tests(x.n), 15)} ${pad(x.secs, 5)} ${note}`);
  x.note = note;
}
const tally = (v) => results.filter((x) => x.verdict === v).length;
const head = `RLS suites: ${results.length} run; PASS ${tally('PASS')}, PENDING ${tally('PENDING')}, OPERATOR-ONLY ${tally('OPERATOR-ONLY')}, FAIL ${tally('FAIL')}, STALE ${tally('STALE')} (lists: ${pending.size} pending, ${operatorOnly.size} operator-only)`;
const away = `ELSEWHERE (run by another ci.yml job, not here): ${elsewhere.length ? elsewhere.join(', ') : 'none'}`;
console.log([head, away, '', ...lines].join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) {
  const md = [`## ${head}`, '', away, '', '| verdict | suite | database | pass/fail/skip | note |', '|---|---|---|---|---|',
    ...results.map((x) => `| ${x.verdict} | \`${x.suite}\` | ${x.template} | ${tests(x.n)} | ${String(x.note).replace(/\\/g, '\\\\').replace(/\|/g, '\\|')} |`), ''];
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n'));
}
if (tally('FAIL') || tally('STALE')) die(`${tally('FAIL')} failing and ${tally('STALE')} stale suite(s).`);
console.log('[rls-suites] OK');
