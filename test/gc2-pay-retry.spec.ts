/**
 * FR-1155 B2 — Try again after a failed or cancelled redirect payment starts a
 * fresh attempt. The pay page keeps its idempotency key in the tab's
 * sessionStorage (tgp-pay:<token>), Stripe's redirect skips the page's say()
 * that drops it, and the server answers a spent key with "This checkout link
 * has expired". One tab storage is shared by the pay page, the return page and
 * the pay page again; the server double refuses spent keys the way
 * guest-checkout.service.ts replayExistingIntent does.
 */
import 'reflect-metadata';
import * as vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { renderPayPage } from '../src/storefront/pay-page.html';
import { renderPayDonePage } from '../src/storefront/pay-done.html';
import { readPayDone, type PayDoneDeps } from '../src/storefront/pay-done';
import type { PublicPackageData } from '../src/storefront/storefront.types';

const A = 'tokAAAAAAAAAAAAAAAAAA';
const PI = 'pi_3TestAAAAAAAAAAAA';
const SECRET = `${PI}_secret_good1234`;
const EXPIRED = 'This checkout link has expired. Please request a new one.';

/** A typed test double: only the members the code under test calls. */
function stub<T>(value: unknown): T {
  return value as T;
}

const pkg: PublicPackageData = {
  package_id: 'pkg-1',
  package_name: 'Monthly coaching',
  description: null,
  price_cents: 14900,
  currency: 'usd',
  billing_cycle: 'one_time',
  trial_days: null,
  features: [],
  coach: { display_name: 'Sam', bio: null, avatar_url: null, verified: true },
  stripe_publishable_key: 'pk_test_x',
  share_link_enabled: true,
  due_today_cents: 14900,
  recurring: null,
};
const payHtml = renderPayPage(pkg, { token: A, lp: null, onBehalfOf: 'acct_x', nonce: 'n0', returnUrl: `https://app.trygrowthproject.com/p/${A}/done` });

/** One browser tab's sessionStorage, kept across the Stripe redirect. */
function tab() {
  const m = new Map<string, string>();
  return {
    m,
    storage: {
      getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
      setItem: (k: string, v: string) => void m.set(k, String(v)),
      removeItem: (k: string) => void m.delete(k),
    },
  };
}

/** The server: a spent key (its attempt failed or was cancelled) is refused, a fresh one gets an intent. */
const server = { spent: new Set<string>(), seen: [] as string[] };

/** Opens the pay page in the tab and submits the card form once (Stripe then redirects). */
async function payOnce(t: ReturnType<typeof tab>) {
  const js = [...payHtml.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].pop()?.[1] ?? '';
  const cfg = /<script type="application\/json" id="cfg">([\s\S]*?)<\/script>/.exec(payHtml)?.[1] ?? '{}';
  const on: Record<string, (e: unknown) => Promise<void>> = {};
  const nodes: Record<string, Record<string, unknown>> = {};
  // Every id the pay page has used, so a later pay page layout still boots here.
  const ids = ['cfg', 'f1', 'e1', 'b1', 'm1', 'pay', 'go', 'msg', 'nm', 'ph', 'em', 'pe', 'ce', 'or', 'express', 'f2', 'b2', 'm2', 'cd', 'rs', 'ch', 's3', 'hey', 'sum', 'to', 'inc0'];
  for (const id of ids) {
    nodes[id] = { value: '', textContent: id === 'cfg' ? cfg : '', setAttribute() {}, focus() {}, select() {}, addEventListener: (ev: string, h: never) => (on[`${id}:${ev}`] = h) };
  }
  const confirmed: string[] = [];
  const sandbox: Record<string, unknown> = {
    document: { getElementById: (id: string) => nodes[id] },
    addEventListener() {},
    location: { origin: 'https://app.trygrowthproject.com' },
    crypto: { randomUUID },
    sessionStorage: t.storage,
    fetch: async (url: string, init: { body: string }) => {
      if (url.endsWith('/check-email')) return { ok: true, json: async () => ({ account: 'new' }) };
      const key = String(JSON.parse(init.body).idempotency_key);
      server.seen.push(key);
      if (server.spent.has(key)) return { ok: false, status: 404, json: async () => ({ error: 'TOKEN_NOT_FOUND', message: EXPIRED }) };
      return { ok: true, json: async () => ({ client_secret: `${PI}_secret_${key.slice(0, 8)}` }) };
    },
    Stripe: () => ({
      elements: () => ({ create: () => ({ on() {}, mount() {} }), submit: async () => ({}) }),
      confirmPayment: async (a: { clientSecret: string }) => {
        confirmed.push(a.clientSecret);
        return {}; // Stripe redirects to the return page: say() never runs.
      },
    }),
  };
  sandbox.window = sandbox;
  vm.runInNewContext(js, sandbox);
  Object.assign(nodes.nm, { value: 'Ann Buyer' });
  Object.assign(nodes.ph, { value: '(415) 555-0100' });
  Object.assign(nodes.em, { value: 'ann@example.com' });
  Object.assign(nodes.e1, { value: 'ann@example.com' });
  if (on['f1:submit']) await on['f1:submit']({ preventDefault() {} });
  await on['pay:submit']({ preventDefault() {} });
  return { key: server.seen[server.seen.length - 1], confirmed, msg: String(nodes.msg.textContent ?? '') };
}

