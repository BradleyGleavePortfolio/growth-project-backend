#!/usr/bin/env node
// scripts/ci/rls-floor-selftest.mjs
//
// D5: proof that every rls-floor-guard rule bites. Copies the replayed
// database to a scratch database, applies one negative fixture per rule, runs
// assert-rls-floor.mjs on the copy and fails unless that run fails AND reports
// every expected row. Then proves scripts/ci/rls-lists.mjs rejects an added or
// widened list entry. A control runs the check-f grant query inside a
// transaction that re-grants TRUNCATE and rolls back: it must see the grant
// and then the unchanged floor. The fixtures exist only in the scratch copy; nothing
// here is a migration. CI only: local hosts.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertLocalDbUrl, cleanEnv } from './local-db-url.mjs';
import { GRANT_FLOOR_SQL } from './rls-grant-floor.mjs';

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
  ['RLS disabled on a FORCE-only entry', 'ALTER TABLE public._prisma_migrations DISABLE ROW LEVEL SECURITY', 'a', 'public._prisma_migrations :: RLS off', 'FAIL'],
  ['repaired flag on a listed entry', 'ALTER TABLE public._prisma_migrations FORCE ROW LEVEL SECURITY', 'a', 'public._prisma_migrations :: FORCE off', 'STALE ENTRY'],
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
  ['TRUNCATE re-granted to anon', 'GRANT TRUNCATE ON public."BuildWeekDay" TO anon', 'f', 'public.BuildWeekDay :: anon TRUNCATE', 'FAIL'],
  ['REFERENCES re-granted to authenticated on one column', 'GRANT REFERENCES (id) ON public."BuildWeekDay" TO authenticated',
    'f', 'public.BuildWeekDay :: authenticated REFERENCES', 'FAIL'],
  ['TRIGGER granted to PUBLIC (reaches authenticated)', 'GRANT TRIGGER ON public."BuildWeekDay" TO PUBLIC',
    'f', 'public.BuildWeekDay :: authenticated TRIGGER', 'FAIL'],
  ['anon write re-granted without an anonWrites entry', 'GRANT INSERT ON public."BuildWeekDay" TO anon', 'f', 'public.BuildWeekDay :: anon INSERT', 'FAIL'],
  ['new tables get TRUNCATE again (default privileges)',
    'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT TRUNCATE ON TABLES TO authenticated',
    'f', 'default privileges of postgres for new tables in public :: authenticated TRUNCATE', 'FAIL'],
];

const results = [];
psql(ADMIN, '-c', `DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`, '-c', `CREATE DATABASE ${SCRATCH} TEMPLATE ${TEMPLATE}`);
try {
  // Control: the check-f query sees a TRUNCATE re-granted inside a transaction
  // (same session), and after the ROLLBACK the grants are exactly as before.
  const floorNow = ['-c', `SELECT (${GRANT_FLOOR_SQL})::jsonb`];
  const [before, during, after] = psql(scratch.toString(), ...floorNow, '-c', 'BEGIN',
    '-c', 'GRANT TRUNCATE ON public."BuildWeekDay" TO anon', ...floorNow, '-c', 'ROLLBACK', ...floorNow).trim().split('\n');
  const hasTruncate = (j) => JSON.parse(j).some((f) => f.object === 'public.BuildWeekDay' && f.role === 'anon' && f.priv === 'TRUNCATE');
  results.push({ name: 'TRUNCATE re-granted in a transaction that rolls back', expect: 'f: seen inside, gone after ROLLBACK',
    caught: !hasTruncate(before) && hasTruncate(during) && after === before });
  // Round trip: down.sql brings back the old grants, migration.sql removes them
  // again, and a second down.sql restores the identical set (every table,
  // column and default-privilege grant, with grantor and grant option).
  const acls = ['-c', String.raw`SELECT count(*) || ' ' || md5(coalesce(string_agg(x, ',' ORDER BY x), '')) FROM (
    SELECT c.oid::regclass::text || ':' || a.grantor::regrole || ':' || a.grantee || ':' || a.privilege_type || ':' || a.is_grantable
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    CROSS JOIN LATERAL aclexplode(c.relacl) a
    UNION ALL
    SELECT c.oid::regclass::text || '.' || quote_ident(att.attname) || ':' || a.grantor::regrole || ':' || a.grantee
           || ':' || a.privilege_type || ':' || a.is_grantable
    FROM pg_attribute att JOIN pg_class c ON c.oid = att.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    CROSS JOIN LATERAL aclexplode(att.attacl) a
    UNION ALL
    SELECT 'default ' || d.defaclrole::regrole || ' ' || d.defaclnamespace::regnamespace || ' ' || d.defaclobjtype::text || ':' || a.grantor::regrole
           || ':' || a.grantee || ':' || a.privilege_type || ':' || a.is_grantable
    FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a) s(x)`];
  const MIG = 'prisma/migrations/20270502001000_public_role_grant_floor';
  const step = (file) => psql(scratch.toString(), '-f', `${MIG}/${file}`, ...acls, ...floorNow).trim().split('\n').slice(-2);
  const [floorAcl] = psql(scratch.toString(), ...acls).trim().split('\n');
  // Behaviour: TRUNCATE (which row rules never stop) as each API role, rolled back.
  const truncateAs = (role) => spawnSync('psql', [scratch.toString(), '-XAtq', '-v', 'ON_ERROR_STOP=1', '-c', 'BEGIN',
    '-c', `SET LOCAL ROLE ${role}`, '-c', 'TRUNCATE public._prisma_migrations', '-c', 'ROLLBACK'], { encoding: 'utf8', env });
  const ROLES = ['anon', 'authenticated'];
  const [oldAcl, oldF] = step('down.sql');
  const oldHeld = ROLES.filter((r) => JSON.parse(oldF).some((f) => f.object === 'public._prisma_migrations' && f.role === r && f.priv === 'TRUNCATE'));
  const oldTruncated = ROLES.filter((r) => truncateAs(r).status === 0);
  const [upAcl, upF] = step('migration.sql');
  const upRefused = ROLES.filter((r) => /permission denied for table _prisma_migrations/.test(truncateAs(r).stderr));
  results.push({ name: 'TRUNCATE as anon/authenticated: works with the old grants, refused at the floor (rolled back)',
    expect: `before: ${oldHeld.join('+') || 'none'} truncate; after: both refused`,
    caught: oldHeld.length > 0 && oldTruncated.join() === oldHeld.join() && upRefused.join() === ROLES.join() });
  const [againAcl] = step('down.sql');
  step('migration.sql');
  console.log(`[rls-floor-selftest] public grants (count md5): floor ${floorAcl} | down ${oldAcl} | up ${upAcl} | down again ${againAcl}`);
  results.push({ name: 'down.sql restores the old grants exactly; migration.sql removes them again', expect: 'f: down = down, up = floor',
    caught: oldAcl === againAcl && oldAcl !== floorAcl && upAcl === floorAcl && JSON.parse(oldF).length > 0 && upF === '[]' });
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
    { ...gaps, tables: gaps.tables.map((t) => (t.table === 'public._prisma_migrations' ? { ...t, rlsOff: true } : t)) }, 'public._prisma_migrations :: RLS off'],
  ['added anon-write exception', 'gaps', { ...gaps, anonWrites: [...(gaps.anonWrites || []), { table: 'public.BuildWeekDay', privileges: ['INSERT'], finding: 'D5-SELFTEST', reason: 'fixture' }] },
    'public.BuildWeekDay :: anon INSERT'],
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
