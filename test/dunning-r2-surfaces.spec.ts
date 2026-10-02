import {
  ArgumentMetadata,
  BadRequestException,
  INestApplication,
  Type,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  ConfirmCardUpdateDto,
  CreateCardSetupDto,
} from '../src/checkout/client-billing.controller';
import { CLIENT_BILLING_RECONCILE_CRON_EXPRESSION } from '../src/checkout/client-billing.reconciler';
import { DUNNING_V2_SWEEP_CRON_EXPRESSION } from '../src/checkout/dunning-v2/dunning-v2.cadence';
import {
  StripeConnectApiError,
  StripeConnectApiService,
} from '../src/connect/stripe-connect-api.service';
import { EmailService } from '../src/email/email.service';
import { EmailTemplateKey } from '../src/email/email.types';
import { WellKnownController } from '../src/invite-landing/well-known.controller';
import { PublicPagesController } from '../src/public-pages/public-pages.controller';
import { PrismaService } from '../src/prisma.service';

/**
 * S-DUNNING-R2 — the edges of the native card update: the Stripe wrappers
 * (exact form fields + Idempotency-Key), the https landing page and the AASA
 * entry behind the email link, the v2 email templates (F17), and the DTOs.
 */

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: URLSearchParams;
}

class RecordingStripe extends StripeConnectApiService {
  readonly requests: Recorded[] = [];
  respond: (r: Recorded) => { status: number; json: unknown } = () => ({
    status: 200,
    json: { id: 'obj_1', status: 'ok' },
  });

  constructor() {
    super();
    this.fetchImpl = async (input, init) => {
      const rec: Recorded = {
        url: String(input),
        method: String(init?.method ?? 'GET'),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: new URLSearchParams(typeof init?.body === 'string' ? init.body : ''),
      };
      this.requests.push(rec);
      const out = this.respond(rec);
      return new Response(JSON.stringify(out.json), {
        status: out.status,
        headers: { 'Content-Type': 'application/json' },
      });
    };
  }
}

