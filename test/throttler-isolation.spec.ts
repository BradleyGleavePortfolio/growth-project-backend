import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerException, ThrottlerGuard, ThrottlerStorageService } from '@nestjs/throttler';
import * as fs from 'fs';
import * as path from 'path';

import { AuthController } from '../src/auth/auth.controller';
import { ENV_RULES } from '../src/common/env-validation';
import { InviteCodesController } from '../src/invite-codes/invite-codes.controller';
import { StorefrontPublicController } from '../src/storefront/storefront-public.controller';
import {
  THROTTLER_LIMITS,
  THROTTLER_NAMES,
  THROTTLER_ROUTE_LIMITS,
} from '../src/throttler/throttler.config';
import { UserThrottlerGuard } from '../src/throttler/user-throttler.guard';

// C14 — throttler isolation.
//
// @nestjs/throttler evaluates EVERY named throttler on EVERY route at that
// throttler's module-level baseline unless the route opts out per name. With
// ~25 named buckets, an anonymous GET /auth/signup-policy was capped by
// auth-password-reset (3/h) — 3 requests from one IP, then 429 — which is
// exactly what a clinic room on shared Wi-Fi would hit.
//
// Rule under test: UserThrottlerGuard applies a named throttler ONLY to routes
// that declare it via @Throttle({ [name]: … }); `default` still applies
// everywhere. Public reads get the dedicated `public-reads` bucket.
//
// Every limit assertion below runs the REAL guard over in-memory storage with
// the REAL controller metadata; nothing is mocked except the HTTP context.

type Handler = (...args: never[]) => unknown;

function makeCtx(opts: {
  path: string;
  ip: string;
  handler: Handler;
  cls: abstract new (...args: never[]) => unknown;
  body?: unknown;
  params?: Record<string, string>;
}): ExecutionContext {
  const req = {
    route: { path: opts.path },
    url: opts.path,
    body: opts.body,
    params: opts.params ?? {},
    ip: opts.ip,
    headers: {},
    socket: { remoteAddress: opts.ip },
  };
  const res = { header: jest.fn() };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    getHandler: () => opts.handler,
    getClass: () => opts.cls,
    getType: () => 'http',
  };
  // @ts-expect-error partial ExecutionContext double — the throttler reads only these members
  return ctx;
}

const storages: ThrottlerStorageService[] = [];
afterEach(() => {
  // In-memory storage arms expiry timers; clear them so jest exits cleanly.
  for (const s of storages.splice(0)) s.onApplicationShutdown();
});

async function buildGuard(kind: 'isolated' | 'upstream' = 'isolated') {
  const { guard } = await buildGuardWithStorage(kind);
  return guard;
}

async function buildGuardWithStorage(kind: 'isolated' | 'upstream' = 'isolated') {
  const storage = new ThrottlerStorageService();
  storages.push(storage);
  const opts = { throttlers: THROTTLER_LIMITS.map((t) => ({ ...t })) };
  const guard =
    kind === 'isolated'
      ? new UserThrottlerGuard(opts, storage, new Reflector())
      : new ThrottlerGuard(opts, storage, new Reflector());
  await guard.onModuleInit();
  return { guard, storage };
}

async function hammer(
  guard: ThrottlerGuard,
  build: () => ExecutionContext,
  n: number,
): Promise<{ allowed: number; blocked: number }> {
  let allowed = 0;
  let blocked = 0;
  for (let i = 0; i < n; i += 1) {
    try {
      if (await guard.canActivate(build())) allowed += 1;
    } catch (err) {
      if (!(err instanceof ThrottlerException)) throw err;
      blocked += 1;
    }
  }
  return { allowed, blocked };
}

const signupPolicy = (ip: string) => () =>
  makeCtx({
    path: '/auth/signup-policy',
    ip,
    handler: AuthController.prototype.getSignupPolicy,
    cls: AuthController,
  });
const invitePreview = (ip: string) => () =>
  makeCtx({
    path: '/invite/:code/preview',
    ip,
    params: { code: 'GP-CLINIC' },
    handler: InviteCodesController.prototype.previewInvite,
    cls: InviteCodesController,
  });
