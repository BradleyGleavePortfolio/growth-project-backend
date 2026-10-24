/**
 * GC-2 — the web payment return page GET /p/:token/done over real HTTP: the
 * real PayPageController on in-memory Prisma and Stripe doubles, the
 * production global-prefix exclude list and the real HttpExceptionFilter.
 * Stripe sends every buyer (card or wallet) here. Covers the switch, the
 * headers, each state (paid for a new and an existing buyer, still
 * confirming and its self-refresh, failed with the reason, cancelled), the
 * ownership checks (token, client secret, intent id), Stripe being down,
 * escaping, that the page only reads, and the one return_url helper.
 */
import 'reflect-metadata';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { HttpExceptionFilter } from '../src/filters/http-exception.filter';
import { LANDING_PUBLIC_PREFIX_EXCLUDE } from '../src/landing-pages/public-route-prefix';
import { PrismaService } from '../src/prisma.service';
import { StripeConnectApiService } from '../src/connect/stripe-connect-api.service';
import { StorefrontService } from '../src/storefront/storefront.service';
import { PayPageController } from '../src/storefront/pay-page.controller';
import { PAY_PAGE_COPY, esc } from '../src/storefront/pay-page.html';
import { PAY_DONE_COPY } from '../src/storefront/pay-done.html';
import { PAY_DONE_MAX_CHECKS } from '../src/storefront/pay-done';
import { payDoneUrl } from '../src/storefront/storefront-links';

const A = 'tokAAAAAAAAAAAAAAAAAA';
const B = 'tokBBBBBBBBBBBBBBBBBB';
const PI = 'pi_3TestAAAAAAAAAAAA';
const SECRET = `${PI}_secret_good1234`;
const EMAIL = 'jo.buyer@example.com';
const LP = 'clp0000000000000000000001';
const ROW_AT = new Date('2026-10-24T12:00:00Z');

type Res = { status: number; headers: http.IncomingHttpHeaders; body: string };
type Pi = { id: string; client_secret: string; status: string; amount: number; last_payment_error: { message?: string } | null };

function pkg(token: string) {
  return {
    id: `pkg-${token}`,
    name: 'Monthly coaching',
    description: 'Weekly check-in call',
    amount_cents: 14900,
    currency: 'usd',
    billing_type: 'one_time',
    interval: null,
    interval_count: null,
    recurring_amount_cents: null,
    recurring_interval: null,
    recurring_interval_count: null,
    trial_days: 0,
    is_active: true,
    archived_at: null,
    published_at: new Date('2026-01-01'),
    share_token: token,
    share_link_enabled: true,
    share_link_expires_at: null,
    share_link_revoked_at: null,
    coach: {
      id: `coach-${token}`,
      name: 'Sam',
      email: 'sam.private@example.com',
      deletion_scheduled_at: null,
      deleted_at: null,
      profile: { avatar_url: null },
      coach_profile: { bio: null },
      connect_account: {
        stripe_account_id: `acct_${token}`,
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
        disabled_reason: null,
      },
    },
  };
}

