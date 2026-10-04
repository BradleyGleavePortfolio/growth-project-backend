// FIX ROUND (B-CM1-116) — Sol + Opus REQUEST CHANGES @ 9a512028 (#674).
// B-674-1 distinct refunds on one transfer / slice both count (live proof:
// refund-reversal-concurrency.live). B-674-2 owner routes through the mounted
// controllers and real guards. B-674-3 the transfer.reversed webhook never
// double-counts. B-674-4 closed codes only. B-676-1 writer postings.
import 'reflect-metadata';
import { Logger, type INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import * as Sentry from '@sentry/node';
import { JwtAuthGuard } from '../src/auth/auth.guard';
import { RolesGuard } from '../src/auth/roles.guard';
import { ServiceTokenGuard } from '../src/auth/service-token.guard';
import { CheckoutModule } from '../src/checkout/checkout.module';
import { RefundDisputeHandlerService } from '../src/checkout/refund-dispute-handler.service';
import { RefundTransferReversalScheduler } from '../src/checkout/refund-transfer-reversal.scheduler';
import { SplitLedgerService } from '../src/connect/fees/split-ledger.service';
import { StripeConnectApiError } from '../src/connect/stripe-connect-api.service';
import {
  HOUR,
  harness,
  refundRow,
  seedPurchase,
  staleOwedRefund,
} from './support/refund-reversal-harness';

jest.mock('@sentry/node', () => ({
  ...jest.requireActual('@sentry/node'),
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));
const captureMessage = jest.mocked(Sentry.captureMessage);

type Row = Record<string, any>;
type H = ReturnType<typeof harness>;
const CANARY = 'PRIVATE_CANARY_client_at_example_invalid';
const rowOf = (h: H, model: string, id: string): Row => {
  const row = (h.db.state[model] as Row[]).find((r) => r.id === id);
  if (!row) throw new Error(`no ${model} ${id}`);
  return row;
};
const transferReversed = (id: string, total: number) => ({
  id: `evt_${id}_${total}`,
  type: 'transfer.reversed',
  data: { object: { id, amount_reversed: total, reversed: false } },
});

// A purchase (4,900) with a 245-cent head-coach transfer linked to its slice,
// and one owed refund per id (2,450 each: 122 head-coach cents).
function seeded(purchaseId: string, refunds: string[]): H {
  const h = harness();
  const at = new Date(Date.now() - HOUR);
  seedPurchase(h.db, purchaseId, at);
  const fee = rowOf(h, 'splitLedgerEntry', `${purchaseId}-application_fee`);
  h.db.state.splitLedgerEntry.push({
    ...fee,
    id: `${purchaseId}-head`,
    kind: 'head_coach_split',
    payee_user_id: 'head-1',
    amount_cents: 245,
  });
  rowOf(h, 'connectTransfer', `tr-${purchaseId}`).ledger_entry_id = `${purchaseId}-head`;
  for (const id of refunds) {
    h.db.state.chargeRefund.push(
      refundRow(id, purchaseId, at, { transfer_reversal_first_attempt_at: null }),
    );
  }
  return h;
}

// Stripe delivers transfer.reversed before the reversal request returns.
function webhookBeforeRecord(h: H): void {
  const provider = h.reverseTransfer.getMockImplementation()!;
  h.reverseTransfer.mockImplementation(async (args) => {
    const receipt = await provider(args);
    await h.svc.handle(transferReversed(args.transfer_id, h.stripeTotal(args.transfer_id)));
    return receipt;
  });
}

// The nth read of row `id` returns the old row; only then does a DIFFERENT
// refund's reversal of that row commit (READ COMMITTED, plain SELECT).
function commitBetweenReadAndWrite(
  h: H,
  model: string,
  id: string,
  nth: number,
  commit: () => void,
) {
  const m = h.db[model];
  const original = m.findUniqueOrThrow;
  let reads = 0;
  m.findUniqueOrThrow = async (args: { where: { id?: string } }) => {
    const row = await original(args);
    if (args.where.id === id && ++reads === nth) commit();
    return row;
  };
}

describe('B-674-1 — a concurrent reversal of another refund is added to, never overwritten (unit)', () => {
  it('transfer row and head-coach slice keep 122 + 50 when 50 commits between the record read and write', async () => {
    const h = seeded('p-cc', ['r-a']);
    // Read 1 is reverse()'s lookup before Stripe; read 2 is the record.
    commitBetweenReadAndWrite(h, 'connectTransfer', 'tr-p-cc', 2, () => {
      rowOf(h, 'connectTransfer', 'tr-p-cc').reversed_amount_cents += 50;
      rowOf(h, 'splitLedgerEntry', 'p-cc-head').reversed_cents += 50;
    });
    await h.svc.retryPendingTransferReversals();
    expect({
      done: h.refund('r-a').transfer_reversed,
      transfer: rowOf(h, 'connectTransfer', 'tr-p-cc').reversed_amount_cents,
      slice: rowOf(h, 'splitLedgerEntry', 'p-cc-head').reversed_cents,
    }).toEqual({ done: true, transfer: 172, slice: 172 });
  });
});

describe('B-674-2 / C-674-6 — owner recovery routes over HTTP with the real guards', () => {
  const live = { deleted_at: null, deletion_scheduled_at: null };
  const users: Record<string, Row> = {
    owner: { id: 'owner-1', role: 'owner', ...live },
    coach: { id: 'coach-9', role: 'coach', ...live },
    student: { id: 'student-9', role: 'student', ...live },
    deleted: { id: 'owner-2', role: 'owner', deleted_at: new Date(), deletion_scheduled_at: null },
  };
  const result = {
    charge_refund_id: 'r-1',
    outcome: 'recorded_from_stripe',
    stripe_transfer_reversal_id: 'trr_1',
    amount_cents: 122,
  };
  const refundDispute = {
    listTransferReversalsInReview: jest.fn(async () => [] as unknown[]),
    reconcileTransferReversal: jest.fn(async (_id: string, _body: unknown) => result),
  };
  let app: INestApplication;
  let base: string;
  const oldToken = process.env.ADMIN_SERVICE_TOKEN;

  beforeAll(async () => {
    process.env.ADMIN_SERVICE_TOKEN = 'opaque-service-token';
    const jwt = Reflect.construct(JwtAuthGuard, [
      { user: { findUnique: async ({ where }: Row) => users[where.supabase_id] ?? null } },
      {
        verify: async (token: string) => {
          if (!token.startsWith('jwt-')) throw new Error('not a JWT');
          return { sub: token.slice(4) };
        },
      },
      new Reflector(),
      { emit: jest.fn() },
    ]);
    // Every controller CheckoutModule mounts, so the route resolves wherever it lives.
    const moduleRef = await Test.createTestingModule({
      controllers: Reflect.getMetadata('controllers', CheckoutModule),
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(jwt)
      .overrideGuard(ServiceTokenGuard)
      .useValue(new ServiceTokenGuard())
      .overrideGuard(RolesGuard)
      .useValue(new RolesGuard(new Reflector()))
      .useMocker((t) => (t === RefundDisputeHandlerService ? refundDispute : {}))
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/v1/admin/payments/refund-reversals`;
  });
  afterAll(async () => {
    await app?.close();
    if (oldToken === undefined) delete process.env.ADMIN_SERVICE_TOKEN;
    else process.env.ADMIN_SERVICE_TOKEN = oldToken;
  });

  const call = (path: string, auth?: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('an owner JWT lists (200) and reconciles (201)', async () => {
    const list = await call('/review', 'jwt-owner');
    expect([list.status, await list.json()]).toEqual([200, { refunds: [] }]);
    const rec = await call('/r-1/reconcile', 'jwt-owner', { stripe_transfer_reversal_id: 'trr_1' });
    expect(rec.status).toBe(201);
    expect(refundDispute.reconcileTransferReversal).toHaveBeenCalledWith('r-1', {
      stripe_transfer_reversal_id: 'trr_1',
      confirm_none_in_stripe: false,
    });
  });

  it('a Stripe failure during reconcile is a coded 503 with no provider text', async () => {
    refundDispute.reconcileTransferReversal.mockRejectedValueOnce(
      new StripeConnectApiError(CANARY, 503, null, 'request_timeout'),
    );
    const rec = await call('/r-1/reconcile', 'jwt-owner', {});
    const body = await rec.text();
    expect([rec.status, JSON.parse(body).code, body.includes(CANARY)]).toEqual([
      503,
      'RECONCILE_STRIPE_UNAVAILABLE',
      false,
    ]);
  });

  it.each([
    ['coach JWT', 'jwt-coach', 403],
    ['student JWT', 'jwt-student', 403],
    ['deleted owner JWT', 'jwt-deleted', 403],
    ['service token (not a JWT)', 'opaque-service-token', 401],
    ['no token', undefined, 401],
  ])('%s is refused', async (_label, auth, status) => {
    refundDispute.reconcileTransferReversal.mockClear();
    expect([
      (await call('/review', auth)).status,
      (await call('/r-1/reconcile', auth, {})).status,
    ]).toEqual([status, status]);
    expect(refundDispute.reconcileTransferReversal).not.toHaveBeenCalled();
  });
});

describe('B-674-3 — one Stripe reversal is recorded once, wherever the webhook lands', () => {
  it('webhook before each record: both 122-cent shares reach Stripe and are recorded (244, not 123)', async () => {
    const h = seeded('p-race', ['r-one', 'r-two']);
    webhookBeforeRecord(h);
    await h.svc.retryPendingTransferReversals();
    expect({
      done: [h.refund('r-one').transfer_reversed, h.refund('r-two').transfer_reversed],
      amounts: h.reversals.map((r) => r.amount),
      stripe: h.stripeTotal('tr_p-race'),
      recorded: h.headCoach('p-race'),
      slice: rowOf(h, 'splitLedgerEntry', 'p-race-head').reversed_cents,
    }).toEqual({ done: [true, true], amounts: [122, 122], stripe: 244, recorded: 244, slice: 244 });
  });

  it('owner reconcile after the webhook records the Stripe reversal once (122 = Stripe)', async () => {
    const h = await staleOwedRefund();
    await h.svc.handle(transferReversed('tr_p-late', 122));
    await h.svc.retryPendingTransferReversals();
    const out = await h.svc.reconcileTransferReversal('r-late');
    expect([out.outcome, h.stripeTotal('tr_p-late'), h.headCoach('p-late')]).toEqual([
      'recorded_from_stripe',
      122,
      122,
    ]);
  });

  it('a timed-out full reversal mirrored by the webhook is retried with the same amount and recorded once', async () => {
    const h = seeded('p-to', ['r-to']);
    rowOf(h, 'chargeRefund', 'r-to').amount_cents = 4900;
    const made = h.reverseTransfer.getMockImplementation()!;
    h.reverseTransfer.mockImplementationOnce(async (args) => {
      await made(args);
      await h.svc.handle(transferReversed(args.transfer_id, h.stripeTotal(args.transfer_id)));
      throw new StripeConnectApiError('timed out', 503, null, 'request_timeout');
    });
    await h.svc.retryPendingTransferReversals();
    expect(h.refund('r-to')).toMatchObject({
      transfer_reversed: false,
      transfer_reversal_amount_cents: 245,
    });
    await h.svc.retryPendingTransferReversals(new Date(Date.now() + HOUR));
    expect({
      done: h.refund('r-to').transfer_reversed,
      sent: h.reverseTransfer.mock.calls.map(([a]) => a.amount),
      stripe: h.stripeTotal('tr_p-to'),
      recorded: h.headCoach('p-to'),
      slice: rowOf(h, 'splitLedgerEntry', 'p-to-head').reversed_cents,
    }).toEqual({ done: true, sent: [245, 245], stripe: 245, recorded: 245, slice: 245 });
  });

  it('stale or repeated webhooks change nothing that was recorded', async () => {
    const h = seeded('p-st', ['r-st']);
    await h.svc.retryPendingTransferReversals();
    for (const total of [0, 122, 122, 60, 245])
      await h.svc.handle(transferReversed('tr_p-st', total));
    const tr = rowOf(h, 'connectTransfer', 'tr-p-st');
    expect([tr.reversed_amount_cents, tr.status]).toEqual([122, 'succeeded']);
  });
});

describe('B-674-4 — a failed retry sweep reports closed codes only', () => {
  it.each([
    ['Error', Object.assign(new Error(CANARY), { name: `X${CANARY}`, code: CANARY })],
    ['Stripe error', new StripeConnectApiError(CANARY, 500, CANARY, CANARY)],
    ['thrown string', CANARY],
  ])('%s with private text', async (_label, thrown) => {
    captureMessage.mockClear();
    const scheduler = Reflect.construct(RefundTransferReversalScheduler, [
      { retryPendingTransferReversals: async () => Promise.reject(thrown) },
    ]);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      await scheduler.handleCron();
      const reported = JSON.stringify([error.mock.calls, captureMessage.mock.calls]);
      expect(reported).toContain('code=REFUND_TRANSFER_REVERSAL_SWEEP_FAILED');
      expect(reported).not.toContain(CANARY);
      expect(captureMessage.mock.calls[0]?.[1]).toMatchObject({
        tags: { code: 'REFUND_TRANSFER_REVERSAL_SWEEP_FAILED' },
      });
    } finally {
      error.mockRestore();
    }
  });
});

// The per-event cents through the real writer and the Money reader (99 / 101
// cents, lost chargeback, delayed head-coach reversal) are in #677.
describe('B-676-1 (writer, #674) — one event posts to one slice once', () => {
  it('the same event posting to the same slice again (redelivery) changes nothing', async () => {
    const h = seeded('p-dup', []);
    const ledger = Reflect.construct(SplitLedgerService, [h.db]);
    const args = {
      entry_id: 'p-dup-destination',
      reversed_cents: 4802,
      source: { kind: 'dispute', id: 'cd-1', at: new Date() },
    };
    for (let i = 0; i < 2; i++)
      await h.db.$transaction((tx: unknown) => ledger.applyReversal(args, tx));
    expect(rowOf(h, 'splitLedgerEntry', 'p-dup-destination').reversed_cents).toBe(4802);
    expect((h.db.state.splitLedgerReversal as Row[]).map((p) => p.cents)).toEqual([4802]);
  });
});
