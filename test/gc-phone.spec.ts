/**
 * GC-PHONE — the buyer's phone on the web pay page (name, phone, email, then
 * checkout). The checkout body's guest_phone is required, normalised to E.164
 * (no + means +1) and stored on GuestCheckout; the page asks for it between
 * name and email, the wallet sheet asks for it too, and Stripe gets it as the
 * billing phone. The 13-month PII scrub and account deletion clear it
 * (test/guest-checkout-pii-scrub.service.spec.ts covers the scrub's update).
 */
import 'reflect-metadata';
import * as vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ERASURE_MANIFEST } from '../src/account-deletion/account-deletion.manifest';
import { renderPayPage } from '../src/storefront/pay-page.html';
import { GuestCheckoutDto, toE164 } from '../src/storefront/storefront.dto';
import type { PublicPackageData } from '../src/storefront/storefront.types';

describe('GC-PHONE: the phone the buyer gives at checkout', () => {
  describe('toE164', () => {
    it.each([
      ['(415) 555-0100', '+14155550100'],
      ['415.555.0100', '+14155550100'],
      ['1 415 555 0100', '+14155550100'],
      ['+1 (415) 555-0100', '+14155550100'],
      ['  +44 20 7946 0958 ', '+442079460958'],
      ['5550100', '+15550100'],
      ['+123456789012345', '+123456789012345'],
    ])('%j -> %s', (raw, e164) => {
      expect(toE164(raw)).toBe(e164);
    });

    it.each([
      ['6 digits', '555010'],
      ['16 digits', '+1234567890123456'],
      ['15 digits without + (16 with the +1)', '123456789012345'],
      ['letters', '415-555-CALL'],
      ['a + inside', '415+5550100'],
      ['a leading 0 after +', '+0123456789'],
      ['empty', ''],
      ['not a string', 4155550100],
    ])('refuses %s', (_why, raw) => {
      expect(toE164(raw)).toBeNull();
    });
  });

  describe('the checkout body (the global ValidationPipe of src/main.ts)', () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const body = (over: Record<string, unknown>) => ({
      guest_name: 'Ann Buyer',
      guest_email: 'ann@example.com',
      idempotency_key: randomUUID(),
      ...over,
    });
    const check = (value: Record<string, unknown>) =>
      pipe.transform(value, { type: 'body', metatype: GuestCheckoutDto });
    const refusal = async (value: Record<string, unknown>) => {
      const err = await check(value).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      return (err as BadRequestException).getResponse() as { message: string[] };
    };

    it('stores what was typed as E.164', async () => {
      const dto = (await check(body({ guest_phone: '(415) 555-0100' }))) as GuestCheckoutDto;
      expect(dto.guest_phone).toBe('+14155550100');
      const intl = (await check(body({ guest_phone: '+44 20 7946 0958' }))) as GuestCheckoutDto;
      expect(intl.guest_phone).toBe('+442079460958');
    });

    it.each([
      ['missing', {}],
      ['empty', { guest_phone: '' }],
      ['too short', { guest_phone: '555-010' }],
      ['too long', { guest_phone: '+1234567890123456' }],
      ['not a number', { guest_phone: 'call me' }],
      ['not a string', { guest_phone: 4155550100 }],
    ])('refuses a phone that is %s, with one line', async (_why, over) => {
      expect((await refusal(body(over))).message).toEqual(['Please enter a valid phone number.']);
    });
  });

  it('account deletion clears the phone on both GuestCheckout entries', () => {
    const entries = ERASURE_MANIFEST.filter((e) => e.model === 'GuestCheckout');
    expect(entries.map((e) => e.field).sort()).toEqual(['created_user_id', 'guest_email']);
    for (const e of entries) {
      expect(e.action).toMatchObject({ op: 'update', data: { guest_phone: null } });
    }
  });

  describe('the pay page', () => {
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
    const html = renderPayPage(pkg, {
      token: 'tokAAAAAAAAAAAAAAAAAA',
      lp: null,
      onBehalfOf: 'acct_x',
      nonce: 'n0',
      returnUrl: 'https://app.trygrowthproject.com/p/tokAAAAAAAAAAAAAAAAAA/done',
    });

    it('asks for the phone between name and email, as a phone field', () => {
      const form = /<form id="pay"[\s\S]*?<\/form>/.exec(html)?.[0] ?? '';
      const fields = [...form.matchAll(/<label for="(\w+)">([^<]+)<\/label>/g)].map((m) => [m[1], m[2]]);
      expect(fields).toEqual([['nm', 'Name'], ['ph', 'Phone'], ['em', 'Email']]);
      expect(form).toContain(
        '<input id="ph" type="tel" inputmode="tel" autocomplete="tel" required maxlength="32">',
      );
    });

    // The page's own script with stand-ins for the DOM, Stripe.js and fetch.
    function boot() {
      const js = [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].pop()?.[1] ?? '';
      const cfg = /<script type="application\/json" id="cfg">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '{}';
      const on: Record<string, (e: unknown) => Promise<void>> = {};
      const nodes: Record<string, Record<string, unknown>> = {};
      for (const id of ['cfg', 'pay', 'go', 'msg', 'nm', 'ph', 'em', 'or', 'express']) {
        nodes[id] = { value: '', textContent: id === 'cfg' ? cfg : '', setAttribute() {}, focus() {}, addEventListener: (t: string, h: never) => (on[`${id}:${t}`] = h) };
      }
      const sent: Record<string, unknown>[] = [];
      const billed: unknown[] = [];
      const options: Record<string, unknown> = {};
      const sandbox: Record<string, unknown> = {
        document: { getElementById: (id: string) => nodes[id] },
        addEventListener() {},
        location: { origin: 'https://app.example' },
        crypto: { randomUUID },
        sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        fetch: async (_url: string, init: { body: string }) => {
          sent.push(JSON.parse(init.body));
          return { ok: true, json: async () => ({ client_secret: 'pi_1_secret_1' }) };
        },
        Stripe: () => ({
          elements: () => ({
            create: (type: string, o: unknown) => ((options[type] = o), { on: (t: string, h: never) => (on[`${type}:${t}`] = h), mount() {} }),
            submit: async () => ({}),
          }),
          confirmPayment: async (a: { confirmParams: { payment_method_data: { billing_details: unknown } } }) => {
            billed.push(a.confirmParams.payment_method_data.billing_details);
            return {};
          },
        }),
      };
      sandbox.window = sandbox;
      vm.runInNewContext(js, sandbox);
      Object.assign(nodes.nm, { value: ' Ann Buyer ' });
      Object.assign(nodes.ph, { value: ' (415) 555-0100 ' });
      Object.assign(nodes.em, { value: 'ann@example.com' });
      return { on, sent, billed, options };
    }

    it('the card form sends the typed phone to checkout and to Stripe as the billing phone', async () => {
      const page = boot();
      await page.on['pay:submit']({ preventDefault() {} });
      expect(page.sent).toHaveLength(1);
      expect(page.sent[0]).toMatchObject({ guest_name: 'Ann Buyer', guest_phone: '(415) 555-0100', guest_email: 'ann@example.com' });
      expect(page.billed).toEqual([{ name: 'Ann Buyer', phone: '(415) 555-0100', email: 'ann@example.com' }]);
    });

    it("the wallet sheet asks for the phone, and the wallet's phone is the one sent", async () => {
      const page = boot();
      expect(page.options.expressCheckout).toMatchObject({ emailRequired: true, phoneNumberRequired: true });
      const billingDetails = { name: 'Ann Wallet', email: 'wallet@example.com', phone: '+14155550199' };
      await page.on['expressCheckout:confirm']({ billingDetails, paymentFailed() {} });
      expect(page.sent[0]).toMatchObject({ guest_name: 'Ann Wallet', guest_phone: '+14155550199', guest_email: 'wallet@example.com' });
      expect(page.billed).toEqual([billingDetails]);
    });

    it('a wallet that gives no phone falls back to the phone field', async () => {
      const page = boot();
      await page.on['expressCheckout:confirm']({ billingDetails: { name: 'Ann Wallet', email: 'wallet@example.com' }, paymentFailed() {} });
      expect(page.sent[0]).toMatchObject({ guest_phone: '(415) 555-0100' });
    });
  });
});