const login = (ip: string) => () =>
  makeCtx({
    path: '/auth/login',
    ip,
    body: { email: 'a@b.c', password: 'x' },
    handler: AuthController.prototype.login,
    cls: AuthController,
  });

const apple = (ip: string) => () =>
  makeCtx({
    path: '/auth/apple',
    ip,
    body: { identity_token: 'x'.repeat(40) },
    handler: AuthController.prototype.appleAuth,
    cls: AuthController,
  });
const google = (ip: string) => () =>
  makeCtx({
    path: '/auth/google',
    ip,
    body: { id_token: 'x'.repeat(40) },
    handler: AuthController.prototype.googleAuth,
    cls: AuthController,
  });

const PUBLIC_READS = THROTTLER_ROUTE_LIMITS.PUBLIC_READS_PER_MIN;
const OAUTH_PER_MIN = THROTTLER_ROUTE_LIMITS.AUTH_OAUTH_PER_MIN;
const LOGIN_PER_MIN = THROTTLER_ROUTE_LIMITS.AUTH_LOGIN_PER_MIN;

// ---- 1. the regression, before and after ------------------------------------

describe('C14 — the shared-Wi-Fi regression', () => {
  it('upstream guard (no isolation): anonymous GET /auth/signup-policy is 429 after 3 hits from one IP', async () => {
    const guard = await buildGuard('upstream');
    const r = await hammer(guard, signupPolicy('203.0.113.1'), 8);
    // auth-password-reset's 3/h baseline bites first, then auth-login-per-min.
    expect(r.allowed).toBeLessThanOrEqual(3);
    expect(r.blocked).toBeGreaterThanOrEqual(5);
  });

  it(`isolated guard: the same IP gets ${PUBLIC_READS} signup-policy reads per minute, then 429`, async () => {
    const guard = await buildGuard();
    expect(await hammer(guard, signupPolicy('203.0.113.1'), PUBLIC_READS + 1)).toEqual({
      allowed: PUBLIC_READS,
      blocked: 1,
    });
  });

  it(`isolated guard: GET /invite/:code/preview gets ${PUBLIC_READS} reads per minute per IP`, async () => {
    const guard = await buildGuard();
    expect(await hammer(guard, invitePreview('203.0.113.2'), PUBLIC_READS + 1)).toEqual({
      allowed: PUBLIC_READS,
      blocked: 1,
    });
  });

  it('public reads and login are independent buckets for the same IP', async () => {
    const guard = await buildGuard();
    // Exhaust login (per-minute) first…
    expect(await hammer(guard, login('203.0.113.3'), LOGIN_PER_MIN + 1)).toEqual({
      allowed: LOGIN_PER_MIN,
      blocked: 1,
    });
    // …the app's signup-policy read from the same IP is unaffected.
    expect(await hammer(guard, signupPolicy('203.0.113.3'), 20)).toEqual({
      allowed: 20,
      blocked: 0,
    });
  });
});

// ---- 1b. a clinic room signing in with Apple / Google from ONE IP -----------


describe('C14 — a clinic room on one Wi-Fi can sign in (no reset needed)', () => {
  it('upstream guard (no isolation): /auth/apple from one IP is capped at 3 by unrelated baselines', async () => {
    const guard = await buildGuard('upstream');
    const r = await hammer(guard, apple('192.0.2.1'), 20);
    expect(r.allowed).toBeLessThanOrEqual(3);
  });

  it(`40 Apple sign-ins + 40 Google sign-ins from one IP all pass the never-reset per-IP OAuth buckets (${OAUTH_PER_MIN}/min)`, async () => {
    const guard = await buildGuard();
    expect(OAUTH_PER_MIN).toBeGreaterThanOrEqual(40);
    expect(await hammer(guard, apple('192.0.2.2'), 40)).toEqual({ allowed: 40, blocked: 0 });
    expect(await hammer(guard, google('192.0.2.2'), 40)).toEqual({ allowed: 40, blocked: 0 });
  });

  it('the OAuth per-IP bucket still binds: over the per-minute limit is 429', async () => {
    const guard = await buildGuard();
    expect(await hammer(guard, apple('192.0.2.4'), OAUTH_PER_MIN + 1)).toEqual({
      allowed: OAUTH_PER_MIN,
      blocked: 1,
    });
  });

  it('password login and OAuth are separate per-IP buckets (an Apple room does not eat password logins)', async () => {
    const guard = await buildGuard();
    await hammer(guard, apple('192.0.2.5'), 40);
    expect((await hammer(guard, login('192.0.2.5'), 1)).allowed).toBe(1);
  });
});

