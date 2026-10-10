#!/usr/bin/env node
// scripts/ci/rls-lists.mjs
//
// D5: the two ratchet lists and the rule that they may only shrink.
//   scripts/ci/rls-known-gaps.json      read by assert-rls-floor.mjs (rls-floor-guard)
//   scripts/ci/rls-suites-pending.json  read by run-rls-suites.mjs (rls-live-tests)
// Every entry has identities that pin its exact exception shape:
//   tables          "<table> :: RLS off" and/or "<table> :: FORCE off", one per flag
//   policies,       "<table> / <policy> :: SELECT to <roles>". Only a constant-true
//   referenceData   SELECT policy can be listed, never INSERT/UPDATE/DELETE/ALL
//   suites (pending), operatorOnly   "<list> :: <path>"
// CLI, the removal-only check:  node scripts/ci/rls-lists.mjs <gaps|suites> [file]
//   Compares the list with the same file at the trusted base commit
//   (RLS_LISTS_BASE_SHA: the PR base, or the previous main commit on push;
//   origin/main when empty) and fails on any identity the base does not have,
//   so an entry can be removed but never added or widened. No file at the base
//   means this list is the baseline: allowed once, and printed.
//   RLS_LISTS_BASE_FILE=<path> compares with a local file instead (self-test).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const GAPS_FILE = 'scripts/ci/rls-known-gaps.json';
export const SUITES_FILE = 'scripts/ci/rls-suites-pending.json';

function need(ok, file, msg, entry) {
  if (!ok) throw new Error(`${file}: ${msg}: ${JSON.stringify(entry)}`);
}

export const policyId = (table, policy, cmd, roles) => `${table} / ${policy} :: ${cmd} to ${[...roles].sort().join(',')}`;

// identity -> { section, entry }; throws on a bad shape or a duplicate.
export function gapIdentities(doc, file = GAPS_FILE) {
  const ids = new Map();
  const add = (id, section, entry) => {
    need(!ids.has(id), file, `duplicate ${id}`, entry);
    ids.set(id, { section, entry });
  };
  for (const e of doc.tables || []) {
    need(e.table && e.finding && e.reason && (e.rlsOff === true || e.forceOff === true), file,
      'a "tables" entry needs table, finding, reason and rlsOff and/or forceOff: true', e);
    need(Object.keys(e).every((k) => ['table', 'rlsOff', 'forceOff', 'finding', 'reason'].includes(k)), file, 'unknown field', e);
    if (e.rlsOff) add(`${e.table} :: RLS off`, 'tables', e);
    if (e.forceOff) add(`${e.table} :: FORCE off`, 'tables', e);
  }
  for (const section of ['policies', 'referenceData']) {
    for (const e of doc[section] || []) {
      need(e.table && e.policy && e.reason && Array.isArray(e.roles) && e.roles.length > 0 && (section === 'referenceData' || e.finding),
        file, `a "${section}" entry needs table, policy, cmd, roles, reason${section === 'policies' ? ' and finding' : ''}`, e);
      need(e.cmd === 'SELECT', file, 'only a constant-true SELECT policy can be listed; INSERT/UPDATE/DELETE/ALL never are', e);
      add(policyId(e.table, e.policy, e.cmd, e.roles), section, e);
    }
  }
  return ids;
}

export function suiteIdentities(doc, file = SUITES_FILE) {
  const ids = new Map();
  const paths = new Set();
  for (const [section, label] of [['suites', 'pending'], ['operatorOnly', 'operatorOnly']]) {
    for (const e of doc[section] || []) {
      need(e.path && e.reason, file, `a "${section}" entry needs path and reason`, e);
      need(!paths.has(e.path), file, 'duplicate path', e);
      paths.add(e.path);
      ids.set(`${label} :: ${e.path}`, { section, entry: e });
    }
  }
  return ids;
}

function baseText(repoPath) {
  if (process.env.RLS_LISTS_BASE_FILE) {
    return { label: process.env.RLS_LISTS_BASE_FILE, text: readFileSync(process.env.RLS_LISTS_BASE_FILE, 'utf8') };
  }
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  let sha = process.env.RLS_LISTS_BASE_SHA || '';
  if (!sha || /^0+$/.test(sha)) {
    git('fetch', '--no-tags', '--depth=1', 'origin', 'main');
    sha = git('rev-parse', 'FETCH_HEAD').trim();
  } else {
    git('fetch', '--no-tags', '--depth=1', 'origin', sha);
  }
  if (!git('ls-tree', '--name-only', sha, '--', repoPath).trim()) return { label: sha, text: null };
  return { label: sha, text: git('show', `${sha}:${repoPath}`) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const kind = process.argv[2];
    const repoPath = { gaps: GAPS_FILE, suites: SUITES_FILE }[kind];
    if (!repoPath) throw new Error('usage: rls-lists.mjs <gaps|suites> [file]');
    const file = process.argv[3] || repoPath;
    const ids = kind === 'gaps' ? gapIdentities : suiteIdentities;
    const head = ids(JSON.parse(readFileSync(file, 'utf8')), file);
    const base = baseText(repoPath);
    if (base.text === null) {
      console.log(`[rls-lists] ${repoPath} does not exist at base ${base.label}: this list is the baseline (allowed once). ${head.size} identities:`);
      for (const id of head.keys()) console.log(`  baseline ${id}`);
    } else {
      const was = ids(JSON.parse(base.text), `${repoPath} at ${base.label}`);
      const added = [...head.keys()].filter((id) => !was.has(id));
      const removed = [...was.keys()].filter((id) => !head.has(id));
      console.log(`[rls-lists] ${repoPath}: ${was.size} identities at base ${base.label}, ${head.size} now (${removed.length} removed, ${added.length} added)`);
      for (const id of removed) console.log(`  removed  ${id}`);
      for (const id of added) console.log(`  ADDED    ${id}`);
      if (added.length) throw new Error(`${added.length} identity(ies) added or widened in ${file}; this list may only shrink.`);
    }
    console.log('[rls-lists] OK: nothing added or widened.');
  } catch (e) {
    console.error(`[rls-lists] ${e.message}`);
    process.exit(1);
  }
}
