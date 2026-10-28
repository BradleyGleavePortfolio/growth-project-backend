/**
 * GC-1 — the guest pay page GET /p/:token over real HTTP: the real
 * PayPageController and StorefrontService on an in-memory Prisma double, the
 * production global-prefix exclude list and the real HttpExceptionFilter.
 * Covers the switch (off = the unmounted-route 404), route-level CSP and
 * headers, the closed 404 states, HTML escaping of coach text, no PII, one
 * token never showing another's package, and the amounts Elements is given
 * (the checkout's own chargeQuote: one-time, renewing, combo, trial interim),
 * and the page's own script: a failed attempt never spends the next one.
 */
import 'reflect-metadata';
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import * as vm from 'node:vm';
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
import { PAY_PAGE_COPY } from '../src/storefront/pay-page.html';

const A = 'tokAAAAAAAAAAAAAAAAAA';
const B = 'tokBBBBBBBBBBBBBBBBBB';
const COACH_EMAIL = 'sam.private@example.com';

function pkg(token: string, over: Record<string, unknown> = {}, coach: Record<string, unknown> = {}) {
  return {
    id: `pkg-${token}`,
    name: token === A ? 'Monthly coaching' : 'Other coach plan',
    description: 'Weekly check-in call\nTraining plan updated every week',
    amount_cents: 14900,
    currency: 'usd',
    billing_type: 'recurring',
    interval: 'month',
    interval_count: 1,
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
    ...over,
    coach: {
      id: `coach-${token}`,
      name: 'Sam',
      email: COACH_EMAIL,
      deletion_scheduled_at: null,
      deleted_at: null,
      profile: { avatar_url: null },
      coach_profile: { bio: 'Your training and food plan, adjusted every week.' },
      connect_account: {
        stripe_account_id: `acct_${token}`,
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
        disabled_reason: null,
      },
      ...coach,
    },
  };
}

type Res = { status: number; headers: http.IncomingHttpHeaders; body: string };