// ---- 2. intended routes keep their tight limits -----------------------------

describe('C14 — intended routes are still governed by their own throttler', () => {
  it(`POST /auth/login: ${LOGIN_PER_MIN} per minute per IP (auth-login-per-min, never reset)`, async () => {
    const guard = await buildGuard();
    expect(await hammer(guard, login('198.51.100.1'), LOGIN_PER_MIN + 1)).toEqual({
      allowed: LOGIN_PER_MIN,
      blocked: 1,
    });
  });

  it('POST /auth/forgot-password: 3 per hour per IP (auth-password-reset)', async () => {
    const guard = await buildGuard();
    const build = () =>
      makeCtx({
        path: '/auth/forgot-password',
        ip: '198.51.100.2',
        body: { email: 'a@b.c' },
        handler: AuthController.prototype.forgotPassword,
        cls: AuthController,
      });
    expect(await hammer(guard, build, 4)).toEqual({ allowed: 3, blocked: 1 });
  });

  it('POST /auth/register: 100 per hour per IP by default (auth-signup, AUTH_SIGNUP_PER_HOUR)', async () => {
    const guard = await buildGuard();
    const build = () =>
      makeCtx({
        path: '/auth/register',
        ip: '198.51.100.3',
        body: { email: 'a@b.c', password: 'x' },
        handler: AuthController.prototype.register,
        cls: AuthController,
      });
    expect(await hammer(guard, build, 101)).toEqual({ allowed: 100, blocked: 1 });
  });

  it('GET /packages/public/join/:token keeps its route-level default (20/min composite key)', async () => {
    const guard = await buildGuard();
    const build = () =>
      makeCtx({
        path: '/packages/public/join/:token',
        ip: '198.51.100.4',
        params: { token: 'tok_abcdef' },
        handler: StorefrontPublicController.prototype.getPublicPackage,
        cls: StorefrontPublicController,
      });
    expect(await hammer(guard, build, 21)).toEqual({ allowed: 20, blocked: 1 });
  });

  it('a route with no named declaration is bounded only by `default` (named baselines no longer bite)', async () => {
    class PlainController {
      read(): string {
        return 'ok';
      }
    }
    const guard = await buildGuard();
    const defaultRow = THROTTLER_LIMITS.find((t) => t.name === THROTTLER_NAMES.DEFAULT);
    if (!defaultRow) throw new Error('default throttler row missing');
    const build = () =>
      makeCtx({
        path: '/plain',
        ip: '198.51.100.5',
        handler: PlainController.prototype.read,
        cls: PlainController,
      });
    // Before C14 this would have stopped at 3 (auth-password-reset baseline).
    expect(await hammer(guard, build, defaultRow.limit + 1)).toEqual({
      allowed: defaultRow.limit,
      blocked: 1,
    });
  });
});

// ---- 3. route table: each throttler is declared on its intended routes ------

