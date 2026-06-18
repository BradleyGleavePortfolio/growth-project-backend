/**
 * TM-14 — event-driven Stripe Connect `account.updated` webhook for the talent
 * marketplace. Hermetic: no DB, no network for the service tests; the HTTP
 * signature-gate tests boot a real Nest app on an ephemeral port and POST raw
 * bytes (supertest is intentionally absent repo-wide — see test/payouts-v2.spec.ts).
 *
 * R66 gate matrix:
 *   - signature verify: missing / invalid Stripe-Signature → 400 BEFORE the
 *     thin service is ever reached (no DB side effect); valid → 200;
 *   - a verified account.updated with charges_enabled && payouts_enabled
 *     persists onboarding_completed = true (derived via the SINGLE TM-10
 *     adapter interpretation, no Stripe re-fetch);
 *   - a redelivered event with the SAME event id is processed exactly once
 *     (event-id idempotency via the MarketplaceConnectEvent PK);
 *   - the legacy polling fallback (ConnectService.syncFromStripe) is NEVER
 *     invoked by this path.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as http from 'http';
import { Prisma } from '@prisma/client';
import { TalentConnectWebhookController } from '../src/talent-marketplace/talent-connect-webhook.controller';
import { TalentConnectWebhookService } from '../src/talent-marketplace/talent-connect-webhook.service';
import { TalentConnectAdapter } from '../src/talent-marketplace/connect-adapter.service';
import { PrismaService } from '../src/prisma.service';
import { signStripePayload } from '../src/billing/stripe-signature';

async function httpRequest(opts: {
  app: INestApplication;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: string }> {
  const server = opts.app.getHttpServer();
  const address = server.address();
  const port =
    typeof address === 'object' && address ? address.port : Number(address);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: opts.method,
        path: opts.path,
        headers: opts.headers ?? {},
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: data }),
        );
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

// Minimal in-memory stand-in for the MarketplaceConnectEvent ledger that
// enforces the PK uniqueness the idempotency contract relies on. `create`
// throws a Prisma P2002 on a duplicate stripe_event_id, exactly like Postgres.
function makeFakePrisma(opts?: { coachUserId?: string | null }) {
  const events = new Map<string, Record<string, unknown>>();
  const syncFromStripe = jest.fn(); // legacy polling fallback — must stay unused
  return {
    rows: events,
    syncFromStripe,
    connectAccount: {
      findUnique: jest.fn(async () =>
        opts && 'coachUserId' in opts
          ? { coach_user_id: opts.coachUserId ?? null }
          : { coach_user_id: 'coach_1' },
      ),
    },
    marketplaceConnectEvent: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const id = data.stripe_event_id as string;
        if (events.has(id)) {
          throw new Prisma.PrismaClientKnownRequestError(
            'Unique constraint failed',
            { code: 'P2002', clientVersion: 'test' },
          );
        }
        events.set(id, data);
        return data;
      }),
    },
  };
}

function accountUpdatedEvent(overrides?: {
  id?: string;
  charges?: boolean;
  payouts?: boolean;
  acct?: string;
}) {
  return {
    id: overrides?.id ?? 'evt_acct_1',
    type: 'account.updated',
    data: {
      object: {
        id: overrides?.acct ?? 'acct_123',
        charges_enabled: overrides?.charges ?? true,
        payouts_enabled: overrides?.payouts ?? true,
      },
    },
  };
}

describe('TalentConnectAdapter.deriveOnboarded — single Connect interpretation', () => {
  it('onboarded only when BOTH charges_enabled and payouts_enabled', () => {
    expect(
      TalentConnectAdapter.deriveOnboarded({
        charges_enabled: true,
        payouts_enabled: true,
      }),
    ).toBe(true);
    expect(
      TalentConnectAdapter.deriveOnboarded({
        charges_enabled: true,
        payouts_enabled: false,
      }),
    ).toBe(false);
    expect(
      TalentConnectAdapter.deriveOnboarded({
        charges_enabled: false,
        payouts_enabled: false,
      }),
    ).toBe(false);
  });
});

describe('TalentConnectWebhookService — persistence + event-id idempotency', () => {
  it('valid account.updated (both caps enabled) persists onboarding_completed=true once', async () => {
    const prisma = makeFakePrisma({ coachUserId: 'coach_1' });
    const svc = new TalentConnectWebhookService(
      prisma as unknown as PrismaService,
    );

    const result = await svc.handleAccountUpdated(accountUpdatedEvent());

    expect(result.processed).toBe(true);
    expect(result.onboarding_completed).toBe(true);
    expect(prisma.marketplaceConnectEvent.create).toHaveBeenCalledTimes(1);
    const row = prisma.rows.get('evt_acct_1');
    expect(row).toMatchObject({
      stripe_event_id: 'evt_acct_1',
      type: 'account.updated',
      stripe_account_id: 'acct_123',
      coach_user_id: 'coach_1',
      onboarding_completed: true,
    });
    // The legacy polling fallback was never invoked by the webhook path.
    expect(prisma.syncFromStripe).not.toHaveBeenCalled();
  });

  it('incomplete caps → onboarding_completed=false persisted', async () => {
    const prisma = makeFakePrisma();
    const svc = new TalentConnectWebhookService(
      prisma as unknown as PrismaService,
    );

    const result = await svc.handleAccountUpdated(
      accountUpdatedEvent({ payouts: false }),
    );

    expect(result.processed).toBe(true);
    expect(result.onboarding_completed).toBe(false);
    expect(prisma.rows.get('evt_acct_1')).toMatchObject({
      onboarding_completed: false,
    });
  });

  it('redelivered SAME event id is processed exactly once (idempotent)', async () => {
    const prisma = makeFakePrisma();
    const svc = new TalentConnectWebhookService(
      prisma as unknown as PrismaService,
    );

    const first = await svc.handleAccountUpdated(accountUpdatedEvent());
    const second = await svc.handleAccountUpdated(accountUpdatedEvent());

    expect(first.processed).toBe(true);
    expect(second.processed).toBe(false);
    expect(second.alreadyProcessed).toBe(true);
    // Two delivery attempts, but the ledger holds exactly one row.
    expect(prisma.marketplaceConnectEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.rows.size).toBe(1);
  });

  it('ignores non-account.updated event types without recording a dedup row', async () => {
    const prisma = makeFakePrisma();
    const svc = new TalentConnectWebhookService(
      prisma as unknown as PrismaService,
    );

    const result = await svc.handleAccountUpdated({
      id: 'evt_pi',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_1' } },
    });

    expect(result.processed).toBe(false);
    expect(result.reason).toBe('ignored_event_type');
    expect(prisma.marketplaceConnectEvent.create).not.toHaveBeenCalled();
  });
});

describe('TalentConnectWebhookController — HTTP signature gate', () => {
  const SECRET = 'whsec_tm14_test_secret';
  let app: INestApplication;
  let handleAccountUpdated: jest.Mock;

  beforeAll(async () => {
    handleAccountUpdated = jest.fn(async () => ({
      received: true,
      processed: true,
      onboarding_completed: true,
    }));
    const moduleRef = await Test.createTestingModule({
      controllers: [TalentConnectWebhookController],
      providers: [
        {
          provide: TalentConnectWebhookService,
          useValue: { handleAccountUpdated },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
    await app.listen(0);
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  });

  afterAll(async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    if (app) await app.close();
  });

  beforeEach(() => handleAccountUpdated.mockClear());

  const PATH = '/v1/webhooks/talent-marketplace/connect';
  const payload = JSON.stringify(accountUpdatedEvent());

  it('MISSING Stripe-Signature → 400, service never reached', async () => {
    const res = await httpRequest({
      app,
      method: 'POST',
      path: PATH,
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    expect(res.status).toBe(400);
    expect(res.body).toContain('Stripe signature');
    expect(handleAccountUpdated).not.toHaveBeenCalled();
  });

  it('INVALID Stripe-Signature → 400, service never reached', async () => {
    const badHeader = signStripePayload({ payload, secret: 'whsec_attacker' });
    const res = await httpRequest({
      app,
      method: 'POST',
      path: PATH,
      headers: {
        'content-type': 'application/json',
        'stripe-signature': badHeader,
      },
      body: payload,
    });
    expect(res.status).toBe(400);
    expect(res.body).toContain('Stripe signature');
    expect(handleAccountUpdated).not.toHaveBeenCalled();
  });

  it('VALID Stripe-Signature → 200 and delegates exactly once', async () => {
    const header = signStripePayload({ payload, secret: SECRET });
    const res = await httpRequest({
      app,
      method: 'POST',
      path: PATH,
      headers: {
        'content-type': 'application/json',
        'stripe-signature': header,
      },
      body: payload,
    });
    expect(res.status).toBe(200);
    expect(handleAccountUpdated).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(res.body);
    expect(parsed.received).toBe(true);
    expect(parsed.processed).toBe(true);
  });
});
