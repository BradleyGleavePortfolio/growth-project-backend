import * as fs from 'fs';
import * as path from 'path';
import {
  isAllowedWhileLocked,
  normalizePath,
} from '../src/checkout/dunning-v2/dunning-lockout.guard';

// P0-AUDIT (backend 5076a07a) Lens B P1-2 test-shape requirement:
//
//   "the tests assert the allow-list against hand-picked example paths, never
//    against the mounted route table, so an accidentally-matching route was
//    unobservable."
//
// This spec closes that gap. It enumerates every route actually mounted by a
// @Controller in src/ and asserts the EXACT set that DunningLockoutGuard lets
// through while a client is locked out. A new controller cannot silently
// inherit an exemption: it either appears in EXPECTED_REACHABLE_WHILE_LOCKED
// as a deliberate, reviewed decision, or this test goes red.
//
// If you are here because this test failed: do NOT paste the new path into the
// list to make it green. First answer "can a locked-out, non-paying client be
// allowed to call this?" The only yes-answers are payment recovery, auth,
// liveness probes, and the Roman surface that explains the lockout.

const SRC_ROOT = path.join(__dirname, '..', 'src');

const CONTROLLER_DECORATOR = /@Controller\(\s*(?:'([^']*)'|"([^"]*)")?\s*\)/;
const METHOD_DECORATOR =
  /@(?:Get|Post|Put|Patch|Delete|Head|Options|All)\(\s*(?:'([^']*)'|"([^"]*)")?\s*\)/g;

function controllerFiles(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) controllerFiles(p, out);
    else if (name.endsWith('.controller.ts')) out.push(p);
  }
  return out;
}

interface MountedRoute {
  /** Path as the router mounts it, e.g. `v1/coach/me/billing`. */
  readonly mounted: string;
  /** Same path after the guard's normalizePath, e.g. `coach/me/billing`. */
  readonly normalized: string;
  readonly file: string;
}

function mountedRoutes(): MountedRoute[] {
  const routes: MountedRoute[] = [];
  for (const file of controllerFiles(SRC_ROOT)) {
    const source = fs.readFileSync(file, 'utf8');
    const controller = CONTROLLER_DECORATOR.exec(source);
    if (!controller) continue;
    const prefix = controller[1] ?? controller[2] ?? '';

    METHOD_DECORATOR.lastIndex = 0;
    for (let m = METHOD_DECORATOR.exec(source); m; m = METHOD_DECORATOR.exec(source)) {
      const sub = m[1] ?? m[2] ?? '';
      const mounted = [prefix, sub].filter(Boolean).join('/');
      routes.push({
        mounted,
        // The global prefix is `/api` (src/main.ts setGlobalPrefix), which is
        // what the guard sees on a live request.
        normalized: normalizePath(`/api/${mounted}`),
        file: path.relative(path.join(__dirname, '..'), file),
      });
    }
  }
  return routes;
}

/**
 * Every normalized path the guard admits while the client is LOCKED OUT.
 * Reviewed one by one; each is payment recovery, authentication, a liveness
 * probe, or the Roman surface that explains the lockout.
 */
const EXPECTED_REACHABLE_WHILE_LOCKED: readonly string[] = [
  '', // public landing root (LandingPagesPublicController)
  'auth/apple',
  'auth/attach-coach-code',
  'auth/attach-invite-code',
  'auth/become-coach',
  'auth/bootstrap-owner',
  'auth/extension/login',
  'auth/extension/refresh',
  'auth/forgot-password',
  'auth/google',
  'auth/login',
  'auth/me',
  'auth/recent-auth-token',
  'auth/register',
  'auth/select-role',
  'auth/signup-policy',
  'auth/signup-with-code',
  'auth/validate-invite-code',
  'checkout',
  'checkout/billing-portal',
  'checkout/entitlement',
  'checkout/payment-intent',
  'checkout/payment-method',
  'checkout/purchases',
  'checkout/purchases/:purchaseid/drops',
  'checkout/sessions',
  'checkout/sessions/:sessionid/confirm',
  'coach/billing/portal-session', // mobile coach billing (MobileCoachBillingController)
  'coach/billing/status',
  'coach/me/billing', // v1 coach billing (CoachBillingController) — Lens A P2-1
  'coach/me/billing/portal-session', // the Stripe portal a locked coach needs
  'health',
  'health/deep',
  'healthz',
  'readyz',
  'roman/sessions',
  'roman/sessions/:id',
  'roman/sessions/:id/messages',
];

describe('DunningLockoutGuard allow-list vs the real mounted route table', () => {
  const routes = mountedRoutes();

  it('scans the controller surface (guards against a silently empty scan)', () => {
    expect(controllerFiles(SRC_ROOT).length).toBeGreaterThan(100);
    expect(routes.length).toBeGreaterThan(500);
  });

  it('admits EXACTLY the reviewed recovery routes and nothing else', () => {
    const reachable = [
      ...new Set(routes.filter((r) => isAllowedWhileLocked(r.normalized)).map((r) => r.normalized)),
    ].sort();
    expect(reachable).toEqual([...EXPECTED_REACHABLE_WHILE_LOCKED].sort());
  });

  // Lens A P1-1 — the positional second-segment match admitted any route whose
  // SECOND segment happened to be an allow-list token. Google Calendar OAuth is
  // a paid integration surface, not a payment-recovery route.
  it.each(['scheduling/auth/google/initiate', 'scheduling/auth/google/callback'])(
    'BLOCKS the paid integration route %s (Lens A P1-1)',
    (p) => {
      expect(routes.some((r) => r.normalized === p)).toBe(true);
      expect(isAllowedWhileLocked(p)).toBe(false);
    },
  );

  // Lens A P2-1 — the v1 coach billing surface is how a locked coach reaches
  // the Stripe portal to cure the delinquency. It must not be locked.
  it.each(['coach/me/billing', 'coach/me/billing/portal-session'])(
    'ALLOWS the v1 coach billing route %s (Lens A P2-1)',
    (p) => {
      expect(routes.some((r) => r.normalized === p)).toBe(true);
      expect(isAllowedWhileLocked(p)).toBe(true);
    },
  );

  // The defect class, not just its two instances: an allow-list token in any
  // non-head position must never grant an exemption.
  it.each([
    'admin/auth/impersonate',
    'community/billing/tip',
    'scheduling/checkout/confirm',
    'workouts/health/summary',
    'talent-marketplace/recover/listing',
  ])('BLOCKS %s — an allow-list token off the head grants nothing', (p) => {
    expect(isAllowedWhileLocked(p)).toBe(false);
  });

  // Both coach billing surfaces route to the same BillingService capability;
  // they must not disagree about lockout.
  it('gives both coach billing surfaces the same lockout verdict', () => {
    const verdicts = [
      'coach/billing/status',
      'coach/billing/portal-session',
      'coach/me/billing',
      'coach/me/billing/portal-session',
    ].map(isAllowedWhileLocked);
    expect(verdicts).toEqual([true, true, true, true]);
  });
});
