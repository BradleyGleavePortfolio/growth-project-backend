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
import { APP_STORE_URL_DEFAULT, PAY_PAGE_COPY, esc } from '../src/storefront/pay-page.html';
import { renderPayDonePage } from '../src/storefront/pay-done.html';

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
      // GC-3 (#GC-TRIAL op 1): the trial runs on the web page — card saved
      // (Elements setup mode), nothing due today, PF-W5 / PF-W6.
      ['trial (GC-3: nothing charged today)', { trial_days: 14 }, 'setup', 0, ['Nothing is charged today. Your first charge of $149.00 is on Feb 14.', 'Start free trial', 'February 14, 2026'], ['You pay', 'Subscribe for']],
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
  // WEB-BUYER-FLOW (#172-8): the page script in a stub DOM. `account` is
  // check-email's answer at step 1; `checkout` scripts each checkout answer:
  // 'pay' (client_secret), 'code' (403 BUYER_CODE_REQUIRED, the server's
  // answer for a TGP email with no proof) or 'refuse' (400 with a message);
  // `confirm` scripts stripe.confirmPayment (false = declined).
  type Answers = {
    account?: 'new' | 'existing' | 'fail';
    checkout?: Array<'pay' | 'code' | 'refuse'>;
    confirm?: boolean[];
    verify?: { status: number; body: Record<string, unknown> };
    noStripe?: boolean;
  };
  const CODE_REQUIRED = { error: 'BUYER_CODE_REQUIRED', message: 'This email already has a TGP account. Enter the code we emailed you to keep going.' };
  const REFUSED = { message: 'This checkout link has expired. Please request a new one.' };
  async function bootPage(answers: Answers = {}) {
    const html = (await get(`/p/${A}`)).body;
    const js = [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].pop()?.[1] ?? '';
    const on: Record<string, (e: unknown) => Promise<void>> = {};
    const nodes: Record<string, Record<string, unknown>> = {};
    const kinds = ['no_coach', 'same_coach'].map((k) => ({ k, hidden: false, getAttribute: () => k }));
    const ids = ['cfg', 'f1', 'e1', 'b1', 'm1', 'pay', 'go', 'msg', 'nm', 'ph', 'pe', 'ce', 'or', 'express', 'f2', 'b2', 'm2', 'cd', 'rs', 'ch', 's3', 'hey', 'sum', 'to', 'inc0'];
    for (const id of ids) {
      nodes[id] = {
        value: '', hidden: ['f2', 's3', 'sum', 'pay'].includes(id), disabled: false, textContent: id === 'cfg' ? JSON.stringify(cfgOf(html)) : '',
        setAttribute() {}, focus() {}, select() {}, querySelectorAll: () => kinds,
        addEventListener: (t: string, h: never) => (on[`${id}:${t}`] = h),
      };
    }
    const bodies: Record<string, unknown>[] = [];
    const calls: string[] = [];
    const keys: string[] = [];
    const store = new Map<string, string>();
    const mounted: string[] = [];
    const elementsOpts: Record<string, unknown>[] = [];
    const confirmed: string[] = [];
    const checkout = [...(answers.checkout ?? [])];
    const confirm = [...(answers.confirm ?? [])];
    const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
    const sandbox: Record<string, unknown> = {
      document: { getElementById: (id: string) => nodes[id] },
      addEventListener() {},
      setTimeout: (fn: () => void) => fn(),
      location: { origin: 'https://app.example' },
      crypto: { randomUUID },
      sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
      fetch: async (url: string, init: { body: string }) => {
        const body = JSON.parse(init.body);
        const route = url.split('/checkout')[1] || 'checkout';
        calls.push(route);
        bodies.push({ route, ...body });
        if (route === '/check-email') {
          return answers.account === 'fail'
            ? reply(429, { message: 'Too many checkout attempts. Please try again in an hour.' })
            : reply(200, { account: answers.account ?? 'existing' });
        }
        if (route === '/verify-code') return reply(answers.verify?.status ?? 200, answers.verify?.body ?? {});
        keys.push(body.idempotency_key);
        const next = checkout.shift() ?? 'pay';
        return next === 'code' ? reply(403, CODE_REQUIRED) : next === 'refuse' ? reply(400, REFUSED) : reply(200, { client_secret: 'pi_1_secret_1' });
      },
    };
    if (!answers.noStripe) {
      sandbox.Stripe = () => ({
        elements: (o: Record<string, unknown>) => (elementsOpts.push(o), { create: (type: string) => ({ on: (t: string, h: never) => (on[`${type}:${t}`] = h), mount: () => mounted.push(type) }), submit: async () => ({}) }),
        confirmPayment: async () => (confirmed.push('payment'), (confirm.shift() ?? true) ? {} : { error: { message: 'Your card was declined.' } }),
        confirmSetup: async () => (confirmed.push('setup'), (confirm.shift() ?? true) ? {} : { error: { message: 'Your card was declined.' } }),
      });
    }
    sandbox.window = sandbox;
    vm.runInNewContext(js, sandbox);
    Object.assign(nodes.nm, { value: 'Ann Buyer' });
    Object.assign(nodes.ph, { value: '415 555 0100' });
    const flush = () => new Promise((r) => setImmediate(r));
    const tap = {
      email: async (email = 'ann@example.com') => {
        Object.assign(nodes.e1, { value: ` ${email} ` });
        await on['f1:submit']({ preventDefault() {} });
        await flush();
      },
      card: async () => {
        await on['pay:submit']({ preventDefault() {} });
        await flush();
      },
      wallet: async (walletEmail = 'wallet@example.com') => {
        await on['expressCheckout:confirm']({ billingDetails: { name: 'Ann Buyer', email: walletEmail, phone: '415 555 0100' }, paymentFailed() {} });
        await flush();
      },
      code: async (code: string) => {
        Object.assign(nodes.cd, { value: code });
        await on['f2:submit']({ preventDefault() {} });
        await flush();
      },
      otherEmail: () => on['ch:click']({}),
      changeEmail: () => on['ce:click']({}),
      resend: async () => {
        await on['rs:click']({});
        await flush();
      },
    };
    const shown = () => ['f1', 'f2', 's3', 'pay'].filter((id) => !nodes[id].hidden);
    const checkouts = () => bodies.filter((b) => b.route === 'checkout');
    return { tap, bodies, checkouts, calls, keys, nodes, kinds, mounted, shown, on, elementsOpts, confirmed, msg: () => nodes.msg.textContent };
  }

  // GC-3 (#GC-TRIAL op 1): a trial package saves the card — Elements in setup
  // mode with no amount, stripe.confirmSetup on the SetupIntent's secret.
  it('GC-3: a trial package mounts Elements in setup mode and confirms a SetupIntent; a paid one still confirms a payment', async () => {
    rows[A] = pkg(A, { trial_days: 7 });
    const trial = await bootPage({ account: 'new', checkout: ['pay'], confirm: [true] });
    await trial.tap.email();
    await trial.tap.card();
    expect(trial.elementsOpts[0]).toMatchObject({ mode: 'setup', currency: 'usd' });
    expect(trial.elementsOpts[0]).not.toHaveProperty('amount');
    expect(trial.confirmed).toEqual(['setup']);
    rows[A] = pkg(A, {});
    const paid = await bootPage({ account: 'new', checkout: ['pay'], confirm: [true] });
    await paid.tap.email();
    await paid.tap.card();
    expect(paid.elementsOpts[0]).toMatchObject({ mode: 'subscription', amount: 14900 });
    expect(paid.confirmed).toEqual(['payment']);
  });

  describe('paying again after a failed attempt', () => {
    it.each([
      ['card form', 'the card is declined', 'card', { checkout: ['pay', 'pay'], confirm: [false, true] }, 'Your card was declined.'],
      ['card form', 'the checkout is refused', 'card', { checkout: ['refuse', 'pay'], confirm: [true] }, REFUSED.message],
      ['wallet', 'the card is declined', 'wallet', { checkout: ['pay', 'pay'], confirm: [false, true] }, 'Your card was declined.'],
      ['wallet', 'the checkout is refused', 'wallet', { checkout: ['refuse', 'pay'], confirm: [true] }, REFUSED.message],
    ] as const)('%s: when %s, the next tap starts a fresh checkout', async (_label, _why, via, answers, shown) => {
      const page = await bootPage({ account: 'new', checkout: [...answers.checkout], confirm: [...answers.confirm] });
      await page.tap.email();
      await page.tap[via]();
      expect(page.msg()).toBe(shown);
      await page.tap[via]();
      expect(page.keys).toHaveLength(2);
      expect(page.keys[1]).not.toBe(page.keys[0]);
    });

    it('a paid attempt keeps its key, so a second tap replays it and never charges twice', async () => {
      const page = await bootPage({ account: 'new', checkout: ['pay', 'pay'], confirm: [true, true] });
      await page.tap.email();
      await page.tap.card();
      await page.tap.wallet();
      expect(page.keys).toHaveLength(2);
      expect(page.keys[1]).toBe(page.keys[0]);
    });
  });

  describe('WEB-BUYER-FLOW: email first; a new email pays at once, a TGP email gets the code, Welcome Back and its summary first (#172-8)', () => {
    it('renders step 1 (the email only) above the hidden code step, summary and payment form; the payment form has no email field; summaries server-escaped', async () => {
      rows[A] = pkg(A, {}, { name: '<b>Sam</b>' });
      const html = (await get(`/p/${A}`)).body;
      const step1 = html.slice(html.indexOf('<form id="f1"'), html.indexOf('</form>', html.indexOf('<form id="f1"')));
      expect(step1).toContain(`<label for="e1">${PAY_PAGE_COPY.email}</label><input id="e1" type="email" autocomplete="email" required`);
      expect(step1).toContain(`<button id="b1" type="submit">${PAY_PAGE_COPY.next}</button>`);
      expect(step1.match(/<input /g)).toHaveLength(1);
      expect(html).toMatch(/<form id="f1" class="card">/);
      const at = (id: string) => html.indexOf(`id="${id}"`);
      expect(at('f1')).toBeLessThan(at('f2'));
      expect(at('f2')).toBeLessThan(at('s3'));
      expect(at('s3')).toBeLessThan(at('pay'));
      for (const id of ['f2', 's3', 'sum', 'pay']) expect(html).toMatch(new RegExp(`id="${id}"[^>]*hidden`));
      expect(html).not.toContain('id="em"');
      expect(html).toContain(`<p class="who"><span>${PAY_PAGE_COPY.email}</span><strong id="pe"></strong></p>`);
      expect(html).toContain(`<button id="ce" type="button" class="link">${PAY_PAGE_COPY.otherEmail}</button>`);
      expect(html).toContain(PAY_PAGE_COPY.appChange('&lt;b&gt;Sam&lt;/b&gt;'));
      expect(html).toContain(PAY_PAGE_COPY.oneCoach('&lt;b&gt;Sam&lt;/b&gt;'));
      expect(html).not.toContain('<b>Sam</b>');
      expect(cfgOf(html).copy.hey).toBe('Hey {N}, Welcome Back!');
    });

    it.each(['card', 'wallet'] as const)('new email (%s): step 1 goes straight to the payment form with that email fixed, no welcome and no code (#170-2)', async (via) => {
      const page = await bootPage({ account: 'new', checkout: ['pay'] });
      expect(page.shown()).toEqual(['f1']);
      expect(page.mounted).toEqual([]);
      await page.tap.email('new@example.com');
      expect(page.calls).toEqual(['/check-email']);
      expect(page.bodies[0]).toMatchObject({ guest_email: 'new@example.com' });
      expect(page.shown()).toEqual(['pay']);
      expect(page.nodes.pe.textContent).toBe('new@example.com');
      expect(page.nodes.hey.textContent).toBe('');
      expect(page.mounted).toEqual(['payment', 'expressCheckout']);
      await page.tap[via]();
      expect(page.calls).toEqual(['/check-email', 'checkout']);
      expect(page.checkouts()[0]).toMatchObject({ guest_email: 'new@example.com', guest_name: 'Ann Buyer', guest_phone: '415 555 0100' });
      expect(page.checkouts()[0]).not.toHaveProperty('buyer_token');
    });

    it('the wallet pays with the fixed email, never the wallet\'s own one', async () => {
      const page = await bootPage({ account: 'new', checkout: ['pay'] });
      await page.tap.email('typed@example.com');
      await page.tap.wallet('wallet@example.com');
      expect(page.checkouts()[0]).toMatchObject({ guest_email: 'typed@example.com' });
    });

    it.each([
      ['no coach', 'no_coach', [false, true]],
      ['client of this coach', 'same_coach', [true, false]],
    ] as const)('existing email, %s: the code at once, "Hey Ann, Welcome Back!", that summary, then the payment form; it pays with the proof (#169-8)', async (_l, summary, hiddenKinds) => {
      const page = await bootPage({ account: 'existing', checkout: ['pay'], verify: { status: 200, body: { verified: true, first_name: 'Ann', summary, buyer_token: 'proof-1' } } });
      await page.tap.email();
      expect(page.calls).toEqual(['/check-email']);
      expect(page.shown()).toEqual(['f2']);
      expect(page.nodes.to.textContent).toBe('ann@example.com');
      await page.tap.code('12 34');
      expect(page.nodes.m2.textContent).toBe(PAY_PAGE_COPY.badCode);
      expect(page.calls).toEqual(['/check-email']);
      await page.tap.code('123 456');
      expect(page.bodies[1]).toMatchObject({ route: '/verify-code', guest_email: 'ann@example.com', code: '123456' });
      expect(page.nodes.hey.textContent).toBe('Hey Ann, Welcome Back!');
      expect(page.nodes.hey.hidden).toBe(true);
      expect(page.nodes.sum.hidden).toBe(false);
      expect(page.kinds.map((k) => k.hidden)).toEqual(hiddenKinds);
      expect(page.nodes.inc0.hidden).toBe(true);
      expect(page.shown()).toEqual(['s3', 'pay']);
      expect(page.nodes.pe.textContent).toBe('ann@example.com');
      await page.tap.card();
      expect(page.calls).toEqual(['/check-email', '/verify-code', 'checkout']);
      expect(page.checkouts()[0]).toMatchObject({ guest_email: 'ann@example.com', guest_phone: '415 555 0100', buyer_token: 'proof-1' });
    });

    it.each([
      ['client of another coach', 'BUYER_HAS_COACH', 'Your account already has a coach. To change coaches, contact support from Settings.'],
      ['coach account', 'BUYER_NOT_CLIENT', 'This email belongs to a coach account, so it can’t buy a coaching package. Use a different email.'],
    ])('%s: the refusal shows after the code and the payment form never opens', async (_l, error, message) => {
      const page = await bootPage({ account: 'existing', verify: { status: 409, body: { error, message } } });
      await page.tap.email();
      await page.tap.code('123456');
      expect(page.nodes.m2.textContent).toBe(message);
      expect(page.shown()).toEqual(['f2']);
      expect(page.nodes.b2.hidden).toBe(true);
      expect(page.nodes.rs.hidden).toBe(true);
      expect(page.calls).toEqual(['/check-email', '/verify-code']);
    });

    it('"Use a different email" on the code step goes back to step 1, and the new email is checked again', async () => {
      const page = await bootPage({ account: 'existing' });
      await page.tap.email();
      page.tap.otherEmail();
      expect(page.shown()).toEqual(['f1']);
      await page.tap.email('other@example.com');
      expect(page.calls).toEqual(['/check-email', '/check-email']);
      expect(page.bodies[1]).toMatchObject({ guest_email: 'other@example.com' });
    });

    it('changing the email on the payment form starts again at step 1 and drops the proof', async () => {
      const answers: Answers = { account: 'existing', checkout: ['pay'], verify: { status: 200, body: { verified: true, first_name: 'Ann', summary: 'no_coach', buyer_token: 'proof-1' } } };
      const page = await bootPage(answers);
      await page.tap.email();
      await page.tap.code('123456');
      expect(page.shown()).toEqual(['s3', 'pay']);
      page.tap.changeEmail();
      expect(page.shown()).toEqual(['f1']);
      expect(page.nodes.sum.hidden).toBe(true);
      expect(page.nodes.inc0.hidden).toBe(false);
      answers.account = 'new';
      await page.tap.email('new@example.com');
      expect(page.shown()).toEqual(['pay']);
      expect(page.nodes.pe.textContent).toBe('new@example.com');
      await page.tap.card();
      expect(page.checkouts()[0]).toMatchObject({ guest_email: 'new@example.com' });
      expect(page.checkouts()[0]).not.toHaveProperty('buyer_token');
    });

    it('"Send a new code" sends one for the same email', async () => {
      const page = await bootPage({ account: 'existing' });
      await page.tap.email();
      await page.tap.resend();
      expect(page.calls).toEqual(['/check-email', '/check-email']);
      expect(page.nodes.m2.textContent).toBe(PAY_PAGE_COPY.resent);
    });

    it('proof expired at payment (403 BUYER_CODE_REQUIRED): back to the code step, a new code is sent', async () => {
      const page = await bootPage({ account: 'existing', checkout: ['code'], verify: { status: 200, body: { verified: true, first_name: '', summary: 'no_coach', buyer_token: 'old' } } });
      await page.tap.email();
      await page.tap.code('123456');
      expect(page.nodes.hey.textContent).toBe('Welcome Back!');
      await page.tap.card();
      expect(page.calls).toEqual(['/check-email', '/verify-code', 'checkout', '/check-email']);
      expect(page.checkouts()[0]).toMatchObject({ buyer_token: 'old' });
      expect(page.shown()).toEqual(['f2']);
      expect(page.nodes.sum.hidden).toBe(true);
      expect(page.msg()).toBe('');
    });

    it('a failed check stays on step 1 with the server\'s message', async () => {
      const page = await bootPage({ account: 'fail' });
      await page.tap.email();
      expect(page.shown()).toEqual(['f1']);
      expect(page.nodes.m1.textContent).toBe('Too many checkout attempts. Please try again in an hour.');
      expect(page.nodes.b1.disabled).toBe(false);
    });

    it('Stripe.js missing: step 1 says so and cannot continue', async () => {
      const page = await bootPage({ noStripe: true });
      expect(page.nodes.b1.disabled).toBe(true);
      expect(page.nodes.m1.textContent).toBe(cfgOf((await get(`/p/${A}`)).body).copy.failed);
      expect(page.on['f1:submit']).toBeUndefined();
    });
  });

  describe('WEB-BUYER-FLOW: the confirm page asks for the password, then shows download and log in (/p/:token?confirmed=1, #172-7)', () => {
    it('serves the password step first, with the CSP, the app\'s rule and the App Store link; off means 404', async () => {
      const res = await get(`/p/${A}?confirmed=1`);
      expect(res.status).toBe(200);
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['content-security-policy']).toContain("connect-src 'self'");
      const body = res.body;
      expect(body).toMatch(/<section id="pw">/);
      for (const id of ['ok', 'nolink', 'gone']) expect(body).toMatch(new RegExp(`<section id="${id}"[^>]*hidden`));
      expect(body).toContain(`<label for="pwd">${PAY_PAGE_COPY.pwLabel}</label><input id="pwd" type="password" autocomplete="new-password" required minlength="8" maxlength="72"`);
      expect(body).toContain('<input id="un" type="email" autocomplete="username" hidden readonly>');
      expect(body).toContain(PAY_PAGE_COPY.pwHint);
      expect(body).toContain(`<button id="pb" type="submit">${PAY_PAGE_COPY.pwSave}</button>`);
      expect(body).toContain('<a class="btn" href="https://apps.apple.com/app/id6765847915">Download on the App Store</a>');
      expect(body).toContain(`<strong id="le">${PAY_PAGE_COPY.loginEmailUnknown}</strong>`);
      expect(body).not.toContain('Monthly coaching');
      env.GUEST_PAY_PAGE_ENABLED = undefined;
      expect((await get(`/p/${A}?confirmed=1`)).status).toBe(404);
    });

    const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
    async function land(hash: string, opts: { stored?: Map<string, string>; status?: number; body?: unknown; offline?: boolean } = {}) {
      const html = (await get(`/p/${A}?confirmed=1`)).body;
      const js = [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].pop()?.[1] ?? '';
      const cf = /<script type="application\/json" id="cf">([^<]*)<\/script>/.exec(html)?.[1] ?? '{}';
      const on: Record<string, (e: unknown) => Promise<void>> = {};
      const nodes: Record<string, Record<string, unknown>> = {};
      for (const id of ['pw', 'ok', 'nolink', 'gone', 'le', 'le2', 'un', 'cf', 'pf', 'pwd', 'pb', 'pm', 'okh']) {
        nodes[id] = { hidden: id !== 'pw' && ['ok', 'nolink', 'gone'].includes(id), value: '', textContent: id === 'cf' ? cf : '', setAttribute() {}, focus() {}, addEventListener: (t: string, h: never) => (on[`${id}:${t}`] = h) };
      }
      const replaced: string[] = [];
      const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
      const store = opts.stored ?? new Map<string, string>();
      vm.runInNewContext(js, {
        document: { getElementById: (id: string) => nodes[id] },
        location: { hash, pathname: `/p/${A}`, search: '?confirmed=1' },
        history: { replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) },
        sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
        fetch: async (url: string, init: { body: string }) => {
          posts.push({ url, body: JSON.parse(init.body) });
          if (opts.offline) throw new Error('offline');
          const status = opts.status ?? 200;
          return { ok: status < 400, status, json: async () => opts.body ?? (status === 200 ? { saved: true } : {}) };
        },
        URLSearchParams, JSON, atob: (b: string) => Buffer.from(b, 'base64').toString('latin1'), escape, decodeURIComponent,
      });
      const shown = () => ['pw', 'ok', 'nolink', 'gone'].filter((id) => !nodes[id].hidden);
      const submit = async (password: string) => {
        Object.assign(nodes.pwd, { value: password });
        await on['pf:submit']({ preventDefault() {} });
        await new Promise((r) => setImmediate(r));
      };
      return { nodes, replaced, posts, store, shown, submit };
    }
    const TOKEN = jwt({ email: 'ann@example.com', sub: 'u1', session_id: 's1', amr: [{ method: 'otp' }] });

    it('the confirm link: the password step with the login email; the token leaves the address bar and stays in this tab only', async () => {
      const page = await land(`#access_token=${TOKEN}&type=invite`);
      expect(page.shown()).toEqual(['pw']);
      expect(page.nodes.le.textContent).toBe('ann@example.com');
      expect(page.nodes.un.value).toBe('ann@example.com');
      expect(page.replaced).toEqual([`/p/${A}?confirmed=1`]);
      expect(JSON.parse(page.store.get(`tgp-cf:/p/${A}`) ?? '{}')).toEqual({ t: TOKEN });
      expect(page.posts).toEqual([]);
    });

    it('a password outside the app\'s rule is refused on the page and nothing is sent', async () => {
      const page = await land(`#access_token=${TOKEN}`);
      for (const weak of ['Short1!', 'longenough1!', 'NoNumber!!', 'NoSpecial12']) {
        await page.submit(weak);
        expect(page.nodes.pm.textContent).toBe(PAY_PAGE_COPY.pwRule);
      }
      expect(page.posts).toEqual([]);
    });

    it('a good password: POST set-password with the link\'s token, then download + log in; opening the page again keeps that state', async () => {
      const page = await land(`#access_token=${TOKEN}`);
      await page.submit('Strong1!pass');
      expect(page.posts).toEqual([{ url: `/api/v1/packages/public/join/${A}/checkout/set-password`, body: { access_token: TOKEN, password: 'Strong1!pass' } }]);
      expect(page.shown()).toEqual(['ok']);
      expect(page.nodes.le2.textContent).toBe('ann@example.com');
      expect(page.nodes.pwd.value).toBe('');
      const again = await land('', { stored: page.store });
      expect(again.shown()).toEqual(['ok']);
      expect(again.nodes.le2.textContent).toBe('ann@example.com');
    });

    it('a reload before the password is set still has the token', async () => {
      const first = await land(`#access_token=${TOKEN}`);
      const again = await land('', { stored: first.store });
      expect(again.shown()).toEqual(['pw']);
      await again.submit('Strong1!pass');
      expect(again.posts[0].body).toEqual({ access_token: TOKEN, password: 'Strong1!pass' });
    });

    it.each([
      [401, 'used or run out', ['gone'], ''],
      [400, 'weak by the server', ['pw'], PAY_PAGE_COPY.pwRule],
      [429, 'too many tries', ['pw'], PAY_PAGE_COPY.pwTooMany],
      [503, 'not saved', ['pw'], PAY_PAGE_COPY.pwFailed],
    ] as const)('set-password answers %s (%s)', async (status, _why, shown, message) => {
      const page = await land(`#access_token=${TOKEN}`, { status });
      await page.submit('Strong1!pass');
      expect(page.shown()).toEqual(shown);
      expect(page.nodes.pm.textContent).toBe(message);
      if (status === 401) expect(page.store.size).toBe(0);
    });

    it('offline: the not-saved line, and the token is kept to try again', async () => {
      const page = await land(`#access_token=${TOKEN}`, { offline: true });
      await page.submit('Strong1!pass');
      expect(page.nodes.pm.textContent).toBe(PAY_PAGE_COPY.pwFailed);
      expect(page.store.size).toBe(1);
    });

    it('an expired or used link shows the run-out state', async () => {
      const page = await land('#error=access_denied&error_code=otp_expired');
      expect(page.shown()).toEqual(['gone']);
    });

    it('no link in this tab: the confirmed state with the app\'s Forgot password? line', async () => {
      const page = await land('');
      expect(page.shown()).toEqual(['nolink']);
      const html = (await get(`/p/${A}?confirmed=1`)).body;
      const nolink = html.slice(html.indexOf('<section id="nolink"'), html.indexOf('<section id="gone"'));
      expect(nolink).toContain(PAY_PAGE_COPY.confirmedH);
      expect(nolink).toContain(esc(PAY_PAGE_COPY.setPassword));
    });
  });

  // LS-WEB4 B1: a normal longer email in the payment form's fixed slot (#pe)
  // ran off a 360 px screen at 130% text; only #le wrapped. The same email ran
  // off the done page's still-confirming line. One rule wraps every paragraph
  // on the sheet of every buyer page; each email slot is in one (a done-page
  // step has its own rule) and no slot has a rule of its own, so none is missed.
  it('a long email wraps wherever a buyer page shows it: every slot is in a paragraph on the sheet, and that rule wraps', async () => {
    const LONG = 'alexandra.henderson@example.com';
    const pay = (await get(`/p/${A}`)).body;
    const confirm = (await get(`/p/${A}?confirmed=1`)).body;
    const slow = renderPayDonePage({ kind: 'confirming', email: LONG, again: false, checkUrl: `/p/${A}/done` }, 'n', APP_STORE_URL_DEFAULT);
    const paid = renderPayDonePage(
      { kind: 'paid', buyer: 'new', email: LONG, coach: 'Sam', packageName: 'Monthly coaching', amountCents: 14900 },
      'n',
      APP_STORE_URL_DEFAULT,
    );
    for (const html of [pay, confirm, slow, paid]) {
      const css = /<style nonce="[^"]+">([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
      expect(css).toContain('.sheet p{overflow-wrap:anywhere}');
      expect(css).not.toMatch(/#(?:pe|to|le\d?)\{/);
      expect(html.match(/<main class="wrap sheet[ "]/g)).toHaveLength(1);
    }
    const slots = (html: string) =>
      [...html.matchAll(/<p class="(\w+)">(?:<span>[^<]*<\/span>|[^<]*)<strong id="(\w+)">/g)].map((m) => `${m[1]}#${m[2]}`);
    expect(slots(pay)).toEqual(['lead#to', 'who#pe']);
    expect(slots(confirm)).toEqual(['who#le', 'who#le2', 'who#le3']);
    expect(pay.match(/<strong id=/g)).toHaveLength(2);
    expect(confirm.match(/<strong id=/g)).toHaveLength(3);
    expect(paid).toContain('counter-increment:n;overflow-wrap:anywhere}');
    const lastAt = (s: string, re: RegExp) => Math.max(-1, ...[...s.matchAll(re)].map((m) => m.index ?? -1));
    for (const html of [slow, paid]) {
      const at = [...html.matchAll(/alexandra\.henderson@example\.com/g)].map((m) => m.index ?? 0);
      expect(at.length).toBeGreaterThan(0);
      for (const i of at) {
        const before = html.slice(html.indexOf('<main '), i);
        expect(i).toBeLessThan(html.indexOf('</main>'));
        expect(lastAt(before, /<(?:p|li)[\s>]/g)).toBeGreaterThan(lastAt(before, /<\/(?:p|li)>/g));
      }
    }
  });
});
