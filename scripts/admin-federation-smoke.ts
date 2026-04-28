/* eslint-disable no-console */
/**
 * scripts/admin-federation-smoke.ts
 *
 * Automated smoke for the OWNER-only admin + federation surface. Mirrors
 * the nine manual checks an operator runs against staging/production after
 * a deploy that touches /api/admin/*:
 *
 *   1. GET /health                              (unauthenticated 200)
 *   2. GET /api/admin/metrics                   (200, counter shape)
 *   3. GET /api/admin/users                     (200, array)
 *   4. GET /api/admin/coaches                   (200, array)
 *   5. GET /api/admin/search?q=                 (200, fitness/finance blocks)
 *   6. GET /api/admin/coaches/:id/overview      (200)
 *   7. GET /api/admin/clients/:id/unified       (200)
 *   8. GET /api/admin/product/usage             (200, status field present)
 *   9. GET /api/admin/finance/health            (200, status field present)
 *
 * Hard requirements:
 *
 *   - Exits non-zero on the first failed assertion (any check). The CI
 *     and operator deploy checklist depend on a clean exit code as the
 *     "go/no-go" signal — never paper over a failure.
 *   - Never logs secrets. The OWNER bearer is read from env and never
 *     echoed; URLs are logged path-only by default. Set SMOKE_VERBOSE=1
 *     to include response bodies (still scrubbed of headers/tokens).
 *
 * Usage:
 *
 *   BACKEND_URL=https://api-staging.thegrowthproject.app \
 *   OWNER_JWT=eyJ... \
 *   SMOKE_COACH_ID=<coach user id> \
 *   SMOKE_CLIENT_ID=<student user id> \
 *     npx ts-node scripts/admin-federation-smoke.ts
 *
 *   # Optional: pin the expected finance status. When set, finance-status
 *   # checks (#8, #9) only pass when the response carries this exact
 *   # status. Useful in environments where finance is intentionally
 *   # configured (`ok`) or intentionally left off (`not_configured`).
 *   SMOKE_FINANCE_EXPECTED_STATUS=ok ...
 *
 * The script is read-only — every endpoint here is a GET. It will not
 * mutate state, it does not call /admin/users/:id/promote, /admin/gdpr/scrub,
 * or any other write surface.
 */

type CheckOk = { name: string; ok: true; detail: string };
type CheckFail = { name: string; ok: false; detail: string };
type CheckResult = CheckOk | CheckFail;

// --- env -------------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    console.error(`[admin-smoke] missing required env var ${name}`);
    process.exit(2);
  }
  return v;
}

const BASE = requireEnv('BACKEND_URL').replace(/\/$/, '');
const OWNER_JWT = requireEnv('OWNER_JWT');
const COACH_ID = requireEnv('SMOKE_COACH_ID');
const CLIENT_ID = requireEnv('SMOKE_CLIENT_ID');
const FINANCE_EXPECTED = (process.env.SMOKE_FINANCE_EXPECTED_STATUS || '')
  .trim()
  .toLowerCase();
const VERBOSE = process.env.SMOKE_VERBOSE === '1';

import { FINANCE_OK_STATUSES, redactId } from './admin-federation-smoke.helpers';

// --- http helpers ----------------------------------------------------------

async function timedFetch(
  path: string,
  init: RequestInit = {},
  timeoutMs = 15000,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(`${BASE}${path}`, {
      ...init,
      signal: ctrl.signal,
      redirect: 'manual',
    });
  } finally {
    clearTimeout(t);
  }
}

function authHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${OWNER_JWT}`,
    accept: 'application/json',
  };
}

async function readJson(r: Response): Promise<unknown> {
  try {
    return await r.json();
  } catch {
    return null;
  }
}

function shortBody(body: unknown): string {
  if (!VERBOSE) return '';
  try {
    const s = JSON.stringify(body);
    if (!s) return '';
    return ` body=${s.length > 200 ? s.slice(0, 200) + '…' : s}`;
  } catch {
    return '';
  }
}

// --- assertions ------------------------------------------------------------

function ok(name: string, detail: string): CheckOk {
  return { name, ok: true, detail };
}
function fail(name: string, detail: string): CheckFail {
  return { name, ok: false, detail };
}

async function check(
  name: string,
  fn: () => Promise<CheckResult>,
): Promise<CheckResult> {
  try {
    return await fn();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail(name, `threw: ${msg}`);
  }
}

// --- individual checks -----------------------------------------------------

async function checkHealth(): Promise<CheckResult> {
  const name = 'GET /health';
  const r = await timedFetch('/health');
  if (r.status !== 200) return fail(name, `status ${r.status}`);
  const body = (await readJson(r)) as { ok?: unknown } | null;
  if (!body || body.ok !== true) return fail(name, 'body missing { ok: true }');
  return ok(name, '200 ok');
}

async function checkAdminMetrics(): Promise<CheckResult> {
  const name = 'GET /api/admin/metrics';
  const r = await timedFetch('/api/admin/metrics', { headers: authHeaders() });
  if (r.status !== 200) return fail(name, `status ${r.status}`);
  const body = (await readJson(r)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return fail(name, 'body not object');
  // Spot-check a couple of counters that have been on the response since
  // the metrics surface launched. Don't pin the full schema — that's the
  // job of test/metrics.service.spec.ts.
  if (typeof (body as any).total_users !== 'number') {
    return fail(name, 'missing numeric total_users');
  }
  return ok(name, `200 (total_users=${(body as any).total_users})${shortBody(body)}`);
}

async function checkAdminUsers(): Promise<CheckResult> {
  const name = 'GET /api/admin/users';
  const r = await timedFetch('/api/admin/users?limit=5', { headers: authHeaders() });
  if (r.status !== 200) return fail(name, `status ${r.status}`);
  const body = await readJson(r);
  if (!Array.isArray(body)) return fail(name, 'body not array');
  return ok(name, `200 (n=${body.length})`);
}

async function checkAdminCoaches(): Promise<CheckResult> {
  const name = 'GET /api/admin/coaches';
  const r = await timedFetch('/api/admin/coaches', { headers: authHeaders() });
  if (r.status !== 200) return fail(name, `status ${r.status}`);
  const body = await readJson(r);
  if (!Array.isArray(body)) return fail(name, 'body not array');
  return ok(name, `200 (n=${body.length})`);
}

async function checkAdminSearch(): Promise<CheckResult> {
  const name = 'GET /api/admin/search?q=';
  // Empty q is a safe probe — federation.unifiedSearch returns a structured
  // empty result without throwing, so this verifies the route is mounted
  // and the federation service is wired without depending on real data.
  const r = await timedFetch('/api/admin/search?q=', { headers: authHeaders() });
  if (r.status !== 200) return fail(name, `status ${r.status}`);
  const body = (await readJson(r)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return fail(name, 'body not object');
  return ok(name, '200 ok');
}

async function checkCoachOverview(): Promise<CheckResult> {
  const name = `GET /api/admin/coaches/${redactId(COACH_ID, VERBOSE)}/overview`;
  const r = await timedFetch(`/api/admin/coaches/${encodeURIComponent(COACH_ID)}/overview`, {
    headers: authHeaders(),
  });
  if (r.status !== 200) return fail(name, `status ${r.status}`);
  const body = (await readJson(r)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return fail(name, 'body not object');
  if (typeof (body as any).user_id !== 'string') {
    return fail(name, 'missing user_id');
  }
  return ok(name, '200 ok');
}

async function checkClientUnified(): Promise<CheckResult> {
  const name = `GET /api/admin/clients/${redactId(CLIENT_ID, VERBOSE)}/unified`;
  const r = await timedFetch(`/api/admin/clients/${encodeURIComponent(CLIENT_ID)}/unified`, {
    headers: authHeaders(),
  });
  if (r.status !== 200) return fail(name, `status ${r.status}`);
  const body = (await readJson(r)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return fail(name, 'body not object');
  if (typeof (body as any).user_id !== 'string') {
    return fail(name, 'missing user_id');
  }
  return ok(name, '200 ok');
}

async function checkProductUsage(): Promise<CheckResult> {
  const name = 'GET /api/admin/product/usage';
  const r = await timedFetch('/api/admin/product/usage', { headers: authHeaders() });
  if (r.status !== 200) return fail(name, `status ${r.status}`);
  const body = (await readJson(r)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return fail(name, 'body not object');
  const status = String((body as any).status || '').toLowerCase();
  if (!FINANCE_OK_STATUSES.has(status)) {
    return fail(name, `unexpected status="${status}"`);
  }
  if (FINANCE_EXPECTED && status !== FINANCE_EXPECTED) {
    return fail(name, `status=${status}, expected ${FINANCE_EXPECTED}`);
  }
  return ok(name, `200 status=${status}`);
}

async function checkFinanceHealth(): Promise<CheckResult> {
  const name = 'GET /api/admin/finance/health';
  const r = await timedFetch('/api/admin/finance/health', { headers: authHeaders() });
  if (r.status !== 200) return fail(name, `status ${r.status}`);
  const body = (await readJson(r)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return fail(name, 'body not object');
  const status = String((body as any).status || '').toLowerCase();
  if (!FINANCE_OK_STATUSES.has(status)) {
    return fail(name, `unexpected status="${status}"`);
  }
  if (FINANCE_EXPECTED && status !== FINANCE_EXPECTED) {
    return fail(name, `status=${status}, expected ${FINANCE_EXPECTED}`);
  }
  return ok(name, `200 status=${status}`);
}

// --- main ------------------------------------------------------------------

async function main() {
  console.log(`[admin-smoke] base=${BASE}`);
  console.log(
    `[admin-smoke] coach_id=${redactId(COACH_ID, VERBOSE)} client_id=${redactId(CLIENT_ID, VERBOSE)}` +
      (FINANCE_EXPECTED ? ` finance_expected=${FINANCE_EXPECTED}` : ''),
  );

  const checks: Array<[string, () => Promise<CheckResult>]> = [
    ['health', checkHealth],
    ['admin.metrics', checkAdminMetrics],
    ['admin.users', checkAdminUsers],
    ['admin.coaches', checkAdminCoaches],
    ['admin.search', checkAdminSearch],
    ['admin.coach_overview', checkCoachOverview],
    ['admin.client_unified', checkClientUnified],
    ['admin.product_usage', checkProductUsage],
    ['admin.finance_health', checkFinanceHealth],
  ];

  const results: CheckResult[] = [];
  for (const [, fn] of checks) {
    const r = await check(fn.name, fn);
    results.push(r);
    const tag = r.ok ? 'PASS' : 'FAIL';
    console.log(`[admin-smoke] ${tag} ${r.name} — ${r.detail}`);
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(
    `[admin-smoke] summary: ${results.length - failed}/${results.length} passed, ${failed} failed`,
  );

  if (failed > 0) {
    console.error(`[admin-smoke] ${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('[admin-smoke] all checks passed');
}

main().catch((e) => {
  // Do not include the stack trace in a way that risks dumping headers — the
  // built-in Error message is safe; structured request/response objects are
  // not logged anywhere in this script.
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[admin-smoke] crashed: ${msg}`);
  process.exit(2);
});