describe('S-DUNNING-R2 Stripe wrappers (platform account, form + Idempotency-Key)', () => {
  const prev = process.env.STRIPE_SECRET_KEY;
  beforeAll(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_r2';
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = prev;
  });

  it('createSetupIntent: off_session card SetupIntent on the customer, no Stripe-Account, no on_behalf_of', async () => {
    const s = new RecordingStripe();
    await s.createSetupIntent({
      customer: 'cus_1',
      metadata: { tgp_client_user_id: 'u1' },
      idempotencyKey: 'k1',
    });
    const [r] = s.requests;
    expect(r.url).toBe('https://api.stripe.com/v1/setup_intents');
    expect(r.method).toBe('POST');
    expect(r.headers['Idempotency-Key']).toBe('k1');
    expect(r.headers['Stripe-Account']).toBeUndefined();
    expect(Object.fromEntries(r.body)).toEqual({
      customer: 'cus_1',
      usage: 'off_session',
      'payment_method_types[0]': 'card',
      'metadata[tgp_client_user_id]': 'u1',
    });
  });

  it('defaults: customer invoice_settings AND subscription default_payment_method', async () => {
    const s = new RecordingStripe();
    await s.setCustomerDefaultPaymentMethod({
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      idempotencyKey: 'a',
    });
    await s.setSubscriptionDefaultPaymentMethod({
      subscriptionId: 'sub_1',
      paymentMethodId: 'pm_1',
      idempotencyKey: 'b',
    });
    expect(s.requests[0].url).toBe('https://api.stripe.com/v1/customers/cus_1');
    expect(Object.fromEntries(s.requests[0].body)).toEqual({
      'invoice_settings[default_payment_method]': 'pm_1',
    });
    expect(s.requests[1].url).toBe('https://api.stripe.com/v1/subscriptions/sub_1');
    expect(Object.fromEntries(s.requests[1].body)).toEqual({ default_payment_method: 'pm_1' });
    expect(s.requests.map((r) => r.headers['Idempotency-Key'])).toEqual(['a', 'b']);
  });

  it('payInvoice is on-session with the explicit card; voidInvoice and cancel-at-period-end are keyed', async () => {
    const s = new RecordingStripe();
    await s.payInvoice({ invoiceId: 'in_1', paymentMethodId: 'pm_1', idempotencyKey: 'p' });
    await s.voidInvoice({ invoiceId: 'in_1', idempotencyKey: 'v' });
    await s.setCancelAtPeriodEnd({ subscriptionId: 'sub_1', idempotencyKey: 'c' });
    expect(s.requests[0].url).toBe('https://api.stripe.com/v1/invoices/in_1/pay');
    expect(Object.fromEntries(s.requests[0].body)).toEqual({
      payment_method: 'pm_1',
      off_session: 'false',
    });
    expect(s.requests[1].url).toBe('https://api.stripe.com/v1/invoices/in_1/void');
    expect(Object.fromEntries(s.requests[2].body)).toEqual({
      cancel_at_period_end: 'true',
      proration_behavior: 'none',
    });
    expect(s.requests.map((r) => r.headers['Idempotency-Key'])).toEqual(['p', 'v', 'c']);
  });

  it('listOpenInvoices filters by subscription and status=open; retrieveInvoice expands the PaymentIntent', async () => {
    const s = new RecordingStripe();
    s.respond = () => ({ status: 200, json: { data: [{ id: 'in_1', status: 'open' }] } });
    expect(await s.listOpenInvoices('sub_1')).toEqual([{ id: 'in_1', status: 'open' }]);
    s.respond = () => ({ status: 200, json: { id: 'in_1', status: 'open' } });
    await s.retrieveInvoice('in_1');
    expect(s.requests[0].url).toBe(
      'https://api.stripe.com/v1/invoices?subscription=sub_1&status=open&limit=10',
    );
    expect(s.requests[1].url).toBe(
      'https://api.stripe.com/v1/invoices/in_1?expand%5B0%5D=payment_intent',
    );
  });

  it('a card_error carries its decline_code', async () => {
    const s = new RecordingStripe();
    s.respond = () => ({
      status: 402,
      json: {
        error: {
          type: 'card_error',
          code: 'card_declined',
          decline_code: 'insufficient_funds',
          message: 'Your card has insufficient funds.',
        },
      },
    });
    await expect(
      s.payInvoice({ invoiceId: 'in_1', paymentMethodId: 'pm_1', idempotencyKey: 'p' }),
    ).rejects.toMatchObject({
      httpStatus: 402,
      stripeCode: 'card_declined',
      stripeType: 'card_error',
      declineCode: 'insufficient_funds',
    });
    const e = new StripeConnectApiError('x', 500, null, null);
    expect(e.declineCode).toBeNull();
  });
});

/**
 * Serves one controller over real HTTP on an ephemeral port (no global
 * prefix, no guards), so the handler runs against a real Express Response.
 */
async function serve(controller: Type<unknown>): Promise<{ app: INestApplication; base: string }> {
  const mod = await Test.createTestingModule({ controllers: [controller] }).compile();
  const app = mod.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  return { app, base };
}

describe('S-DUNNING-R2 email link target (universal link + calm landing page)', () => {
  const ORIGINAL_ENV = { ...process.env };
  let app: INestApplication | null = null;
  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    if (app) await app.close();
    app = null;
  });

  it('GET /billing/update-card is a calm, static page that opens the app', async () => {
    const served = await serve(PublicPagesController);
    app = served.app;
    const res = await fetch(`${served.base}/billing/update-card`);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(body).toContain('Update your card in the app');
    expect(body).toContain('href="tgp://billing/update-card"');
    expect(body).toContain('href="/download/ios"');
    expect(body).toContain('href="/download/android"');
    expect(body).not.toMatch(/billing\.stripe\.com|portal/i);
    expect(body.replace(/<[^>]+>/g, '')).not.toContain('!');
  });

  it('AASA lists /billing/update-card so iOS opens the app directly', async () => {
    process.env.NODE_ENV = 'production';
    process.env.APPLE_TEAM_ID = 'TEAMID1234';
    const served = await serve(WellKnownController);
    app = served.app;
    const res = await fetch(`${served.base}/.well-known/apple-app-site-association`);
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text());
    const detail = body.applinks.details[0];
    expect(detail.paths).toContain('/billing/update-card');
    expect(detail.components).toContainEqual(
      expect.objectContaining({ '/': '/billing/update-card' }),
    );
    // Existing invite links unchanged.
    expect(detail.paths).toEqual(expect.arrayContaining(['/join/*', '/invite/*']));
  });
});

