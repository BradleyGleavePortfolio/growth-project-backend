/**
 * scripts/smoke.ts
 *
 * Post-deploy smoke check. Hits a small set of routes that together prove
 * the app booted, the global guards are wired, the BFF is mounted, and
 * the public invite landing renders. Exits non-zero on the first failure.
 *
 * Designed to be safe to run against staging or production without any
 * Stripe/Supabase credentials — every check is either anonymous or
 * asserts an unauthenticated 401/400 response shape.
 *
 * Usage:
 *   SMOKE_BASE_URL=https://api-staging.thegrowthproject.app \
 *     npx ts-node scripts/smoke.ts
 *
 *   # Optional: include the AI context route check by passing a JWT.
 *   SMOKE_BASE_URL=... SMOKE_TOKEN=eyJ... npx ts-node scripts/smoke.ts
 *
 *   # Optional: smoke an invite preview against a real code.
 *   SMOKE_INVITE_CODE=GP-XYZ12 npx ts-node scripts/smoke.ts
 */

type CheckResult =
  | { name: string; ok: true; detail: string }
  | { name: string; ok: false; detail: string };

const BASE = (process.env.SMOKE_BASE_URL || 'http://localhost:3000').replace(
  /\/$/,
  '',
);
const TOKEN = process.env.SMOKE_TOKEN;
const INVITE_CODE = process.env.SMOKE_INVITE_CODE || 'GP-SMOKE-NOPE';

async function timedFetch(
  path: string,
  init: RequestInit = {},
  timeoutMs = 10000,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(`${BASE}${path}`, {
      ...init,
      signal: ctrl.signal,
      // Smoke checks should never follow redirects silently — a 30x is a
      // real change in routing semantics that the operator should notice.
      redirect: 'manual',
    });
  } finally {
    clearTimeout(t);
  }
}

async function checkHealth(): Promise<CheckResult> {
  const name = 'GET /health';
  try {
    const r = await timedFetch('/health');
    if (r.status !== 200) return { name, ok: false, detail: `status ${r.status}` };
    const body = await r.json().catch(() => null);
    if (!body || body.ok !== true) {
      return { name, ok: false, detail: 'body missing { ok: true }' };
    }
    return { name, ok: true, detail: `uptime=${body.uptime}s` };
  } catch (e: any) {
    return { name, ok: false, detail: e?.message || String(e) };
  }
}

async function checkSignupPolicy(): Promise<CheckResult> {
  const name = 'GET /api/auth/signup-policy';
  try {
    const r = await timedFetch('/api/auth/signup-policy');
    if (r.status !== 200) return { name, ok: false, detail: `status ${r.status}` };
    const body = await r.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return { name, ok: false, detail: 'body not object' };
    }
    // The current shape exposes `coach_code_required` (or similar). We don't
    // pin a strict schema — just confirm the route returns JSON and didn't
    // 404, which means the auth controller is mounted and @Public() works.
    return { name, ok: true, detail: JSON.stringify(body) };
  } catch (e: any) {
    return { name, ok: false, detail: e?.message || String(e) };
  }
}

async function checkInvitePreview(): Promise<CheckResult> {
  const name = `GET /api/invite/${INVITE_CODE}/preview`;
  try {
    const r = await timedFetch(`/api/invite/${INVITE_CODE}/preview`);
    if (r.status !== 200 && r.status !== 404) {
      return { name, ok: false, detail: `unexpected status ${r.status}` };
    }
    const body = await r.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return { name, ok: false, detail: 'body not object' };
    }
    return { name, ok: true, detail: `status=${r.status}` };
  } catch (e: any) {
    return { name, ok: false, detail: e?.message || String(e) };
  }
}

async function checkInviteLandingHtml(): Promise<CheckResult> {
  const name = `GET /join/${INVITE_CODE}`;
  try {
    const r = await timedFetch(`/join/${INVITE_CODE}`);
    if (r.status >= 500) return { name, ok: false, detail: `status ${r.status}` };
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('text/html')) {
      return { name, ok: false, detail: `unexpected content-type ${ct}` };
    }
    return { name, ok: true, detail: `status=${r.status}` };
  } catch (e: any) {
    return { name, ok: false, detail: e?.message || String(e) };
  }
}

async function checkCoachBffAuth(): Promise<CheckResult> {
  const name = 'GET /api/v1/coach/me (no token → 401)';
  try {
    const r = await timedFetch('/api/v1/coach/me');
    if (r.status !== 401) {
      return { name, ok: false, detail: `expected 401, got ${r.status}` };
    }
    return { name, ok: true, detail: '401 as expected — BFF is mounted and guarded' };
  } catch (e: any) {
    return { name, ok: false, detail: e?.message || String(e) };
  }
}

async function checkStripeWebhookSignatureGate(): Promise<CheckResult> {
  const name = 'POST /api/v1/webhooks/stripe (no signature → 400)';
  try {
    const r = await timedFetch('/api/v1/webhooks/stripe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'evt_smoke', type: 'invoice.paid' }),
    });
    // Either 400 (signature missing/invalid) or 401 (route guarded by
    // something we don't expect). 404 means the route isn't mounted —
    // that's the failure mode this check exists to catch.
    if (r.status === 404) {
      return { name, ok: false, detail: 'route not mounted (404)' };
    }
    if (r.status !== 400) {
      return { name, ok: false, detail: `expected 400, got ${r.status}` };
    }
    return { name, ok: true, detail: '400 as expected — webhook gate is active' };
  } catch (e: any) {
    return { name, ok: false, detail: e?.message || String(e) };
  }
}

async function checkAiContextShape(): Promise<CheckResult> {
  const name = 'GET /api/ai/context';
  try {
    const r = await timedFetch('/api/ai/context', {
      headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
    });
    if (!TOKEN) {
      // No token — assert that the route is guarded.
      if (r.status !== 401) {
        return { name, ok: false, detail: `expected 401 without token, got ${r.status}` };
      }
      return { name, ok: true, detail: '401 as expected (no SMOKE_TOKEN supplied)' };
    }
    if (r.status !== 200) return { name, ok: false, detail: `status ${r.status}` };
    const body = await r.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return { name, ok: false, detail: 'body not object' };
    }
    return { name, ok: true, detail: `keys=${Object.keys(body).join(',')}` };
  } catch (e: any) {
    return { name, ok: false, detail: e?.message || String(e) };
  }
}

async function main() {
  console.log(`[smoke] base=${BASE}`);
  const checks: Array<() => Promise<CheckResult>> = [
    checkHealth,
    checkSignupPolicy,
    checkInvitePreview,
    checkInviteLandingHtml,
    checkCoachBffAuth,
    checkStripeWebhookSignatureGate,
    checkAiContextShape,
  ];

  let failed = 0;
  for (const c of checks) {
    const r = await c();
    const tag = r.ok ? 'PASS' : 'FAIL';
    console.log(`[smoke] ${tag} ${r.name} — ${r.detail}`);
    if (!r.ok) failed += 1;
  }

  if (failed > 0) {
    console.error(`[smoke] ${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('[smoke] all checks passed');
}

main().catch((e) => {
  console.error('[smoke] crashed', e);
  process.exit(2);
});
