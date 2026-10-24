/**
 * WEB-BUYER-FLOW (owner #172-7 op 1) — POST
 * /api/v1/packages/public/join/:token/checkout/set-password, the confirm
 * page's password step. Only the confirm link's own session may set it: a
 * token Supabase still accepts, from an email link (amr "otp"), on an
 * account guest checkout made; once (the session is revoked after use); the
 * app's password rule; rate-limited; one LINK_INVALID answer for every
 * refusal, so nothing says whether an email or account exists.
 */
import 'reflect-metadata';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpException, ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { IS_PUBLIC_KEY } from '../src/common/decorators/public.decorator';
import { HttpExceptionFilter } from '../src/filters/http-exception.filter';
import { LANDING_PUBLIC_PREFIX_EXCLUDE } from '../src/landing-pages/public-route-prefix';
import { SupabaseService } from '../src/supabase/supabase.service';
import { THROTTLER_NAMES } from '../src/throttler/throttler.config';
import { BuyerPasswordController } from '../src/storefront/buyer-password.controller';
import { BuyerPasswordService, PASSWORD_RULE_MESSAGE, meetsPasswordRule } from '../src/storefront/buyer-password.service';

const jwt = (claims: Record<string, unknown>) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature-part`;
const LINK = jwt({ sub: 'u-1', email: 'ann@example.com', session_id: 'sess-1', amr: [{ method: 'otp', timestamp: 1 }] });
const GOOD = 'Strong1!pass';

type Fake = {
  user: Record<string, unknown> | null;
  getUserError: { status?: number } | null;
  updateError: { status?: number } | null;
  getUser: jest.Mock;
  updateUserById: jest.Mock;
  signOut: jest.Mock;
};

function fakeSupabase(): { svc: SupabaseService; f: Fake } {
  const revoked = new Set<string>();
  const f: Fake = {
    user: { id: 'u-1', email: 'ann@example.com', user_metadata: { source: 'guest_checkout' } },
    getUserError: null,
    updateError: null,
    getUser: jest.fn(async (t: string) =>
      f.getUserError
        ? { data: { user: null }, error: f.getUserError }
        : revoked.has(t)
          ? { data: { user: null }, error: { status: 403 } }
          : { data: { user: f.user }, error: null },
    ),
    updateUserById: jest.fn(async () => ({ data: {}, error: f.updateError })),
    signOut: jest.fn(async (t: string) => {
      revoked.add(t);
      return { data: null, error: null };
    }),
  };
  const client = { auth: { getUser: f.getUser, admin: { updateUserById: f.updateUserById, signOut: f.signOut } } };
  const svc: SupabaseService = Object.assign(Object.create(SupabaseService.prototype), { getClient: () => client });
  return { svc, f };
}

async function refusal(p: Promise<unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) return { status: e.getStatus(), body: e.getResponse() as Record<string, unknown> };
    throw e;
  }
  throw new Error('expected a refusal');
}

describe('WEB-BUYER-FLOW set-password: the password rule', () => {
  it.each([
    ['Strong1!pass', true],
    ['Aa1!aaaa', true],
    ['Short1!', false],
    ['nouppercase1!', false],
    ['NoNumber!!', false],
    ['NoSpecial12', false],
    [`A1!${'a'.repeat(70)}`, false],
    [12345678, false],
  ] as const)('%s → %s', (pw, ok) => {
    expect(meetsPasswordRule(pw)).toBe(ok);
  });
});

describe('WEB-BUYER-FLOW set-password: BuyerPasswordService', () => {
  let f: Fake;
  let svc: BuyerPasswordService;
  beforeEach(() => {
    const s = fakeSupabase();
    f = s.f;
    svc = new BuyerPasswordService(s.svc);
  });

  it('the confirm link sets the password on that account, then its session is revoked', async () => {
    await expect(svc.setPassword(LINK, GOOD)).resolves.toEqual({ saved: true });
    expect(f.getUser).toHaveBeenCalledWith(LINK);
    expect(f.updateUserById).toHaveBeenCalledWith('u-1', { password: GOOD });
    expect(f.signOut).toHaveBeenCalledWith(LINK, 'local');
  });

  it('single use: the same link a second time is refused and sets nothing', async () => {
    await svc.setPassword(LINK, GOOD);
    const again = await refusal(svc.setPassword(LINK, 'Other1!pass'));
    expect(again).toEqual({ status: 401, body: { error: 'LINK_INVALID', message: 'This link has run out' } });
    expect(f.updateUserById).toHaveBeenCalledTimes(1);
  });

  it('single use on this machine even while Supabase still accepts the token (two taps at once)', async () => {
    let release: () => void = () => {};
    f.updateUserById.mockImplementationOnce(() => new Promise((r) => (release = () => r({ data: {}, error: null }))));
    const first = svc.setPassword(LINK, GOOD);
    await new Promise((r) => setImmediate(r));
    const second = await refusal(svc.setPassword(LINK, GOOD));
    release();
    await expect(first).resolves.toEqual({ saved: true });
    expect(second.status).toBe(401);
    expect(f.updateUserById).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an app or password session', jwt({ sub: 'u-1', session_id: 's-2', amr: [{ method: 'password' }] })],
    ['a token with no session', jwt({ sub: 'u-1', amr: [{ method: 'otp' }] })],
    ['a token with no amr', jwt({ sub: 'u-1', session_id: 's-3' })],
    ['not a JWT', 'not-a-jwt-but-long-enough-to-pass'],
  ])('%s is refused with the one LINK_INVALID answer', async (_l, token) => {
    const r = await refusal(svc.setPassword(token, GOOD));
    expect(r).toEqual({ status: 401, body: { error: 'LINK_INVALID', message: 'This link has run out' } });
    expect(f.updateUserById).not.toHaveBeenCalled();
  });

  it('an account guest checkout did not make (a TGP account from the app) is refused the same way', async () => {
    f.user = { id: 'u-9', email: 'coach@example.com', user_metadata: { source: 'app_signup' } };
    const r = await refusal(svc.setPassword(LINK, GOOD));
    expect(r.body).toEqual({ error: 'LINK_INVALID', message: 'This link has run out' });
    expect(f.updateUserById).not.toHaveBeenCalled();
  });

  it.each([401, 403])('Supabase refuses the token (%s: bad, expired or revoked): LINK_INVALID', async (status) => {
    f.getUserError = { status };
    expect((await refusal(svc.setPassword(LINK, GOOD))).status).toBe(401);
  });

  it('Supabase unreachable: 503, nothing set, and the link stays usable', async () => {
    f.getUserError = {};
    expect((await refusal(svc.setPassword(LINK, GOOD))).status).toBe(503);
    f.getUserError = null;
    await expect(svc.setPassword(LINK, GOOD)).resolves.toEqual({ saved: true });
  });

  it('a password outside the rule: 400 with the app\'s rule, before Supabase is asked', async () => {
    const r = await refusal(svc.setPassword(LINK, 'weakpass'));
    expect(r).toEqual({ status: 400, body: { error: 'PASSWORD_WEAK', message: PASSWORD_RULE_MESSAGE } });
    expect(f.getUser).not.toHaveBeenCalled();
  });

  it('Supabase\'s own password check says no (422): the rule line, and the link can try again', async () => {
    f.updateError = { status: 422 };
    expect((await refusal(svc.setPassword(LINK, GOOD))).body).toMatchObject({ error: 'PASSWORD_WEAK' });
    f.updateError = null;
    await expect(svc.setPassword(LINK, 'Better1!pass')).resolves.toEqual({ saved: true });
    expect(f.signOut).toHaveBeenCalledTimes(1);
  });

  it('the save fails (500): 503 and the link can try again', async () => {
    f.updateError = { status: 500 };
    expect((await refusal(svc.setPassword(LINK, GOOD))).status).toBe(503);
    expect(f.signOut).not.toHaveBeenCalled();
    f.updateError = null;
    await expect(svc.setPassword(LINK, GOOD)).resolves.toEqual({ saved: true });
  });

  it('revoking the session fails after the save: still saved (the password is set)', async () => {
    f.signOut.mockResolvedValueOnce({ data: null, error: { status: 500 } });
    await expect(svc.setPassword(LINK, GOOD)).resolves.toEqual({ saved: true });
  });
});

describe('WEB-BUYER-FLOW set-password: the route', () => {
  let app: INestApplication;
  let base = '';
  let f: Fake;
  const env: Record<string, string | undefined> = {};
  const TOKEN = 'tokAAAAAAAAAAAAAAAAAA';

  beforeAll(async () => {
    const s = fakeSupabase();
    f = s.f;
    const moduleRef = await Test.createTestingModule({
      controllers: [BuyerPasswordController],
      providers: [
        BuyerPasswordService,
        { provide: SupabaseService, useValue: s.svc },
        { provide: ConfigService, useValue: { get: (k: string) => env[k] } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api', { exclude: [...LANDING_PUBLIC_PREFIX_EXCLUDE] });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    env.GUEST_PAY_PAGE_ENABLED = 'true';
    app.get(BuyerPasswordService).resetForTests();
    f.updateUserById.mockClear();
  });

  const post = (path: string, body: unknown) =>
    new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out ? JSON.parse(out) : {} }));
      });
      req.on('error', reject);
      req.end(data);
    });
  const route = `/api/v1/packages/public/join/${TOKEN}/checkout/set-password`;

  it('200 { saved: true } for the confirm link with a good password', async () => {
    const r = await post(route, { access_token: jwt({ sub: 'u-1', session_id: 'route-1', amr: [{ method: 'otp' }] }), password: GOOD });
    expect(r).toEqual({ status: 200, body: { saved: true } });
  });

  it('off unless GUEST_PAY_PAGE_ENABLED is exactly "true": 404, nothing set', async () => {
    env.GUEST_PAY_PAGE_ENABLED = 'TRUE';
    const r = await post(route, { access_token: LINK, password: GOOD });
    expect(r.status).toBe(404);
    expect(f.updateUserById).not.toHaveBeenCalled();
  });

  it('a malformed share token: 404 TOKEN_NOT_FOUND', async () => {
    const r = await post('/api/v1/packages/public/join/x/checkout/set-password', { access_token: LINK, password: GOOD });
    expect(r.status).toBe(404);
    expect(f.updateUserById).not.toHaveBeenCalled();
  });

  it.each([
    ['an extra field', { access_token: LINK, password: GOOD, user_id: 'u-2' }],
    ['no token', { password: GOOD }],
    ['a number for a password', { access_token: LINK, password: 12345678 }],
  ])('%s: 400 and nothing set', async (_l, body) => {
    const r = await post(route, body);
    expect(r.status).toBe(400);
    expect(f.updateUserById).not.toHaveBeenCalled();
  });

  it('is public and rate-limited per IP (5 a minute, 10 an hour) with the storefront throttlers only', () => {
    const handler = BuyerPasswordController.prototype.setPassword;
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBe(true);
    expect(Reflect.getMetadata(`THROTTLER:LIMIT${THROTTLER_NAMES.DEFAULT}`, handler)).toBe(5);
    expect(Reflect.getMetadata(`THROTTLER:TTL${THROTTLER_NAMES.DEFAULT}`, handler)).toBe(60_000);
    expect(Reflect.getMetadata(`THROTTLER:LIMIT${THROTTLER_NAMES.STOREFRONT_JOIN_IP}`, handler)).toBe(10);
    expect(Reflect.getMetadata(`THROTTLER:TTL${THROTTLER_NAMES.STOREFRONT_JOIN_IP}`, handler)).toBe(3_600_000);
    expect(Reflect.getMetadata(`THROTTLER:SKIP${THROTTLER_NAMES.AUTH_LOGIN_PER_MIN}`, handler)).toBe(true);
  });
});
