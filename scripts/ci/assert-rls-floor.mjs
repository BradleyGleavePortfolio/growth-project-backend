#!/usr/bin/env node
// scripts/ci/assert-rls-floor.mjs
//
// D5: the hard RLS floor. Runs against a database that CI rebuilt from empty
// with the Supabase-like bootstrap (scripts/ci/supabase-shim.sql) and
// `prisma migrate deploy` over the whole chain. It reads the catalog of EVERY
// non-system schema (all but pg_catalog, information_schema, pg_toast and the
// pg_temp/pg_toast_temp schemas; extension-owned objects are skipped) and fails when:
//   a. a table or partition lacks relrowsecurity or relforcerowsecurity, one
//      finding per missing flag (unless that flag is listed in "tables");
//   b. a view or materialized view is selectable by anon/authenticated
//      without security_invoker (the one check limited to API-selectable objects);
//   c. a permissive policy for anon, authenticated or public has a constant
//      true USING or WITH CHECK, unless that exact SELECT policy (table, name,
//      roles) is listed in "referenceData" or "policies";
//   d. a policy expression uses IS NOT DISTINCT FROM (NULL matches NULL);
//   e. a SECURITY DEFINER function has no fixed search_path.
// Ratchet: a listed allowance that no longer matches a finding fails as STALE
// ENTRY, and scripts/ci/rls-lists.mjs fails any allowance the base commit does
// not have, so the lists can only shrink. Usage: RLS_FLOOR_DATABASE_URL=... node <this file>
// RLS_FLOOR_REPORT_JSON=<file> also writes the result rows as JSON (self-test).
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { assertLocalDbUrl, cleanEnv } from './local-db-url.mjs';
import { gapIdentities, policyId } from './rls-lists.mjs';

const url = process.env.RLS_FLOOR_DATABASE_URL || '';
const gapsFile = process.env.RLS_KNOWN_GAPS_FILE || 'scripts/ci/rls-known-gaps.json';

function die(msg) {
  console.error(`[rls-floor] ${msg}`);
  process.exit(1);
}
if (!url) die('RLS_FLOOR_DATABASE_URL is not set (point it at the CI replay database).');
try {
  assertLocalDbUrl(url, 'RLS_FLOOR_DATABASE_URL');
} catch (e) {
  die(e.message);
}