describe('S-DUNNING-R2 v2 email templates (F17)', () => {
  let svc: EmailService;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        EmailService,
        {
          provide: PrismaService,
          useValue: { emailSendLog: { create: jest.fn(), update: jest.fn() } },
        },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();
    svc = mod.get(EmailService);
  });

  it('client template renders Roman copy, the update-card button and the per-step subject', () => {
    const out = svc.render(EmailTemplateKey.DUNNING_V2_CLIENT, {
      roman_body: 'Good day, Avery.\n\nYour payment of $150.00 has not yet cleared.',
      update_card_url: 'https://app.trygrowthproject.com/billing/update-card',
      subject: 'Your payment is still outstanding',
    });
    expect(out.subject).toBe('Your payment is still outstanding');
    expect(out.html).toContain('Your payment of $150.00 has not yet cleared.');
    expect(out.html).toContain('href="https://app.trygrowthproject.com/billing/update-card"');
    expect(out.html).toContain('End my plan');
    expect(out.html).not.toMatch(/portal/i);
    expect(out.html.replace(/<[^>]+>/g, '')).not.toContain('!');
  });

  it('client subject falls back when none is passed; HTML in copy is escaped', () => {
    const out = svc.render(EmailTemplateKey.DUNNING_V2_CLIENT, { roman_body: '<b>x</b>' });
    expect(out.subject).toBe('About your Growth Project payment');
    expect(out.html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('coach template renders the coach copy and never the client "subscription ending" text', () => {
    const out = svc.render(EmailTemplateKey.DUNNING_V2_COACH, {
      roman_body: 'Good day, Morgan Coach.',
      clientName: 'Avery Client',
    });
    expect(out.subject).toBe('A payment from Avery Client needs attention');
    expect(out.html).toContain('Good day, Morgan Coach.');
    expect(out.html).not.toMatch(/subscription is ending/i);
  });
});

describe('S-DUNNING-R2 DTOs and schedule', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const meta = (metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({
    type: 'body',
    metatype,
  });

  it('setup-intent requires a UUID idempotency_key', async () => {
    await expect(
      pipe.transform(
        { idempotency_key: '00000000-0000-4000-8000-000000000001' },
        meta(CreateCardSetupDto),
      ),
    ).resolves.toBeInstanceOf(CreateCardSetupDto);
    await expect(
      pipe.transform({ idempotency_key: 'nope' }, meta(CreateCardSetupDto)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('confirm accepts only a Stripe SetupIntent id and no extra fields', async () => {
    await expect(
      pipe.transform({ setup_intent_id: 'seti_123abc' }, meta(ConfirmCardUpdateDto)),
    ).resolves.toEqual(expect.objectContaining({ setup_intent_id: 'seti_123abc' }));
    for (const bad of [
      { setup_intent_id: 'pi_123' },
      { setup_intent_id: 'seti_1', amount: 1 },
      {},
    ]) {
      await expect(pipe.transform(bad, meta(ConfirmCardUpdateDto))).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
  });

  it('the reconciler runs hourly away from the v2 sweep minute', () => {
    expect(CLIENT_BILLING_RECONCILE_CRON_EXPRESSION).toBe('37 * * * *');
    expect(CLIENT_BILLING_RECONCILE_CRON_EXPRESSION).not.toBe(DUNNING_V2_SWEEP_CRON_EXPRESSION);
  });
});