describe('GC-1 pay page GET /p/:token', () => {
  let app: INestApplication;
  let base = '';
  let rows: Record<string, ReturnType<typeof pkg>> = {};
  const env: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PayPageController],
      providers: [
        StorefrontService,
        {
          provide: PrismaService,
          useValue: {
            coachPackage: {
              findUnique: jest.fn(async ({ where }: { where: { share_token: string } }) => rows[where.share_token] ?? null),
            },
          },
        },
        { provide: StripeConnectApiService, useValue: {} },
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
    rows = { [A]: pkg(A), [B]: pkg(B) };
    env.GUEST_PAY_PAGE_ENABLED = 'true';
    env.STRIPE_PUBLISHABLE_KEY = 'pk_test_gc1';
  });

  const get = (path: string) =>
    new Promise<Res>((resolve, reject) => {
      http
        .get(`${base}${path}`, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        })
        .on('error', reject);
    });
  const cfgOf = (html: string) =>
    JSON.parse(/<script type="application\/json" id="cfg">(.*?)<\/script>/s.exec(html)?.[1] ?? 'null');

  it('switch off (unset or not exactly "true"): the same JSON 404 as an unmounted route, no page', async () => {
    for (const value of [undefined, 'false', 'TRUE', '1']) {
      env.GUEST_PAY_PAGE_ENABLED = value;
      const off = await get(`/p/${A}`);
      const unmounted = await get(`/q/${A}`);
      expect(off.status).toBe(404);
      expect(off.headers['content-security-policy']).toBeUndefined();
      const [o, u] = [JSON.parse(off.body), JSON.parse(unmounted.body)];
      expect(Object.keys(o).sort()).toEqual(Object.keys(u).sort());
      expect([o.message, o.error]).toEqual([`Cannot GET /p/${A}`, 'Not Found']);
    }
  });

  it('is served outside /api with the route-level CSP and private, no-index headers', async () => {
    const res = await get(`/p/${A}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    const csp = String(res.headers['content-security-policy']);
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1] ?? '';
    expect(nonce.length).toBeGreaterThanOrEqual(22);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com');
    expect(csp).toContain("connect-src 'self' https://api.stripe.com");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.headers['cache-control']).toBe('private, no-store');
    // Every executable script carries this response's nonce; a new nonce per load.
    const scripts = res.body.match(/<script[^>]*>/gi) ?? [];
    expect(scripts).toHaveLength(3);
    expect(scripts.filter((s) => !s.includes('application/json')).every((s) => s.includes(`nonce="${nonce}"`))).toBe(true);
    expect((await get(`/p/${A}`)).headers['content-security-policy']).not.toContain(nonce);
    expect((await get(`/api/p/${A}`)).status).toBe(404);
  });

  it.each([
    ['unpublished', { published_at: null }, {}, PAY_PAGE_COPY.notOffered],
    ['inactive', { is_active: false }, {}, PAY_PAGE_COPY.notOffered],
    ['share link off', { share_link_enabled: false }, {}, PAY_PAGE_COPY.notOffered],
    ['revoked link', { share_link_revoked_at: new Date() }, {}, PAY_PAGE_COPY.notOffered],
    ['not USD', { currency: 'eur' }, {}, PAY_PAGE_COPY.notOffered],
    ['coach not ready', {}, { connect_account: { stripe_account_id: 'acct_x', charges_enabled: false, payouts_enabled: true, details_submitted: true, disabled_reason: null } }, PAY_PAGE_COPY.notReady],
  ])('%s: a 404 page with the closed-state words and no package data', async (_label, over, coach, words) => {
    rows[A] = pkg(A, over, coach);
    const res = await get(`/p/${A}`);
    expect(res.status).toBe(404);
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.body).toContain(words.replace(/'/g, '&#39;'));
    expect(res.body).not.toContain('Monthly coaching');
    expect(res.body).not.toContain('<script');
  });

  it('unknown and malformed tokens get the same 404 page', async () => {
    for (const t of ['tokZZZZZZZZZZZZZZZZZZ', 'short', '%3Cscript%3E']) {
      const res = await get(`/p/${t}`);
      expect([res.status, res.body.includes(PAY_PAGE_COPY.notOffered)]).toEqual([404, true]);
    }
  });

  it('escapes every coach-supplied string and carries no PII', async () => {
    rows[A] = pkg(
      A,
      { name: '<img src=x onerror=alert(1)>', description: '"><svg onload=alert(1)>' },
      { name: '<b>Sam</b>', coach_profile: { bio: '</script><script>alert(1)</script>' }, profile: { avatar_url: 'javascript:alert(1)' } },
    );
    const res = await get(`/p/${A}`);
    expect(res.status).toBe(200);
    for (const raw of ['<img src=x', '<svg', '<b>Sam', '<script>alert', 'javascript:']) expect(res.body).not.toContain(raw);
    expect(res.body).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(res.body).toContain('&lt;b&gt;Sam&lt;/b&gt; on The Growth Project');
    expect(res.body).not.toContain(COACH_EMAIL);
    expect(res.body).not.toContain(`coach-${A}`);
  });

  it('one token never shows another token\'s package, coach account or key', async () => {
    const res = await get(`/p/${A}`);
    expect(res.body).toContain('Monthly coaching');
    expect(res.body).not.toContain('Other coach plan');
    expect(cfgOf(res.body)).toMatchObject({ token: A, obo: `acct_${A}`, pk: 'pk_test_gc1' });
    expect(res.body).not.toContain(B);
  });

  it('forwards a well-formed ?lp= and drops anything else', async () => {
    expect(cfgOf((await get(`/p/${A}?lp=clp0000000000000000000001`)).body).lp).toBe('clp0000000000000000000001');
    expect(cfgOf((await get(`/p/${A}?lp=%22%3E%3Cx`)).body).lp).toBeNull();
    expect((await get(`/p/${A}?resume=gc_1`)).status).toBe(200);
  });

  describe('amounts come from the checkout rule (Elements mode and amount match the intent)', () => {
    beforeAll(() =>
      jest.useFakeTimers({
        now: new Date('2026-01-31T12:00:00Z'),
        doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'queueMicrotask', 'hrtime', 'performance'],
      }),
    );
    afterAll(() => jest.useRealTimers());

    it.each([
      ['one-time', { billing_type: 'one_time', interval: null, amount_cents: 9900 }, 'payment', 9900, ['$99.00 once', 'Pay $99.00'], ['Next charge']],
      ['renewing', {}, 'subscription', 14900, ['$149.00 a month', 'February 28, 2026', 'You pay $149.00 today for your first month.', 'Subscribe for $149.00 a month', 'Renews automatically at $149.00 a month'], []],
      [
        'combo',
        { billing_type: 'one_time', interval: null, amount_cents: 10000, recurring_amount_cents: 14900, recurring_interval: 'month', recurring_interval_count: 3 },
        'subscription',
        24900,
        ['$149.00 every 3 months, plus $100.00 once', 'April 30, 2026', 'You pay $249.00 today: $100.00 once plus your first 3 months at $149.00.', 'Subscribe, pay $249.00 today'],
        [],
      ],
      ['trial (#GC-TRIAL interim: paid today)', { trial_days: 14 }, 'subscription', 14900, ['You pay $149.00 today', 'Subscribe for $149.00 a month'], ['trial', 'Free']],
    ])('%s', async (_label, over, mode, amount, shown, hidden) => {
      rows[A] = pkg(A, over);
      const res = await get(`/p/${A}`);
      expect(cfgOf(res.body)).toMatchObject({ mode, amount });
      expect(res.body).toContain(`<strong>$${(amount / 100).toFixed(2)}</strong>`);
      for (const s of shown) expect(res.body).toContain(s);
      for (const s of hidden) expect(res.body).not.toContain(s);
    });

    // #GC-CANCEL-WORDS op 1: the amount in the renewal line is each package's own
    // server-computed recurring price and period (never a literal, never due today).
    it('the renewal line carries each package\'s own recurring price and period', async () => {
      const C = 'tokCCCCCCCCCCCCCCCCCC';
      const line = (each: string) =>
        `Renews automatically at ${each} until you cancel. Cancel anytime in the TGP Fitness app, under Your plans; you keep the plan until the end of the period you paid for.`;
      rows[B] = pkg(B, { billing_type: 'one_time', interval: null, amount_cents: 10000, recurring_amount_cents: 8900, recurring_interval: 'week', recurring_interval_count: 2 });
      rows[C] = pkg(C, { amount_cents: 120000, interval: 'year' });
      const terms = async (t: string) => /<p class="terms">(.*?)<\/p>/.exec((await get(`/p/${t}`)).body)?.[1];
      expect(await terms(A)).toBe(line('$149.00 a month'));
      expect(await terms(B)).toBe(line('$89.00 every 2 weeks'));
      expect(await terms(C)).toBe(line('$1,200.00 a year'));
    });
  });

  // The page's own script, run with stand-ins for the DOM, Stripe.js and
  // fetch. The server treats a failed attempt's idempotency key as spent
  // (guest-checkout replayExistingIntent: "expired"), so every failed attempt
  // must make the next tap send a new key; a paid attempt keeps it (a second
  // tap replays the same checkout and can never charge twice).
  describe('paying again after a failed attempt', () => {
    async function boot(answers: { checkout: boolean[]; confirm: boolean[] }) {
      const html = (await get(`/p/${A}`)).body;
      const js = [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].pop()?.[1] ?? '';
      const on: Record<string, (e: unknown) => Promise<void>> = {};
      const nodes: Record<string, Record<string, unknown>> = {};
      for (const id of ['cfg', 'pay', 'go', 'msg', 'nm', 'ph', 'em', 'or', 'express']) {
        nodes[id] = { value: '', textContent: id === 'cfg' ? JSON.stringify(cfgOf(html)) : '', setAttribute() {}, focus() {}, addEventListener: (t: string, h: never) => (on[`${id}:${t}`] = h) };
      }
      const store = new Map<string, string>();
      const keys: string[] = [];
      const sandbox: Record<string, unknown> = {
        document: { getElementById: (id: string) => nodes[id] },
        addEventListener() {},
        location: { origin: 'https://app.example' },
        crypto: { randomUUID },
        sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
        fetch: async (_url: string, init: { body: string }) => {
          keys.push(JSON.parse(init.body).idempotency_key);
          const ok = answers.checkout.shift() ?? true;
          return { ok, json: async () => (ok ? { client_secret: 'pi_1_secret_1' } : { message: 'This checkout link has expired. Please request a new one.' }) };
        },
        Stripe: () => ({
          elements: () => ({ create: (type: string) => ({ on: (t: string, h: never) => (on[`${type}:${t}`] = h), mount() {} }), submit: async () => ({}) }),
          confirmPayment: async () => ((answers.confirm.shift() ?? true) ? {} : { error: { message: 'Your card was declined.' } }),
        }),
      };
      sandbox.window = sandbox;
      vm.runInNewContext(js, sandbox);
      Object.assign(nodes.nm, { value: 'Ann Buyer' });
      Object.assign(nodes.ph, { value: '415 555 0100' });
      Object.assign(nodes.em, { value: 'ann@example.com' });
      const tap = {
        card: () => on['pay:submit']({ preventDefault() {} }),
        wallet: () => on['expressCheckout:confirm']({ billingDetails: { name: 'Ann Buyer', email: 'ann@example.com' }, paymentFailed() {} }),
      };
      return { tap, keys, msg: () => nodes.msg.textContent };
    }

    it.each([
      ['card form', 'the card is declined', 'card', { checkout: [true, true], confirm: [false, true] }, 'Your card was declined.'],
      ['card form', 'the checkout is refused', 'card', { checkout: [false, true], confirm: [true] }, 'This checkout link has expired. Please request a new one.'],
      ['wallet', 'the card is declined', 'wallet', { checkout: [true, true], confirm: [false, true] }, 'Your card was declined.'],
      ['wallet', 'the checkout is refused', 'wallet', { checkout: [false, true], confirm: [true] }, 'This checkout link has expired. Please request a new one.'],
    ] as const)('%s: when %s, the next tap starts a fresh checkout', async (_label, _why, via, answers, shown) => {
      const page = await boot({ checkout: [...answers.checkout], confirm: [...answers.confirm] });
      await page.tap[via]();
      expect(page.msg()).toBe(shown);
      await page.tap[via]();
      expect(page.keys).toHaveLength(2);
      expect(page.keys[1]).not.toBe(page.keys[0]);
    });

    it('a paid attempt keeps its key, so a second tap replays it and never charges twice', async () => {
      const page = await boot({ checkout: [true, true], confirm: [true, true] });
      await page.tap.card();
      await page.tap.wallet();
      expect(page.keys).toHaveLength(2);
      expect(page.keys[1]).toBe(page.keys[0]);
    });
  });

  // GUEST-ELIGIBILITY: the same page script with the code-step nodes too.
  // `checkout` scripts each checkout answer: 'pay' (client_secret) or 'code'
  // (403 BUYER_CODE_REQUIRED, the server's answer for a TGP email with no proof).
  type Answers = {
    checkout: Array<'pay' | 'code'>;
    account?: 'new' | 'existing';
    verify?: { status: number; body: Record<string, unknown> };
  };
  const CODE_REQUIRED = { error: 'BUYER_CODE_REQUIRED', message: 'This email already has a TGP account. Enter the code we emailed you to keep going.' };
  async function bootPage(answers: Answers, email = 'ann@example.com') {
    const html = (await get(`/p/${A}`)).body;
    const js = [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].pop()?.[1] ?? '';
    const on: Record<string, (e: unknown) => Promise<void>> = {};
    const nodes: Record<string, Record<string, unknown>> = {};
    const kinds = ['no_coach', 'same_coach'].map((k) => ({ k, hidden: false, getAttribute: () => k }));
    const ids = ['cfg', 'pay', 'go', 'msg', 'nm', 'ph', 'em', 'or', 'express', 'f2', 'b2', 'm2', 'cd', 'rs', 'ch', 's3', 'hey', 'sum', 'to', 'inc0'];
    for (const id of ids) {
      nodes[id] = {
        value: '', hidden: ['f2', 's3', 'sum'].includes(id), textContent: id === 'cfg' ? JSON.stringify(cfgOf(html)) : '',
        setAttribute() {}, focus() {}, querySelectorAll: () => kinds,
        addEventListener: (t: string, h: never) => (on[`${id}:${t}`] = h),
      };
    }
    const bodies: Record<string, unknown>[] = [];
    const calls: string[] = [];
    const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
    const sandbox: Record<string, unknown> = {
      document: { getElementById: (id: string) => nodes[id] },
      addEventListener() {},
      setTimeout: (fn: () => void) => fn(),
      location: { origin: 'https://app.example' },
      crypto: { randomUUID },
      sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      fetch: async (url: string, init: { body: string }) => {
        const body = JSON.parse(init.body);
        const route = url.split('/checkout')[1] || 'checkout';
        calls.push(route);
        bodies.push({ route, ...body });
        if (route === '/check-email') return reply(200, { account: answers.account ?? 'existing' });
        if (route === '/verify-code') return reply(answers.verify?.status ?? 200, answers.verify?.body ?? {});
        return (answers.checkout.shift() ?? 'pay') === 'code' ? reply(403, CODE_REQUIRED) : reply(200, { client_secret: 'pi_1_secret_1' });
      },
      Stripe: () => ({
        elements: () => ({ create: (type: string) => ({ on: (t: string, h: never) => (on[`${type}:${t}`] = h), mount() {} }), submit: async () => ({}) }),
        confirmPayment: async () => ({}),
      }),
    };
    sandbox.window = sandbox;
    vm.runInNewContext(js, sandbox);
    Object.assign(nodes.nm, { value: 'Ann Buyer' });
    Object.assign(nodes.ph, { value: '415 555 0100' });
    Object.assign(nodes.em, { value: email });
    const flush = () => new Promise((r) => setImmediate(r));
    const tap = {
      card: async () => {
        await on['pay:submit']({ preventDefault() {} });
        await flush();
      },
      wallet: async (walletEmail = email) => {
        await on['expressCheckout:confirm']({ billingDetails: { name: 'Ann Buyer', email: walletEmail }, paymentFailed() {} });
        await flush();
      },
      code: async (code: string) => {
        Object.assign(nodes.cd, { value: code });
        await on['f2:submit']({ preventDefault() {} });
        await flush();
      },
      otherEmail: () => on['ch:click']({}),
      resend: async () => {
        await on['rs:click']({});
        await flush();
      },
    };
    const checkouts = () => bodies.filter((b) => b.route === 'checkout');
    return { tap, bodies, checkouts, calls, nodes, kinds, msg: () => nodes.msg.textContent };
  }

  describe('GUEST-ELIGIBILITY: one payment form; a TGP email gets the code, Welcome Back and its summary before it pays', () => {
    it('renders the payment form as GC-PHONE has it, with the code step and summary hidden above it, both summaries server-escaped', async () => {
      rows[A] = pkg(A, {}, { name: '<b>Sam</b>' });
      const html = (await get(`/p/${A}`)).body;
      expect(html).toMatch(/<form id="pay" class="card">/);
      expect(html.indexOf('id="f2"')).toBeLessThan(html.indexOf('id="pay"'));
      expect(html.indexOf('id="s3"')).toBeLessThan(html.indexOf('id="pay"'));
      for (const id of ['f2', 's3', 'sum']) expect(html).toMatch(new RegExp(`id="${id}"[^>]*hidden`));
      expect(html).toContain(PAY_PAGE_COPY.appChange('&lt;b&gt;Sam&lt;/b&gt;'));
      expect(html).toContain(PAY_PAGE_COPY.oneCoach('&lt;b&gt;Sam&lt;/b&gt;'));
      expect(html).not.toContain('<b>Sam</b>');
      expect(cfgOf(html).copy.hey).toBe('Hey {N}, Welcome Back!');
    });

    it.each(['card', 'wallet'] as const)('new email (%s): no check and no code, it pays at once (#170-2)', async (via) => {
      const page = await bootPage({ checkout: ['pay'], account: 'new' }, 'new@example.com');
      await page.tap[via]();
      expect(page.calls).toEqual(['checkout']);
      expect(page.checkouts()[0]).toMatchObject({ guest_email: 'new@example.com' });
      expect(page.checkouts()[0]).not.toHaveProperty('buyer_token');
      expect(page.nodes.f2.hidden).toBe(true);
    });

    it.each([
      ['no coach', 'no_coach', [false, true]],
      ['client of this coach', 'same_coach', [true, false]],
    ] as const)('existing email, %s: code, "Hey Ann, Welcome Back!", that summary over the form, then pay with the proof (#169-8)', async (_l, summary, hiddenKinds) => {
      const page = await bootPage({ checkout: ['code', 'pay'], verify: { status: 200, body: { verified: true, first_name: 'Ann', summary, buyer_token: 'proof-1' } } });
      await page.tap.card();
      expect(page.calls).toEqual(['checkout', '/check-email']);
      expect(page.bodies[1]).toMatchObject({ guest_email: 'ann@example.com' });
      expect(page.nodes.f2.hidden).toBe(false);
      expect(page.nodes.pay.hidden).toBe(true);
      expect(page.nodes.to.textContent).toBe('ann@example.com');
      expect(page.msg()).toBe('');
      await page.tap.code('12 34');
      expect(page.nodes.m2.textContent).toBe(PAY_PAGE_COPY.badCode);
      expect(page.calls).toEqual(['checkout', '/check-email']);
      await page.tap.code('123456');
      expect(page.nodes.hey.textContent).toBe('Hey Ann, Welcome Back!');
      expect(page.nodes.hey.hidden).toBe(true);
      expect(page.nodes.sum.hidden).toBe(false);
      expect(page.kinds.map((k) => k.hidden)).toEqual(hiddenKinds);
      expect(page.nodes.inc0.hidden).toBe(true);
      expect(page.nodes.f2.hidden).toBe(true);
      expect(page.nodes.pay.hidden).toBe(false);
      await page.tap.card();
      expect(page.calls).toEqual(['checkout', '/check-email', '/verify-code', 'checkout']);
      expect(page.checkouts()[1]).toMatchObject({ guest_email: 'ann@example.com', guest_phone: '415 555 0100', buyer_token: 'proof-1' });
    });

    it("a wallet buyer with a TGP email: the wallet's email gets the code, and the next wallet tap carries the proof", async () => {
      const page = await bootPage({ checkout: ['code', 'pay'], verify: { status: 200, body: { verified: true, first_name: 'Ann', summary: 'no_coach', buyer_token: 'proof-w' } } }, 'typed@example.com');
      await page.tap.wallet('wallet@example.com');
      expect(page.calls).toEqual(['checkout', '/check-email']);
      expect(page.bodies[1]).toMatchObject({ guest_email: 'wallet@example.com' });
      expect(page.nodes.to.textContent).toBe('wallet@example.com');
      await page.tap.code('123456');
      expect(page.bodies[2]).toMatchObject({ route: '/verify-code', guest_email: 'wallet@example.com', code: '123456' });
      await page.tap.wallet('wallet@example.com');
      expect(page.checkouts()[1]).toMatchObject({ guest_email: 'wallet@example.com', buyer_token: 'proof-w' });
    });

    it.each([
      ['client of another coach', 'BUYER_HAS_COACH', 'Your account already has a coach. To change coaches, contact support from Settings.'],
      ['coach account', 'BUYER_NOT_CLIENT', 'This email belongs to a coach account, so it can’t buy a coaching package. Use a different email.'],
    ])('%s: the refusal shows after the code and the payment form stays closed', async (_l, error, message) => {
      const page = await bootPage({ checkout: ['code'], verify: { status: 409, body: { error, message } } });
      await page.tap.card();
      await page.tap.code('123456');
      expect(page.nodes.m2.textContent).toBe(message);
      expect(page.nodes.pay.hidden).toBe(true);
      expect(page.nodes.b2.hidden).toBe(true);
      expect(page.nodes.rs.hidden).toBe(true);
      expect(page.calls).toEqual(['checkout', '/check-email', '/verify-code']);
    });

    it('"Use a different email" reopens the payment form; a new email then pays with no proof', async () => {
      const page = await bootPage({ checkout: ['code', 'pay'] });
      await page.tap.card();
      page.tap.otherEmail();
      expect(page.nodes.f2.hidden).toBe(true);
      expect(page.nodes.pay.hidden).toBe(false);
      Object.assign(page.nodes.em, { value: 'other@example.com' });
      await page.tap.card();
      expect(page.checkouts()[1]).toMatchObject({ guest_email: 'other@example.com' });
      expect(page.checkouts()[1]).not.toHaveProperty('buyer_token');
    });

    it('"Send a new code" sends one for the same email', async () => {
      const page = await bootPage({ checkout: ['code'] });
      await page.tap.card();
      await page.tap.resend();
      expect(page.calls).toEqual(['checkout', '/check-email', '/check-email']);
      expect(page.nodes.m2.textContent).toBe(PAY_PAGE_COPY.resent);
    });

    it('proof expired at payment (403 BUYER_CODE_REQUIRED again): back to the code step, a new code is sent', async () => {
      const page = await bootPage({ checkout: ['code', 'code'], verify: { status: 200, body: { verified: true, first_name: '', summary: 'no_coach', buyer_token: 'old' } } });
      await page.tap.card();
      await page.tap.code('123456');
      expect(page.nodes.hey.textContent).toBe('Welcome Back!');
      await page.tap.card();
      expect(page.calls).toEqual(['checkout', '/check-email', '/verify-code', 'checkout', '/check-email']);
      expect(page.checkouts()[1]).toMatchObject({ buyer_token: 'old' });
      expect(page.nodes.f2.hidden).toBe(false);
      expect(page.nodes.pay.hidden).toBe(true);
      expect(page.nodes.sum.hidden).toBe(true);
    });
  });

  describe('GUEST-ELIGIBILITY: the confirm-and-download state (/p/:token?confirmed=1)', () => {
    it('serves the confirm page with the CSP, App Store link and login email; off means 404', async () => {
      const res = await get(`/p/${A}?confirmed=1`);
      expect(res.status).toBe(200);
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.body).toContain(PAY_PAGE_COPY.confirmedH);
      expect(res.body).toContain('<a class="btn" href="https://apps.apple.com/app/id6765847915">Download on the App Store</a>');
      expect(res.body).toContain(`<strong id="le">${PAY_PAGE_COPY.loginEmailUnknown}</strong>`);
      expect(res.body).not.toContain('Monthly coaching');
      env.GUEST_PAY_PAGE_ENABLED = undefined;
      expect((await get(`/p/${A}?confirmed=1`)).status).toBe(404);
    });

    async function land(hash: string) {
      const html = (await get(`/p/${A}?confirmed=1`)).body;
      const js = [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].pop()?.[1] ?? '';
      const nodes: Record<string, Record<string, unknown>> = { ok: { hidden: false }, gone: { hidden: true }, le: { textContent: 'the email you paid with' } };
      const replaced: string[] = [];
      vm.runInNewContext(js, {
        document: { getElementById: (id: string) => nodes[id] },
        location: { hash, pathname: `/p/${A}`, search: '?confirmed=1' },
        history: { replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) },
        URLSearchParams, atob: (b: string) => Buffer.from(b, 'base64').toString('latin1'), escape, decodeURIComponent,
      });
      return { nodes, replaced };
    }

    it('shows the email from the confirmed session and drops the token from the address bar', async () => {
      const payload = Buffer.from(JSON.stringify({ email: 'ann@example.com', sub: 'u1' })).toString('base64url');
      const { nodes, replaced } = await land(`#access_token=h.${payload}.s&type=invite`);
      expect(nodes.le.textContent).toBe('ann@example.com');
      expect(nodes.gone.hidden).toBe(true);
      expect(replaced).toEqual([`/p/${A}?confirmed=1`]);
    });

    it('an expired or used link shows the run-out state', async () => {
      const { nodes } = await land('#error=access_denied&error_code=otp_expired');
      expect([nodes.ok.hidden, nodes.gone.hidden]).toEqual([true, false]);
    });
  });
});
