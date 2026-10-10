#!/usr/bin/env node
// scripts/ci/rls-floor-selftest.mjs
//
// D5: proof that every rls-floor-guard rule bites. Copies the replayed
// database to a scratch database, applies one negative fixture per rule, runs
// assert-rls-floor.mjs on the copy and fails unless that run fails AND reports
// every expected row. Then proves scripts/ci/rls-lists.mjs rejects an added or
// widened list entry. The fixtures exist only in the scratch copy; nothing
// here is a migration. CI only: local hosts.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertLocalDbUrl, cleanEnv } from './local-db-url.mjs';

const ADMIN = process.env.RLS_ADMIN_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/postgres';
const TEMPLATE = process.env.RLS_SELFTEST_TEMPLATE || 'rls_replay';
const SCRATCH = 'rls_floor_selftest';
const OUT = join(mkdtempSync(join(tmpdir(), 'rls-floor-selftest-')), 'out');
assertLocalDbUrl(ADMIN, 'RLS_ADMIN_DATABASE_URL');
const env = cleanEnv();
const psql = (url, ...args) => execFileSync('psql', [url, '-XAtq', '-v', 'ON_ERROR_STOP=1', ...args], { encoding: 'utf8', env });
const scratch = new URL(ADMIN);
scratch.pathname = `/${SCRATCH}`;

// [fixture, SQL applied to the copy, check, expected row object, expected result]
const FLOOR = [
  ['table with RLS off', 'CREATE TABLE public.d5_fx_open (id int)', 'a', 'public.d5_fx_open :: RLS off', 'FAIL'],
  ['RLS disabled on a FORCE-only entry', 'ALTER TABLE public."Invoice" DISABLE ROW LEVEL SECURITY', 'a', 'public.Invoice :: RLS off', 'FAIL'],
  ['repaired flag on a listed entry', 'ALTER TABLE public."ConnectAccount" FORCE ROW LEVEL SECURITY', 'a', 'public.ConnectAccount :: FORCE off', 'STALE ENTRY'],
  ['private-schema table exposed through a public security_invoker view',
    `CREATE SCHEMA d5_fx_hidden; CREATE TABLE d5_fx_hidden.leak (id text); GRANT SELECT ON d5_fx_hidden.leak TO anon;
     CREATE VIEW public.d5_fx_leak WITH (security_invoker = true) AS SELECT * FROM d5_fx_hidden.leak;
     GRANT SELECT ON public.d5_fx_leak TO anon`, 'a', 'd5_fx_hidden.leak :: RLS off', 'FAIL'],
  ['public view without security_invoker selectable by anon',
    'CREATE VIEW public.d5_fx_owner_view AS SELECT 1 AS x; GRANT SELECT ON public.d5_fx_owner_view TO anon', 'b', 'public.d5_fx_owner_view', 'FAIL'],
  ['open-write policy on a reference table',
    'CREATE POLICY d5_fx_open_write ON public."BuildWeekDay" FOR ALL TO authenticated USING (true) WITH CHECK (true)',
    'c', 'public.BuildWeekDay / d5_fx_open_write :: ALL to authenticated', 'FAIL'],
  ['IS NOT DISTINCT FROM policy',
    // (IS NOT DISTINCT FROM NULL would be parsed into IS NULL, so compare with a value)
    `CREATE POLICY d5_fx_null_match ON public.d5_fx_open FOR SELECT TO authenticated
       USING (id IS NOT DISTINCT FROM nullif(current_setting('app.d5_fx', true), '')::int)`,
    'd', 'public.d5_fx_open / d5_fx_null_match', 'FAIL'],
  ['SECURITY DEFINER without search_path in a non-API schema',
    `CREATE SCHEMA d5_fx_private; CREATE FUNCTION d5_fx_private.leaky_definer() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`,
    'e', 'd5_fx_private.leaky_definer()', 'FAIL'],
];

