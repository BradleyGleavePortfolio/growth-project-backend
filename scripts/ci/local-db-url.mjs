#!/usr/bin/env node
// scripts/ci/local-db-url.mjs
//
// D5 (REL-14): the check every CI database script runs before it connects.
// The URL must name the local CI Postgres, and it may not carry options that
// reroute the connection: libpq and the `pg` driver honour ?host=, ?hostaddr=,
// ?service= and ?port= over the URL's host, so only a short, duplicate-free
// allowlist of options passes. Same rules as test/utils/live-test-db.ts; the
// two are pinned together by test/utils/live-test-db.spec.ts.
// CLI: node scripts/ci/local-db-url.mjs <url> [label]  (exit 1 when refused)
import { pathToFileURL } from 'node:url';

export const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', 'postgres'];
export const ALLOWED_OPTIONS = ['connection_limit', 'schema', 'connect_timeout'];
// libpq reads these from the environment even when the URL names a host
// (PGHOSTADDR wins over the host's address), so child processes never get them.
export const ROUTING_ENV = ['PGHOST', 'PGHOSTADDR', 'PGSERVICE'];

export function localDbUrlProblem(raw) {
  // Refuse anything libpq and WHATWG URL could read differently before parsing:
  // libpq does not end the database path at '#', so options after it would apply.
  if (!/^postgres(ql)?:\/\//.test(raw)) return 'does not start with postgresql:// or postgres://';
  if (!/^[\x21-\x7e]+$/.test(raw)) return 'contains whitespace, control or non-ASCII characters';
  if (raw.includes('#')) return 'has a # fragment';
  if (raw.split('@').length > 2) return 'has more than one @';
  let u;
  try {
    u = new URL(raw);
  } catch {
    return 'is not a valid URL';
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!LOCAL_HOSTS.includes(host)) return `host "${host}" is not local (${LOCAL_HOSTS.join(', ')})`;
  if (!/^\/[\w-]*$/.test(u.pathname)) return `database name "${u.pathname}" is not a plain name`;
  const seen = new Set();
  for (const key of u.searchParams.keys()) {
    if (!ALLOWED_OPTIONS.includes(key)) return `option "${key}" is not allowed (only ${ALLOWED_OPTIONS.join(', ')})`;
    if (seen.has(key)) return `option "${key}" appears twice`;
    seen.add(key);
  }
  return null;
}

export function assertLocalDbUrl(raw, label) {
  const problem = localDbUrlProblem(raw || '');
  if (problem) throw new Error(`${label} ${problem}; refusing to touch a database that is not the local CI Postgres.`);
  return raw;
}

export function cleanEnv(env = process.env) {
  const out = { ...env };
  for (const k of ROUTING_ENV) delete out[k];
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertLocalDbUrl(process.argv[2], process.argv[3] || 'database URL');
  } catch (e) {
    console.error(`[local-db-url] ${e.message}`);
    process.exit(1);
  }
}