describe('GC-2 return page GET /p/:token/done', () => {
  let app: INestApplication;
  let base = '';
  const env: Record<string, string | undefined> = {};
  let checkouts: Record<string, { guest_email: string; created_at: Date; package: { share_token: string; name: string; coach: { name: string } } }> = {};
  let users: Array<{ email: string; created_at: Date }> = [];
  let pis: Record<string, Pi> = {};
  let stripeDown = false;
  const retrieve = jest.fn(async (id: string) => {
    if (stripeDown || !pis[id]) throw new Error('stripe unavailable');
    return pis[id];
  });
  const findUnique = jest.fn(async ({ where }: { where: { stripe_payment_intent_id: string } }) => checkouts[where.stripe_payment_intent_id] ?? null);
  const findFirst = jest.fn(async ({ where }: { where: { email: { equals: string } } }) =>
    users.find((u) => u.email.toLowerCase() === where.email.equals.toLowerCase()) ?? null,
  );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PayPageController],
      providers: [
        StorefrontService,
        {
          // Reads only: no create/update/upsert/delete exists on this double.
          provide: PrismaService,
          useValue: {
            guestCheckout: { findUnique },
            user: { findFirst },
            coachPackage: { findUnique: jest.fn(async ({ where }: { where: { share_token: string } }) => (where.share_token === A ? pkg(A) : null)) },
          },
        },
        { provide: StripeConnectApiService, useValue: { retrievePaymentIntent: retrieve } },
        { provide: ConfigService, useValue: { get: (k: string) => env[k] } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api', { exclude: [...LANDING_PUBLIC_PREFIX_EXCLUDE] });
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    stripeDown = false;
    env.GUEST_PAY_PAGE_ENABLED = 'true';
    env.STRIPE_PUBLISHABLE_KEY = 'pk_test_gc2';
    env.STOREFRONT_BASE_URL = undefined;
    env.APP_STORE_URL = undefined;
    checkouts = { [PI]: { guest_email: EMAIL, created_at: ROW_AT, package: { share_token: A, name: 'Monthly coaching', coach: { name: 'Sam' } } } };
    users = [];
    pis = { [PI]: { id: PI, client_secret: SECRET, status: 'succeeded', amount: 14900, last_payment_error: null } };
  });

  const get = (p: string) =>
    new Promise<Res>((resolve, reject) => {
      http
        .get(`${base}${p}`, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        })
        .on('error', reject);
    });
  const done = (extra = '', token = A, pi = PI, secret = SECRET) =>
    get(`/p/${token}/done?payment_intent=${pi}&payment_intent_client_secret=${secret}&redirect_status=succeeded${extra}`);
  const words = (s: string) => esc(s);

  it('switch off: the same JSON 404 as an unmounted route, and nothing is read', async () => {
    for (const value of [undefined, 'false', 'TRUE']) {
      env.GUEST_PAY_PAGE_ENABLED = value;
      const off = await done();
      const unmounted = await get(`/q/${A}/done`);
      expect(off.status).toBe(404);
      expect(off.headers['content-security-policy']).toBeUndefined();
      expect(Object.keys(JSON.parse(off.body)).sort()).toEqual(Object.keys(JSON.parse(unmounted.body)).sort());
      expect(JSON.parse(off.body).message).toBe(`Cannot GET /p/${A}/done?payment_intent=${PI}&payment_intent_client_secret=${SECRET}&redirect_status=succeeded`);
    }
    expect(findUnique).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('paid, new buyer: what happens next (confirm email, the app, the password), the pay page headers, no script', async () => {
    const res = await done();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toContain('unsafe');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.headers.refresh).toBeUndefined();
    expect(res.body).not.toMatch(/<script/i);
    expect(res.body).toContain(PAY_DONE_COPY.paidH);
    expect(res.body).toContain(words(PAY_DONE_COPY.paidLine('$149.00', 'Monthly coaching', 'Sam')));
    expect(res.body).toContain(words(PAY_DONE_COPY.stepEmail(EMAIL)));
    expect(res.body).toContain(PAY_DONE_COPY.stepApp);
    expect(res.body).toContain(words(PAY_PAGE_COPY.setPassword));
    expect(res.body).toContain(`<a class="btn" href="https://apps.apple.com/app/id6765847915">${PAY_PAGE_COPY.appStore}</a>`);
    expect(res.body).not.toContain(PAY_DONE_COPY.existingNext);
    expect(retrieve).toHaveBeenCalledWith(PI);
  });

  it('paid: an account from before this checkout is an existing buyer; one made by the conversion is new', async () => {
    users = [{ email: 'Jo.Buyer@Example.com', created_at: new Date('2025-03-01') }];
    const existing = await done();
    expect(existing.body).toContain(PAY_DONE_COPY.existingNext);
    expect(existing.body).not.toContain(words(PAY_DONE_COPY.stepEmail(EMAIL)));
    expect(existing.body).toContain(PAY_PAGE_COPY.appStore);
    users = [{ email: EMAIL, created_at: new Date(ROW_AT.getTime() + 60_000) }];
    expect((await done()).body).toContain(words(PAY_DONE_COPY.stepEmail(EMAIL)));
    env.APP_STORE_URL = 'javascript:alert(1)';
    expect((await done()).body).toContain('href="https://apps.apple.com/app/id6765847915"');
  });

  it('still confirming: refreshes itself every few seconds, then says what to do', async () => {
    pis[PI].status = 'processing';
    const first = await done();
    expect(first.status).toBe(200);
    expect(first.body).toContain(PAY_DONE_COPY.confirmingH);
    expect(first.body).not.toContain(PAY_DONE_COPY.paidH);
    expect(first.headers.refresh).toBe(
      `3; url=/p/${A}/done?payment_intent=${PI}&payment_intent_client_secret=${SECRET}&n=1`,
    );
    expect((await done(`&n=${PAY_DONE_MAX_CHECKS - 1}&lp=${LP}`)).headers.refresh).toBe(
      `3; url=/p/${A}/done?payment_intent=${PI}&payment_intent_client_secret=${SECRET}&lp=${LP}&n=${PAY_DONE_MAX_CHECKS}`,
    );
    expect((await done('&n=abc')).headers.refresh).toMatch(/&n=1$/);
    const last = await done(`&n=${PAY_DONE_MAX_CHECKS}`);
    expect(last.headers.refresh).toBeUndefined();
    expect(last.body).toContain(PAY_DONE_COPY.slowH);
    expect(last.body).toContain(words(PAY_DONE_COPY.slow(EMAIL)));
    expect(last.body).toContain(
      `<a class="link" href="/p/${A}/done?payment_intent=${PI}&amp;payment_intent_client_secret=${SECRET}&amp;n=0">${PAY_DONE_COPY.checkAgain}</a>`,
    );
    expect((await done('&n=99')).headers.refresh).toBeUndefined();
  });

  it('failed: the reason from Stripe and a way back to the pay page (keeping ?lp=)', async () => {
    pis[PI] = { ...pis[PI], status: 'requires_payment_method', last_payment_error: { message: 'Your card was declined. <b>' } };
    const res = await done(`&lp=${LP}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain(PAY_DONE_COPY.failedH);
    expect(res.body).toContain('Your card was declined. &lt;b&gt;');
    expect(res.body).toContain(PAY_DONE_COPY.failedNothing);
    expect(res.body).toContain(`<a class="btn" href="https://app.trygrowthproject.com/p/${A}?lp=${LP}">${PAY_DONE_COPY.tryAgain}</a>`);
    expect(res.body).not.toContain(PAY_DONE_COPY.paidH);
    for (const status of ['requires_action', 'requires_confirmation']) {
      pis[PI] = { ...pis[PI], status, last_payment_error: null };
      const r = await done('&lp=%22%3E%3Cx');
      expect(r.body).toContain(words(PAY_DONE_COPY.failedReason));
      expect(r.body).toContain(`href="https://app.trygrowthproject.com/p/${A}"`);
    }
  });

  it('cancelled: nothing charged, back to the pay page', async () => {
    pis[PI].status = 'canceled';
    const res = await done();
    expect(res.status).toBe(200);
    expect(res.body).toContain(PAY_DONE_COPY.cancelledH);
    expect(res.body).toContain(`<a class="btn" href="https://app.trygrowthproject.com/p/${A}">${PAY_DONE_COPY.backToPay}</a>`);
  });

  it('the query alone is never trusted: wrong token, secret or intent all get the calm 404 page', async () => {
    const cases: Array<[string, () => Promise<Res>, boolean]> = [
      ['no query', () => get(`/p/${A}/done`), false],
      ['bad intent id', () => done('', A, 'pi_x"<'), false],
      ['secret of another intent', () => done('', A, PI, 'pi_3OtherAAAAAAAAAAA_secret_good1234'), false],
      ['malformed token', () => done('', 'short'), false],
      ['unknown intent', () => done('', A, 'pi_3UnknownAAAAAAAAA', 'pi_3UnknownAAAAAAAAA_secret_x'), false],
      ["another token's checkout", () => done('', B), false],
      ['wrong secret, right prefix', () => done('', A, PI, `${PI}_secret_bad12345`), true],
      ['shorter secret', () => done('', A, PI, `${PI}_secret_g`), true],
    ];
    for (const [label, call, reachesStripe] of cases) {
      retrieve.mockClear();
      const res = await call();
      expect([label, res.status]).toEqual([label, 404]);
      expect(res.body).toContain(words(PAY_DONE_COPY.unknown));
      expect(res.body).not.toContain(EMAIL);
      expect(res.body).not.toContain('Monthly coaching');
      expect([label, retrieve.mock.calls.length]).toEqual([label, reachesStripe ? 1 : 0]);
    }
    pis[PI] = { ...pis[PI], id: 'pi_3SomethingElseAAAA' };
    expect((await done()).status).toBe(404);
  });

  it('Stripe down: a calm 503 page that says to reload, no buyer data', async () => {
    stripeDown = true;
    const res = await done();
    expect(res.status).toBe(503);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body).toContain(words(PAY_DONE_COPY.unavailable));
    expect(res.body).not.toContain(EMAIL);
  });

  it('escapes the buyer email, package and coach names', async () => {
    checkouts[PI] = { guest_email: '"><img src=x>@example.com', created_at: ROW_AT, package: { share_token: A, name: '<svg onload=alert(1)>', coach: { name: '<b>Sam</b>' } } };
    const res = await done();
    for (const raw of ['<img src=x', '<svg', '<b>Sam']) expect(res.body).not.toContain(raw);
    expect(res.body).toContain('&lt;svg onload=alert(1)&gt;');
    expect(res.body).toContain('&lt;b&gt;Sam&lt;/b&gt;');
  });

  it('safe to open twice: the same page, read-only, one Stripe read per load', async () => {
    const strip = (s: string) => s.replace(/nonce="[^"]+"/g, '');
    const [one, two] = [await done(), await done()];
    expect(strip(one.body)).toBe(strip(two.body));
    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('the pay page hands Stripe the one return_url helper: payDoneUrl, card and wallet alike', async () => {
    const cfg = (html: string) => JSON.parse(/<script type="application\/json" id="cfg">(.*?)<\/script>/s.exec(html)?.[1] ?? 'null');
    expect(cfg((await get(`/p/${A}`)).body).ret).toBe(`https://app.trygrowthproject.com/p/${A}/done`);
    env.STOREFRONT_BASE_URL = 'https://staging.example.com/';
    const page = (await get(`/p/${A}?lp=${LP}`)).body;
    expect(cfg(page).ret).toBe(`https://staging.example.com/p/${A}/done?lp=${LP}`);
    expect(page).toContain('return_url:c.ret');
    expect(page).not.toContain("'/done'");
    expect(payDoneUrl(undefined, 'a/b c')).toBe('https://app.trygrowthproject.com/p/a%2Fb%20c/done');
    expect(payDoneUrl('https://x.example.com', A, null)).toBe(`https://x.example.com/p/${A}/done`);
  });

  it('/p/<token>/done is answered here, not by the landing route: StorefrontModule is imported before LandingPagesModule', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/app.module.ts'), 'utf8');
    const imports = src.slice(src.indexOf('imports: ['));
    expect(imports.indexOf('StorefrontModule,')).toBeGreaterThan(-1);
    expect(imports.indexOf('StorefrontModule,')).toBeLessThan(imports.indexOf('LandingPagesModule,'));
  });
});