const results = [];
psql(ADMIN, '-c', `DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`, '-c', `CREATE DATABASE ${SCRATCH} TEMPLATE ${TEMPLATE}`);
try {
  psql(scratch.toString(), ...FLOOR.flatMap(([, sql]) => ['-c', sql]));
  const run = spawnSync('node', ['scripts/ci/assert-rls-floor.mjs'], {
    encoding: 'utf8',
    env: { ...env, RLS_FLOOR_DATABASE_URL: scratch.toString(), RLS_FLOOR_REPORT_JSON: `${OUT}-rows.json`, GITHUB_STEP_SUMMARY: '' },
  });
  writeFileSync(`${OUT}-floor.log`, `${run.stdout}\n${run.stderr}`);
  let rows = [];
  try { rows = JSON.parse(readFileSync(`${OUT}-rows.json`, 'utf8')); } catch { /* no report: nothing caught */ }
  for (const [name, , check, object, result] of FLOOR) {
    const hit = run.status === 1 && rows.some((r) => r.check === check && r.object === object && r.result === result);
    results.push({ name, expect: `${check}: ${result} ${object}`, caught: hit });
  }
} finally {
  psql(ADMIN, '-c', `DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
}

// Removal-only: compare an edited copy of each list with the committed list as the base.
const gaps = JSON.parse(readFileSync('scripts/ci/rls-known-gaps.json', 'utf8'));
const suites = JSON.parse(readFileSync('scripts/ci/rls-suites-pending.json', 'utf8'));
const LISTS = [
  ['added known-gap entry', 'gaps', { ...gaps, tables: [...gaps.tables, { table: 'public.d5_fx_open', rlsOff: true, forceOff: true, finding: 'D5-SELFTEST', reason: 'fixture' }] }, 'public.d5_fx_open :: RLS off'],
  ['widened known-gap entry (FORCE-only entry also allows RLS off)', 'gaps',
    { ...gaps, tables: gaps.tables.map((t) => (t.table === 'public.Invoice' ? { ...t, rlsOff: true } : t)) }, 'public.Invoice :: RLS off'],
  ['added pending suite', 'suites', { ...suites, suites: [...(suites.suites || []), { path: 'test/rls/d5-fixture.spec.ts', reason: 'fixture' }] }, 'pending :: test/rls/d5-fixture.spec.ts'],
];
for (const [name, kind, doc, id] of LISTS) {
  const file = `${OUT}-${kind}.json`;
  writeFileSync(file, JSON.stringify(doc));
  const base = kind === 'gaps' ? 'scripts/ci/rls-known-gaps.json' : 'scripts/ci/rls-suites-pending.json';
  const run = spawnSync('node', ['scripts/ci/rls-lists.mjs', kind, file], { encoding: 'utf8', env: { ...env, RLS_LISTS_BASE_FILE: base } });
  results.push({ name, expect: `removal-only: ADDED ${id}`, caught: run.status === 1 && run.stdout.includes(`ADDED    ${id}`) });
}

const missed = results.filter((r) => !r.caught);
const pad = (s, n) => String(s).padEnd(n);
console.log([`RLS floor self-test: ${results.length - missed.length} of ${results.length} fixtures caught`, '',
  `${pad('caught', 7)} ${pad('fixture', 66)} expected`, ...results.map((r) => `${pad(r.caught ? 'yes' : 'NO', 7)} ${pad(r.name, 66)} ${r.expect}`)].join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, [`## RLS floor self-test: ${results.length - missed.length} of ${results.length} fixtures caught`, '',
    '| caught | fixture | expected |', '|---|---|---|', ...results.map((r) => `| ${r.caught ? 'yes' : 'NO'} | ${r.name} | \`${r.expect}\` |`), ''].join('\n'));
}
if (missed.length) {
  console.error(`[rls-floor-selftest] ${missed.length} fixture(s) NOT caught; the floor log is in ${OUT}-floor.log`);
  process.exit(1);
}
console.log('[rls-floor-selftest] OK: every rule fails when it should.');