const SQL = String.raw`
WITH s AS (
  SELECT n.oid, n.nspname FROM pg_namespace n
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND n.nspname !~ '^pg_(toast_)?temp_'
), ext AS (SELECT objid FROM pg_depend WHERE deptype = 'e'),
rel AS (
  SELECT c.*, s.nspname || '.' || c.relname AS obj FROM pg_class c JOIN s ON s.oid = c.relnamespace
  WHERE c.oid NOT IN (SELECT objid FROM ext)
), pol AS (
  SELECT p.schemaname || '.' || p.tablename AS tbl, p.policyname, p.permissive, p.roles::text[] AS roles,
         p.cmd, coalesce(p.qual, '') AS qual, coalesce(p.with_check, '') AS chk
  FROM pg_policies p JOIN s ON s.nspname = p.schemaname
)
SELECT json_build_object(
  'schemas', (SELECT json_agg(nspname ORDER BY nspname) FROM s),
  'apiSchemas', (SELECT json_agg(nspname ORDER BY nspname) FROM s
    WHERE has_schema_privilege('anon', oid, 'USAGE') OR has_schema_privilege('authenticated', oid, 'USAGE')),
  'tableCount', (SELECT count(*) FROM rel WHERE relkind IN ('r', 'p')),
  'policyCount', (SELECT count(*) FROM pol),
  'a', (SELECT coalesce(json_agg(json_build_object('object', obj, 'rlsOff', NOT relrowsecurity,
          'forceOff', NOT relforcerowsecurity, 'kind', CASE WHEN relkind = 'p' THEN 'partitioned'
          WHEN relispartition THEN 'partition' ELSE 'table' END) ORDER BY obj), '[]')
        FROM rel WHERE relkind IN ('r', 'p') AND NOT (relrowsecurity AND relforcerowsecurity)),
  'b', (SELECT coalesce(json_agg(json_build_object('object', obj, 'detail',
          CASE relkind WHEN 'm' THEN 'materialized view (cannot be security_invoker)'
                       ELSE 'view without security_invoker' END
          || ' selectable by ' || concat_ws('/',
               CASE WHEN has_any_column_privilege('anon', oid, 'SELECT') THEN 'anon' END,
               CASE WHEN has_any_column_privilege('authenticated', oid, 'SELECT') THEN 'authenticated' END))
          ORDER BY obj), '[]')
        FROM rel WHERE relkind IN ('v', 'm')
          AND (has_any_column_privilege('anon', oid, 'SELECT') OR has_any_column_privilege('authenticated', oid, 'SELECT'))
          AND NOT (relkind = 'v' AND coalesce(reloptions, '{}') && ARRAY['security_invoker=true', 'security_invoker=on', 'security_invoker=1', 'security_invoker=yes'])),
  'c', (SELECT coalesce(json_agg(json_build_object('table', tbl, 'policy', policyname, 'cmd', cmd, 'roles', roles, 'detail',
          cmd || ' to ' || array_to_string(roles, ',') || ': '
          || concat_ws(' and ', CASE WHEN regexp_replace(qual, '[()[:space:]]', '', 'g') ~* '^true$' THEN 'USING (true)' END,
                                CASE WHEN regexp_replace(chk, '[()[:space:]]', '', 'g') ~* '^true$' THEN 'WITH CHECK (true)' END))
          ORDER BY tbl, policyname), '[]')
        FROM pol WHERE permissive = 'PERMISSIVE' AND roles && ARRAY['anon', 'authenticated', 'public']
          AND (regexp_replace(qual, '[()[:space:]]', '', 'g') ~* '^true$' OR regexp_replace(chk, '[()[:space:]]', '', 'g') ~* '^true$')),
  'd', (SELECT coalesce(json_agg(json_build_object('object', tbl || ' / ' || policyname, 'detail',
          left(regexp_replace(qual || ' ' || chk, '\s+', ' ', 'g'), 160)) ORDER BY tbl, policyname), '[]')
        FROM pol WHERE (qual || ' ' || chk) ~* '(IS NOT DISTINCT FROM|NOT \(.*IS DISTINCT FROM)'),
  'e', (SELECT coalesce(json_agg(json_build_object('object', obj, 'detail', 'SECURITY DEFINER, proconfig=' || coalesce(cfg, '{}'))
          ORDER BY obj), '[]')
        FROM (SELECT s.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS obj,
                     p.proconfig::text AS cfg
              FROM pg_proc p JOIN s ON s.oid = p.pronamespace
              WHERE p.prosecdef AND p.oid NOT IN (SELECT objid FROM ext)
                AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) g WHERE g LIKE 'search\_path=%')) f)
)`;

const out = execFileSync('psql', [url, '-XAtq', '-v', 'ON_ERROR_STOP=1', '-c', SQL], { encoding: 'utf8', env: cleanEnv() });
const cat = JSON.parse(out.trim());
if (!cat.tableCount || !(cat.schemas || []).includes('public')) die(`the database has ${cat.tableCount} tables and schemas ${cat.schemas}; this is not a replayed chain.`);
let allow;
try {
  allow = gapIdentities(JSON.parse(readFileSync(gapsFile, 'utf8')), gapsFile);
} catch (e) {
  die(e.message);
}