/** Stripe sends the tab back to /p/<token>/done; the page is read from our row and Stripe, then its script runs in the tab. */
async function returnPage(t: ReturnType<typeof tab>, rowKey: string, piStatus: string, rowStatus = 'failed') {
  const deps = stub<PayDoneDeps>({
    db: {
      guestCheckout: {
        findUnique: async () => ({
          guest_email: 'ann@example.com',
          created_at: new Date('2026-10-24T12:00:00Z'),
          status: rowStatus,
          expires_at: new Date(Date.now() + 86_400_000),
          idempotency_key: rowKey,
          created_user_id: null,
          package_id: 'pkg-1',
          package: { share_token: A, name: 'Monthly coaching', coach: { name: 'Sam' } },
        }),
      },
      user: { findFirst: async () => null },
      chargeDispute: { findFirst: async () => null },
    },
    stripe: {
      retrievePaymentIntent: async () => ({ id: PI, client_secret: SECRET, status: piStatus, amount: 14900, latest_charge: 'ch_3RetryAAAAAAAAAAA', last_payment_error: null }),
      retrieveCharge: async () => ({ id: 'ch_3RetryAAAAAAAAAAA', amount: 14900, amount_refunded: 0, refunded: false, disputed: false }),
    },
    storefrontBase: undefined,
  });
  const { view } = await readPayDone(deps, A, { payment_intent: PI, payment_intent_client_secret: SECRET });
  const html = renderPayDonePage(view, 'n1', 'https://apps.apple.com/app/id6765847915');
  for (const m of html.matchAll(/<script nonce="n1">([\s\S]*?)<\/script>/g)) vm.runInNewContext(m[1], { sessionStorage: t.storage });
  return { view, html };
}

describe('FR-1155 B2: Try again after a failed or cancelled return is a fresh attempt', () => {
  beforeEach(() => {
    server.spent.clear();
    server.seen = [];
  });

  it.each([
    ['failed', 'requires_payment_method', 'failed'],
    ['cancelled', 'canceled', 'pending'],
  ])('%s return -> Try again -> the first submit goes through with a new key', async (kind, piStatus, rowStatus) => {
    const t = tab();
    const first = await payOnce(t);
    expect(t.m.has(`tgp-pay:${A}`)).toBe(true); // survives the redirect
    server.spent.add(first.key); // the webhook marked that attempt failed / it was cancelled
    const back = await returnPage(t, first.key, piStatus, rowStatus);
    expect(back.view.kind).toBe(kind);
    expect(back.html).toContain(`href="https://app.trygrowthproject.com/p/${A}"`);
    expect(t.m.has(`tgp-pay:${A}`)).toBe(false);
    const again = await payOnce(t);
    expect(again.key).not.toBe(first.key);
    expect(again.msg).not.toContain(EXPIRED);
    expect(again.confirmed).toHaveLength(1);
    expect(server.seen).toEqual([first.key, again.key]);
  });

  it('a still-confirming or paid return keeps the key: the pending attempt is replayed, not doubled', async () => {
    for (const piStatus of ['processing', 'succeeded']) {
      const t = tab();
      const first = await payOnce(t);
      const back = await returnPage(t, first.key, piStatus, 'pending');
      expect(back.view.kind).toBe(piStatus === 'succeeded' ? 'paid' : 'confirming');
      expect(t.m.has(`tgp-pay:${A}`)).toBe(true);
      expect((await payOnce(t)).key).toBe(first.key);
    }
  });

  it("an older attempt's failed page (the back button) leaves a newer attempt's key alone", async () => {
    const t = tab();
    const first = await payOnce(t);
    server.spent.add(first.key);
    await returnPage(t, first.key, 'requires_payment_method');
    const second = await payOnce(t);
    const stored = t.m.get(`tgp-pay:${A}`);
    await returnPage(t, first.key, 'requires_payment_method');
    expect(t.m.get(`tgp-pay:${A}`)).toBe(stored);
    expect((await payOnce(t)).key).toBe(second.key);
  });

  it('a broken or foreign tab entry is left as it is and never throws', async () => {
    const t = tab();
    for (const junk of ['not json', 'null', '{"k":7}', '{"h":1}']) {
      t.m.set(`tgp-pay:${A}`, junk);
      await returnPage(t, 'some-key', 'requires_payment_method');
      expect(t.m.get(`tgp-pay:${A}`)).toBe(junk);
    }
    t.m.set('tgp-pay:tokBBBBBBBBBBBBBBBBBB', JSON.stringify({ k: 'some-key', h: 1 }));
    await returnPage(t, 'some-key', 'requires_payment_method');
    expect(t.m.has('tgp-pay:tokBBBBBBBBBBBBBBBBBB')).toBe(true);
  });
});