describe('C14 — route → throttler declarations', () => {
  const reflector = new Reflector();
  const declared = (
    handler: Handler,
    cls: abstract new (...args: never[]) => unknown,
    name: string,
  ) => reflector.getAllAndOverride<unknown>(`THROTTLER:LIMIT${name}`, [handler, cls]) !== undefined;

  it.each([
    ['login', AuthController.prototype.login, AuthController, THROTTLER_NAMES.AUTH_LOGIN_PER_MIN],
    ['login', AuthController.prototype.login, AuthController, THROTTLER_NAMES.AUTH_LOGIN_PER_HOUR],
    ['register', AuthController.prototype.register, AuthController, THROTTLER_NAMES.AUTH_SIGNUP],
    [
      'appleAuth',
      AuthController.prototype.appleAuth,
      AuthController,
      THROTTLER_NAMES.AUTH_OAUTH_PER_MIN,
    ],
    [
      'appleAuth',
      AuthController.prototype.appleAuth,
      AuthController,
      THROTTLER_NAMES.AUTH_OAUTH_PER_HOUR,
    ],
    [
      'googleAuth',
      AuthController.prototype.googleAuth,
      AuthController,
      THROTTLER_NAMES.AUTH_OAUTH_PER_MIN,
    ],
    [
      'googleAuth',
      AuthController.prototype.googleAuth,
      AuthController,
      THROTTLER_NAMES.AUTH_OAUTH_PER_HOUR,
    ],
    [
      'forgotPassword',
      AuthController.prototype.forgotPassword,
      AuthController,
      THROTTLER_NAMES.AUTH_PASSWORD_RESET,
    ],
    [
      'getSignupPolicy',
      AuthController.prototype.getSignupPolicy,
      AuthController,
      THROTTLER_NAMES.PUBLIC_READS,
    ],
    [
      'previewInvite',
      InviteCodesController.prototype.previewInvite,
      InviteCodesController,
      THROTTLER_NAMES.PUBLIC_READS,
    ],
    [
      'getPublicPackage',
      StorefrontPublicController.prototype.getPublicPackage,
      StorefrontPublicController,
      THROTTLER_NAMES.STOREFRONT_JOIN_IP,
    ],
  ] as const)('%s declares %3$s', (_label, handler, cls, name) => {
    expect(declared(handler as Handler, cls, name)).toBe(true);
  });

  it('public reads do NOT declare the auth buckets (so those cannot bite them)', () => {
    for (const name of [
      THROTTLER_NAMES.AUTH_PASSWORD_RESET,
      THROTTLER_NAMES.AUTH_LOGIN_PER_MIN,
      THROTTLER_NAMES.AUTH_SIGNUP,
    ]) {
      expect(declared(AuthController.prototype.getSignupPolicy, AuthController, name)).toBe(false);
      expect(
        declared(InviteCodesController.prototype.previewInvite, InviteCodesController, name),
      ).toBe(false);
    }
  });

  it('guard rule: `default` always applies; unnamed never skipped', () => {
    const storage = new ThrottlerStorageService();
    storages.push(storage);
    const guard = new UserThrottlerGuard(
      { throttlers: THROTTLER_LIMITS.map((t) => ({ ...t })) },
      storage,
      new Reflector(),
    );
    const ctx = signupPolicy('1.1.1.1')();
    expect(guard.routeDeclaresThrottler(ctx, THROTTLER_NAMES.DEFAULT)).toBe(true);
    expect(guard.routeDeclaresThrottler(ctx, undefined)).toBe(true);
    expect(guard.routeDeclaresThrottler(ctx, THROTTLER_NAMES.PUBLIC_READS)).toBe(true);
    expect(guard.routeDeclaresThrottler(ctx, THROTTLER_NAMES.AUTH_PASSWORD_RESET)).toBe(false);
  });
});

// ---- 4. config + env registry ------------------------------------------------

describe('C14 — public-reads throttler config and env registration', () => {
  it('public-reads row: 60s window, PUBLIC_READS_PER_MIN limit (default 240)', () => {
    const row = THROTTLER_LIMITS.find((t) => t.name === THROTTLER_NAMES.PUBLIC_READS);
    expect(row).toMatchObject({ ttl: 60_000, limit: PUBLIC_READS });
    expect(PUBLIC_READS).toBe(240);
  });

  it('PUBLIC_READS_PER_MIN is registered in ENV_RULES, prod-switches.yml and .env.example', () => {
    expect(ENV_RULES.find((r) => r.name === 'PUBLIC_READS_PER_MIN')?.tier).toBe('optional');
    const root = path.join(__dirname, '..');
    expect(fs.readFileSync(path.join(root, 'prod-switches.yml'), 'utf8')).toContain(
      'name: PUBLIC_READS_PER_MIN',
    );
    expect(fs.readFileSync(path.join(root, '.env.example'), 'utf8')).toContain(
      'PUBLIC_READS_PER_MIN=240',
    );
  });
});