const CHECKS = {
  a: 'table without RLS + FORCE',
  b: 'view open to API roles',
  c: 'constant-true policy',
  d: 'IS NOT DISTINCT FROM in policy',
  e: 'SECURITY DEFINER without search_path',
};
const rows = [];
const seen = new Set();
const RESULT = { tables: 'KNOWN GAP', policies: 'KNOWN GAP', referenceData: 'REFERENCE DATA' };
const judge = (check, id, detail) => {
  const g = allow.get(id);
  if (g) seen.add(id);
  rows.push({ check, object: id, result: g ? RESULT[g.section] : 'FAIL', detail: g?.entry.finding ? `${detail} [${g.entry.finding}]` : detail });
};
for (const f of cat.a) {
  if (f.rlsOff) judge('a', `${f.object} :: RLS off`, f.kind);
  if (f.forceOff) judge('a', `${f.object} :: FORCE off`, f.kind);
}
for (const f of cat.c) judge('c', policyId(f.table, f.policy, f.cmd, f.roles), f.detail);
for (const [id, g] of allow) {
  if (!seen.has(id)) rows.push({ check: g.section === 'tables' ? 'a' : 'c', object: id, result: 'STALE ENTRY', detail: `listed (${g.entry.finding || 'reference data'}) but no longer found: remove it from ${gapsFile}` });
}
for (const k of ['b', 'd', 'e']) for (const f of cat[k]) rows.push({ check: k, object: f.object, result: 'FAIL', detail: f.detail });

const failing = rows.filter((r) => r.result === 'FAIL' || r.result === 'STALE ENTRY');
const order = { FAIL: 0, 'STALE ENTRY': 1, 'KNOWN GAP': 2, 'REFERENCE DATA': 3 };
rows.sort((x, y) => order[x.result] - order[y.result] || x.check.localeCompare(y.check) || x.object.localeCompare(y.object));
const count = (k, r) => rows.filter((x) => x.check === k && (!r || x.result === r)).length;

const head = [
  `Schemas checked (every non-system schema): ${cat.schemas.join(', ')}; usable by anon/authenticated: ${(cat.apiSchemas || []).join(', ')}`,
  `Tables/partitions: ${cat.tableCount}; policies: ${cat.policyCount}; allowances listed: ${allow.size} (${[...allow.values()].filter((g) => g.section === 'referenceData').length} reference-data policies)`,
];
const summary = Object.entries(CHECKS).map(([k, label]) => ({
  k, label, fail: count(k, 'FAIL'), stale: count(k, 'STALE ENTRY'), allowed: count(k, 'KNOWN GAP') + count(k, 'REFERENCE DATA'),
}));
const pad = (s, n) => String(s).padEnd(n);
const lines = [...head, '', `${pad('check', 44)} ${pad('fail', 5)} ${pad('stale', 6)} allowed`];
for (const s of summary) lines.push(`${pad(`${s.k}. ${s.label}`, 44)} ${pad(s.fail, 5)} ${pad(s.stale, 6)} ${s.allowed}`);
lines.push('', `${pad('result', 15)} ${pad('chk', 4)} ${pad('object', 60)} detail`);
for (const r of rows) lines.push(`${pad(r.result, 15)} ${pad(r.check, 4)} ${pad(r.object, 60)} ${r.detail}`);
console.log(lines.join('\n'));

if (process.env.GITHUB_STEP_SUMMARY) {
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
  const md = [
    `## RLS floor on the full-chain replay: ${failing.length ? `FAILED (${failing.length})` : 'passed'}`, '',
    ...head.map((h) => `- ${h}`), '',
    '| check | fail | stale entry | allowed by list |', '|---|---|---|---|',
    ...summary.map((s) => `| ${s.k}. ${s.label} | ${s.fail} | ${s.stale} | ${s.allowed} |`), '',
    '| result | check | object | detail |', '|---|---|---|---|',
    ...rows.map((r) => `| ${r.result} | ${r.check} | \`${esc(r.object)}\` | ${esc(r.detail)} |`), '',
  ];
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n'));
}

if (process.env.RLS_FLOOR_REPORT_JSON) writeFileSync(process.env.RLS_FLOOR_REPORT_JSON, JSON.stringify(rows));
if (failing.length) die(`${failing.length} finding(s) failed (FAIL = new unprotected object, STALE ENTRY = list must shrink).`);
console.log('[rls-floor] OK: no unlisted findings and no stale list entries.');
