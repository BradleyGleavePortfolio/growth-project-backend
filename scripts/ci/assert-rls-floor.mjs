#!/usr/bin/env node
// scripts/ci/assert-rls-floor.mjs
//
// D5: the hard RLS floor. Runs against a database that CI rebuilt from empty
// with the Supabase-like bootstrap (scripts/ci/supabase-shim.sql) and
// `prisma migrate deploy` over the whole chain. It reads the catalog and fails
// when, in any schema anon or authenticated can use:
//   a. a table or partition lacks relrowsecurity or relforcerowsecurity
//      (unless listed in rls-known-gaps.json "tables");
//   b. a view or materialized view is selectable by anon/authenticated
//      without security_invoker;
//   c. a permissive policy for anon, authenticated or public has a constant
//      true USING or WITH CHECK (unless the table is reviewed reference data
//      in rls-known-gaps.json "referenceData", or the policy is a tracked
//      finding in "policies");
//   d. a policy expression uses IS NOT DISTINCT FROM (NULL matches NULL);
//   e. a SECURITY DEFINER function has no fixed search_path.
// Ratchet: a listed entry that is now compliant (or gone) also fails, so the
// lists can only shrink. Usage: RLS_FLOOR_DATABASE_URL=... node <this file>
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const url = process.env.RLS_FLOOR_DATABASE_URL || '';
const gapsFile = process.env.RLS_KNOWN_GAPS_FILE || 'scripts/ci/rls-known-gaps.json';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'postgres']);

function die(msg) {
  console.error(`[rls-floor] ${msg}`);
  process.exit(1);
}
if (!url) die('RLS_FLOOR_DATABASE_URL is not set (point it at the CI replay database).');
if (!LOCAL_HOSTS.has(new URL(url).hostname)) die('refusing a non-local database host; this gate only reads the CI replay.');

const SQL = String.raw`
WITH s AS (
  SELECT n.oid, n.nspname FROM pg_namespace n
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\_%'
    AND (has_schema_privilege('anon', n.oid, 'USAGE') OR has_schema_privilege('authenticated', n.oid, 'USAGE'))
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
  'tableCount', (SELECT count(*) FROM rel WHERE relkind IN ('r', 'p')),
  'policyCount', (SELECT count(*) FROM pol),
  'a', (SELECT coalesce(json_agg(json_build_object('object', obj, 'detail',
          concat_ws(', ', CASE WHEN NOT relrowsecurity THEN 'RLS off' END,
                          CASE WHEN NOT relforcerowsecurity THEN 'FORCE off' END,
                          CASE WHEN relkind = 'p' THEN 'partitioned' WHEN relispartition THEN 'partition' END))
          ORDER BY obj), '[]')
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
  'c', (SELECT coalesce(json_agg(json_build_object('object', tbl || ' / ' || policyname, 'table', tbl, 'detail',
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

const out = execFileSync('psql', [url, '-XAtq', '-v', 'ON_ERROR_STOP=1', '-c', SQL], { encoding: 'utf8' });
const cat = JSON.parse(out.trim());
const gaps = JSON.parse(readFileSync(gapsFile, 'utf8'));

const CHECKS = {
  a: 'table without RLS + FORCE',
  b: 'view open to API roles',
  c: 'constant-true policy',
  d: 'IS NOT DISTINCT FROM in policy',
  e: 'SECURITY DEFINER without search_path',
};
const rows = [];
const listed = new Map((gaps.tables || []).map((g) => [g.table, g]));
const reference = new Map((gaps.referenceData || []).map((g) => [g.table, g]));
const policyGaps = new Map((gaps.policies || []).map((g) => [`${g.table} / ${g.policy}`, g]));
for (const [key, list, need] of [['tables', listed, ['table', 'finding', 'reason']],
  ['policies', policyGaps, ['table', 'policy', 'finding', 'reason']], ['referenceData', reference, ['table', 'reason']]]) {
  for (const g of gaps[key] || []) {
    if (need.some((f) => !g[f])) die(`${gapsFile}: every "${key}" entry needs ${need.join(', ')}: ${JSON.stringify(g)}`);
  }
  if (list.size !== (gaps[key] || []).length) die(`${gapsFile}: duplicate entry in "${key}"`);
}

const seenGap = new Set();
for (const f of cat.a) {
  const g = listed.get(f.object);
  if (g) seenGap.add(f.object);
  rows.push({ check: 'a', object: f.object, result: g ? 'KNOWN GAP' : 'FAIL', detail: g ? `${f.detail} [${g.finding}]` : f.detail });
}
for (const [table, g] of listed) {
  if (!seenGap.has(table)) rows.push({ check: 'a', object: table, result: 'STALE ENTRY', detail: `listed as ${g.finding} but now compliant or gone; remove it from ${gapsFile}` });
}
const seenRef = new Set();
for (const f of cat.c) {
  const ref = reference.has(f.table);
  const g = ref ? null : policyGaps.get(f.object);
  if (ref) seenRef.add(f.table);
  if (g) seenGap.add(f.object);
  const result = ref ? 'REFERENCE DATA' : g ? 'KNOWN GAP' : 'FAIL';
  rows.push({ check: 'c', object: f.object, result, detail: g ? `${f.detail} [${g.finding}]` : f.detail });
}
for (const table of reference.keys()) {
  if (!seenRef.has(table)) rows.push({ check: 'c', object: table, result: 'STALE ENTRY', detail: `reference-data entry has no constant-true API policy now; remove it from ${gapsFile}` });
}
for (const [key, g] of policyGaps) {
  if (!seenGap.has(key)) rows.push({ check: 'c', object: key, result: 'STALE ENTRY', detail: `listed as ${g.finding} but now compliant or gone; remove it from ${gapsFile}` });
}
for (const k of ['b', 'd', 'e']) for (const f of cat[k]) rows.push({ check: k, object: f.object, result: 'FAIL', detail: f.detail });

const failing = rows.filter((r) => r.result === 'FAIL' || r.result === 'STALE ENTRY');
const order = { FAIL: 0, 'STALE ENTRY': 1, 'KNOWN GAP': 2, 'REFERENCE DATA': 3 };
rows.sort((x, y) => order[x.result] - order[y.result] || x.check.localeCompare(y.check) || x.object.localeCompare(y.object));
const count = (k, r) => rows.filter((x) => x.check === k && (!r || x.result === r)).length;

const head = [
  `Schemas checked (usable by anon/authenticated): ${cat.schemas.join(', ')}`,
  `Tables/partitions: ${cat.tableCount}; policies: ${cat.policyCount}; known gaps listed: ${listed.size + policyGaps.size}; reference-data tables: ${reference.size}`,
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

if (failing.length) die(`${failing.length} finding(s) failed (FAIL = new unprotected object, STALE ENTRY = list must shrink).`);
console.log('[rls-floor] OK: no unlisted findings and no stale list entries.');
