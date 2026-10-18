// C5RECEIPTS — GET /v1/checkout/receipts[/:id]: the signed-in client's own
// receipts, refunds and paid-this-year total, all computed on the server.
//
// The Prisma double behaves like Prisma for the reads the service makes: the
// `purchase.client_user_id` filter is applied (a service that forgot it would
// list another client's charges here), cursor paging follows the orderBy, and
// a `select` returns only the selected fields while a missing one returns the
// whole stored row, fee and payout columns included.
import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { CheckoutController } from '../src/checkout/checkout.controller';
import { ClientReceiptsController } from '../src/checkout/client-receipts.controller';
import {
  ClientReceiptsService,
  receiptMoney,
  type ClientReceipt,
} from '../src/checkout/client-receipts.service';
import { ROLES_KEY } from '../src/common/decorators/roles.decorator';
import { SKIP_CLIENT_ENTITLEMENT_KEY } from '../src/common/decorators/skip-client-entitlement.decorator';
import {
  StripeConnectApiService,
  type StripeChargeObject,
} from '../src/connect/stripe-connect-api.service';
import type { PrismaService } from '../src/prisma.service';

type Row = Record<string, any>;
const wire = <T>(value: object): T => value as T;

const [CLIENT_A, CLIENT_B, COACH] = ['client-a', 'client-b', 'coach-sam'];
const RECEIPT_KEYS = ['amount_cents', 'card_brand', 'card_last4', 'charged_at', 'coach_name']
  .concat(['currency', 'id', 'net_cents', 'number', 'period_end', 'period_start', 'plan_name'])
  .concat(['receipt_url', 'refunded_cents', 'refunds', 'statement_descriptor', 'status']);
const FORBIDDEN_KEY =
  /fee|payout|split|transfer|account|bps|coach_net|target|destination|client_user|coach_user|stripe/i;

interface Store {
  purchases: Row[];
  settlements: Row[];
  refunds: Row[];
  users: Row[];
  prefs: Row[];
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function project(row: Row, select?: Row): Row {
  if (!select) return row;
  const out: Row = {};
  for (const [k, v] of Object.entries(select)) {
    if (v === true) out[k] = row[k] ?? null;
    else if (v && typeof v === 'object' && row[k]) out[k] = project(row[k], v.select);
  }
  return out;
}

function makePrisma(store: Store) {
  const hydrate = (s: Row): Row => {
    const purchase = store.purchases.find((p) => p.id === s.purchase_id) ?? {};
    return { ...s, purchase: { ...purchase, package: purchase.package } };
  };
  const matches = (s: Row, where: Row): boolean =>
    (where.id === undefined || s.id === where.id) &&
    (where.purchase?.client_user_id === undefined ||
      s.purchase.client_user_id === where.purchase.client_user_id) &&
    (where.created_at?.gte === undefined || s.created_at >= where.created_at.gte);
  const newestFirst = (a: Row, b: Row) =>
    b.created_at.getTime() - a.created_at.getTime() || (a.id < b.id ? 1 : -1);
  const settlementFindMany = jest.fn(async (args: Row) => {
    let rows = store.settlements.map(hydrate).filter((s) => matches(s, args.where ?? {}));
    rows.sort(newestFirst);
    if (args.cursor) {
      const at = rows.findIndex((r) => r.id === args.cursor.id);
      rows = at < 0 ? [] : rows.slice(at + (args.skip ?? 0));
    }
    if (args.take) rows = rows.slice(0, args.take);
    return rows.map((r) => project(r, args.select));
  });
  const settlementFindFirst = jest.fn(async (args: Row) => {
    const row = store.settlements.map(hydrate).find((s) => matches(s, args.where ?? {}));
    return row ? project(row, args.select) : null;
  });
  return {
    chargeSettlement: { findMany: settlementFindMany, findFirst: settlementFindFirst },
    chargeRefund: {
      findMany: jest.fn(async (args: Row) =>
        store.refunds
          .filter(
            (r) =>
              args.where.stripe_charge_id.in.includes(r.stripe_charge_id) &&
              r.status === args.where.status,
          )
          .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
          .map((r) => project(r, args.select)),
      ),
    },
    user: {
      findMany: jest.fn(async (args: Row) =>
        store.users.filter((u) => args.where.id.in.includes(u.id)).map((u) => project(u, args.select)),
      ),
      findUnique: jest.fn(async (args: Row) => {
        const u = store.users.find((x) => x.id === args.where.id);
        return u ? project(u, args.select) : null;
      }),
    },
    notificationPreferences: {
      findUnique: jest.fn(async (args: Row) => {
        const p = store.prefs.find((x) => x.user_id === args.where.user_id);
        return p ? project(p, args.select) : null;
      }),
    },
    coachProfile: { findUnique: jest.fn(async () => null) },
    coachingSession: { findUnique: jest.fn(async () => null) },
  };
}

class StripeStub extends StripeConnectApiService {
  charges = new Map<string, StripeChargeObject>();
  calls: Array<{ id: string; expandInvoice?: boolean }> = [];
  failing = false;
  async retrieveCharge(
    chargeId: string,
    opts: { expandBalanceTransaction?: boolean; expandInvoice?: boolean } = {},
  ): Promise<StripeChargeObject> {
    this.calls.push({ id: chargeId, expandInvoice: opts.expandInvoice });
    if (this.failing) throw new Error('stripe down');
    return this.charges.get(chargeId) ?? { id: chargeId, amount: 0 };
  }
}

function purchase(id: string, client: string, over: Row = {}): Row {
  return {
    id, client_user_id: client, coach_user_id: COACH, currency: 'usd', amount_cents: 14900,
    stripe_destination_account: 'acct_PLANTED_COACH', stripe_client_secret: 'pi_PLANTED_secret',
    package: { name: 'Monthly coaching' },
    ...over,
  };
}

function settlement(n: number, purchaseId: string, createdAt: string, over: Row = {}): Row {
  return {
    id: uuid(n), purchase_id: purchaseId, coach_user_id: COACH, head_coach_user_id: 'head-PLANTED',
    stripe_charge_id: `ch_${n}`, stripe_invoice_id: `in_${n}`, currency: 'usd', gross_cents: 14900,
    // Fee, split and payout columns a receipt must never carry.
    platform_bps: 200, platform_fee_cents: 298, stripe_fee_cents: 462, coach_net_cents: 14140,
    target_platform_fee_cents: 298, target_coach_net_cents: 14140, status: 'settled',
    created_at: new Date(createdAt),
    ...over,
  };
}

function refund(n: number, chargeId: string, cents: number, at: string, status = 'succeeded'): Row {
  return {
    id: `rf-${n}`, stripe_charge_id: chargeId, amount_cents: cents, currency: 'usd', status,
    initiated_by_user_id: 'owner-PLANTED', note: 'PLANTED note', created_at: new Date(at),
  };
}

function baseStore(): Store {
  return {
    purchases: [purchase('pur-a', CLIENT_A), purchase('pur-b', CLIENT_B)],
    settlements: [
      settlement(1, 'pur-a', '2026-08-14T17:00:00Z'),
      settlement(2, 'pur-a', '2026-09-14T17:00:00Z'),
      settlement(3, 'pur-a', '2026-10-14T17:00:00Z'),
      settlement(9, 'pur-b', '2026-10-01T17:00:00Z'),
    ],
    refunds: [],
    users: [
      { id: COACH, name: 'Sam', email: 'coach-PLANTED' },
      { id: CLIENT_A, name: 'Jordan', coach_id: COACH },
      { id: CLIENT_B, name: 'Riley', coach_id: COACH },
    ],
    // A zone the client's device supplied (stamped), as recipient-timezone.ts requires.
    prefs: [{ user_id: CLIENT_A, timezone: 'America/Los_Angeles', timezone_updated_at: new Date() }],
  };
}

function make(store: Store = baseStore()) {
  const prisma = makePrisma(store);
  const stripe = new StripeStub();
  const svc = new ClientReceiptsService(wire<PrismaService>(prisma), stripe);
  return { svc, prisma, stripe, store };
}

function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) allKeys(v, out.add(k));
  }
  return out;
}

beforeEach(() => {
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'queueMicrotask'],
  });
  jest.setSystemTime(new Date('2026-10-14T16:41:00Z'));
});
afterEach(() => jest.useRealTimers());

describe('client scoping', () => {
  it('lists only the signed-in client own charges, newest first', async () => {
    const { svc, prisma } = make();
    const res = await svc.list(CLIENT_A);
    expect(res.receipts.map((r) => r.id)).toEqual([uuid(3), uuid(2), uuid(1)]);
    expect(prisma.chargeSettlement.findMany.mock.calls[0][0].where).toEqual({
      purchase: { client_user_id: CLIENT_A },
    });
    const b = await svc.list(CLIENT_B);
    expect(b.receipts.map((r) => r.id)).toEqual([uuid(9)]);
  });

  it("answers 404 for another client's receipt, the same as an unknown id", async () => {
    const { svc } = make();
    await expect(svc.get(CLIENT_A, uuid(3))).resolves.toMatchObject({ id: uuid(3) });
    const foreign = await svc.get(CLIENT_B, uuid(3)).catch((e: NotFoundException) => e);
    const unknown = await svc.get(CLIENT_B, uuid(404)).catch((e: NotFoundException) => e);
    expect(foreign).toBeInstanceOf(NotFoundException);
    expect(foreign).toEqual(unknown);
    expect(foreign).toMatchObject({ status: 404, response: { code: 'RECEIPT_NOT_FOUND' } });
  });

  it('a coach reading receipts sees only charges they paid, never their clients', async () => {
    const { svc } = make();
    const res = await svc.list(COACH);
    expect(res.receipts).toEqual([]);
    await expect(svc.get(COACH, uuid(3))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('uses the same role rule and entitlement skip as GET /v1/checkout/purchases', () => {
    const purchasesRoles = Reflect.getMetadata(ROLES_KEY, CheckoutController.prototype.listPurchases);
    const { list, get } = ClientReceiptsController.prototype;
    for (const handler of [list, get]) {
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(purchasesRoles);
      expect(Reflect.getMetadata(SKIP_CLIENT_ENTITLEMENT_KEY, handler)).toBe(true);
    }
  });

  it('the controller scopes to req.user.id', async () => {
    const { svc } = make();
    const controller = new ClientReceiptsController(svc);
    const req = wire<Parameters<ClientReceiptsController['list']>[0]>({ user: { id: CLIENT_B } });
    const res = await controller.list(req, undefined, '10');
    expect(res.receipts.map((r) => r.id)).toEqual([uuid(9)]);
    await expect(controller.get(req, uuid(3))).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('refund maths (succeeded ChargeRefund rows)', () => {
  it('full, partial and multiple refunds; pending and failed refunds do not count', async () => {
    const store = baseStore();
    store.refunds = [
      refund(1, 'ch_1', 14900, '2026-08-20T00:00:00Z'),
      refund(2, 'ch_2', 7450, '2026-09-22T00:00:00Z'),
      refund(3, 'ch_3', 1000, '2026-10-15T00:00:00Z'),
      refund(4, 'ch_3', 500, '2026-10-16T00:00:00Z'),
      refund(5, 'ch_3', 2000, '2026-10-17T00:00:00Z'),
      refund(6, 'ch_3', 3000, '2026-10-18T00:00:00Z', 'pending'),
      refund(7, 'ch_3', 3000, '2026-10-18T00:00:00Z', 'failed'),
    ];
    const { svc } = make(store);
    const byId = new Map((await svc.list(CLIENT_A)).receipts.map((r) => [r.id, r] as const));
    expect(byId.get(uuid(1))).toMatchObject({ refunded_cents: 14900, net_cents: 0, status: 'refunded' });
    expect(byId.get(uuid(2))).toMatchObject({
      refunded_cents: 7450, net_cents: 7450, status: 'partly_refunded',
      refunds: [{ amount_cents: 7450, created_at: '2026-09-22T00:00:00.000Z' }],
    });
    expect(byId.get(uuid(3))).toMatchObject({
      refunded_cents: 3500, net_cents: 11400, status: 'partly_refunded',
    });
    expect(byId.get(uuid(3))?.refunds.map((r) => r.amount_cents)).toEqual([1000, 500, 2000]);
  });

  it('never goes below zero; paid this year sums net_cents after refunds', async () => {
    expect(receiptMoney(14900, 0)).toEqual({ net_cents: 14900, status: 'paid' });
    expect(receiptMoney(14900, 15000)).toEqual({ net_cents: 0, status: 'refunded' });
    const store = baseStore();
    store.refunds = [refund(2, 'ch_2', 7450, '2026-09-22T00:00:00Z')];
    const res = await make(store).svc.list(CLIENT_A);
    expect(res.summary).toEqual({ paid_this_year_cents: 14900 * 3 - 7450, currency: 'usd' });
  });
});

describe('year boundary in the client time zone', () => {
  it("counts the client's own calendar year, not UTC", async () => {
    // 2027-01-01 05:00 UTC is still 2026-12-31 21:00 in Los Angeles.
    jest.setSystemTime(new Date('2027-01-01T05:00:00Z'));
    const store = baseStore();
    store.settlements = [
      settlement(1, 'pur-a', '2025-12-31T09:00:00Z', { gross_cents: 1 }), // LA 2025
      settlement(2, 'pur-a', '2026-01-01T07:00:00Z', { gross_cents: 10 }), // LA 2025-12-31 23:00
      settlement(3, 'pur-a', '2026-12-31T20:00:00Z', { gross_cents: 100 }), // LA 2026
      settlement(4, 'pur-a', '2027-01-01T03:00:00Z', { gross_cents: 1000 }), // LA 2026-12-31 19:00
    ];
    const { svc } = make(store);
    const res = await svc.list(CLIENT_A);
    expect(res.summary).toEqual({ paid_this_year_cents: 1100, currency: 'usd' });
    expect(res.receipts).toHaveLength(4);
  });
});

describe('empty and not-yet-settled', () => {
  it('a client with no charges gets an empty list and a zero total', async () => {
    const { svc } = make();
    await expect(svc.list('client-new')).resolves.toEqual({
      receipts: [],
      next_cursor: null,
      summary: { paid_this_year_cents: 0, currency: null },
    });
  });

  it('a purchase with no settlement yet has no receipt and adds nothing', async () => {
    const store = baseStore();
    store.purchases.push(purchase('pur-new', 'client-c'));
    const { svc } = make(store);
    const res = await svc.list('client-c');
    expect(res.receipts).toEqual([]);
    expect(res.summary.paid_this_year_cents).toBe(0);
    await expect(svc.get('client-c', uuid(1))).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('response keys', () => {
  it('never carries the TGP fee, the coach payout, a Stripe account or another client', async () => {
    const store = baseStore();
    store.refunds = [refund(2, 'ch_2', 7450, '2026-09-22T00:00:00Z')];
    const { svc } = make(store);
    const list = await svc.list(CLIENT_A);
    const one = await svc.get(CLIENT_A, uuid(2));
    expect(Object.keys(list).sort()).toEqual(['next_cursor', 'receipts', 'summary']);
    expect(Object.keys(list.summary).sort()).toEqual(['currency', 'paid_this_year_cents']);
    for (const r of [...list.receipts, one]) {
      expect(Object.keys(r).sort()).toEqual(RECEIPT_KEYS);
      for (const x of r.refunds) expect(Object.keys(x).sort()).toEqual(['amount_cents', 'created_at']);
    }
    for (const key of allKeys([list, one])) expect(key).not.toMatch(FORBIDDEN_KEY);
    const text = JSON.stringify([list, one]);
    for (const planted of ['PLANTED', '298', '14140', '462', 'Riley', CLIENT_B]) {
      expect(text).not.toContain(planted);
    }
  });
});

describe('Stripe-only fields', () => {
  // Stripe's JSON as it arrives: the expanded invoice and the card details
  // are wider than the client's typed view of a charge.
  const invoiceCharge = wire<StripeChargeObject>({
    id: 'ch_3',
    amount: 14900,
    currency: 'usd',
    receipt_number: '1482-0931',
    receipt_url: 'https://pay.stripe.com/receipts/example',
    calculated_statement_descriptor: 'TGP*SAM COACHING',
    payment_method_details: { type: 'card', card: { brand: 'visa', last4: '4242' } },
    invoice: {
      id: 'in_3',
      lines: {
        data: [
          { type: 'invoiceitem', period: { start: 1, end: 2 } },
          { type: 'subscription', period: { start: 1792000000, end: 1794600000 } },
        ],
      },
    },
  });

  it('come from the charge with its invoice, plan and coach from the purchase', async () => {
    const { svc, stripe } = make();
    stripe.charges.set('ch_3', invoiceCharge);
    const r: ClientReceipt = await svc.get(CLIENT_A, uuid(3));
    expect(r).toMatchObject({
      number: '1482-0931', card_brand: 'visa', card_last4: '4242',
      statement_descriptor: 'TGP*SAM COACHING', receipt_url: 'https://pay.stripe.com/receipts/example',
      period_start: new Date(1792000000 * 1000).toISOString(),
      period_end: new Date(1794600000 * 1000).toISOString(),
      plan_name: 'Monthly coaching', coach_name: 'Sam', charged_at: '2026-10-14T17:00:00.000Z',
    });
    expect(stripe.calls).toEqual([{ id: 'ch_3', expandInvoice: true }]);
  });

  it('a Stripe failure leaves them null and the money unchanged; answers are cached', async () => {
    const { svc, stripe } = make();
    stripe.failing = true;
    const res = await svc.list(CLIENT_A);
    expect(res.receipts[0]).toMatchObject({ amount_cents: 14900, net_cents: 14900, status: 'paid' });
    for (const key of ['number', 'card_brand', 'card_last4', 'statement_descriptor', 'receipt_url']) {
      expect(res.receipts[0]).toHaveProperty(key, null);
    }
    expect(res.receipts[0]).toMatchObject({ period_start: null, period_end: null });
    const callsAfterFirst = stripe.calls.length;
    expect(callsAfterFirst).toBe(3);
    await svc.list(CLIENT_A);
    expect(stripe.calls.length).toBe(callsAfterFirst);
  });

  it('a converted charge shows what the card paid, in its own currency', async () => {
    const store = baseStore();
    store.purchases[0].currency = 'gbp';
    store.settlements = [settlement(1, 'pur-a', '2026-10-01T17:00:00Z', { gross_cents: 18800 })];
    store.refunds = [{ ...refund(1, 'ch_1', 4900, '2026-10-02T00:00:00Z'), currency: 'gbp' }];
    const { svc, stripe } = make(store);
    stripe.charges.set('ch_1', { id: 'ch_1', amount: 14900, currency: 'gbp' });
    const res = await svc.list(CLIENT_A);
    expect(res.receipts[0]).toMatchObject({
      amount_cents: 14900, currency: 'gbp', net_cents: 10000, status: 'partly_refunded',
    });
    expect(res.summary).toEqual({ paid_this_year_cents: 10000, currency: 'gbp' });
  });
});

describe('cursor pagination', () => {
  it('pages newest first with next_cursor like the other checkout lists', async () => {
    const { svc } = make();
    const first = await svc.list(CLIENT_A, { limit: 2 });
    expect(first.receipts.map((r) => r.id)).toEqual([uuid(3), uuid(2)]);
    expect(first.next_cursor).toBe(uuid(2));
    const second = await svc.list(CLIENT_A, { limit: 2, cursor: first.next_cursor ?? '' });
    expect(second.receipts.map((r) => r.id)).toEqual([uuid(1)]);
    expect(second.next_cursor).toBeNull();
    expect(second.summary).toEqual(first.summary);
  });
});

describe('converted charge while Stripe is down (FIX1012 B1)', () => {
  // 14900 GBP paid on the card, settled as 18800 USD; refunds are in GBP. The
  // settlement's refund debits are in USD at each refund day's rate (ch_2: the
  // full 14900 GBP refund debited 18000 USD, less than the 18800 gross).
  function convertedStore(): Store {
    const store = baseStore();
    store.purchases[0].currency = 'gbp';
    store.settlements = [
      settlement(1, 'pur-a', '2026-10-01T17:00:00Z', { gross_cents: 18800, refunded_cents: 6180 }),
      settlement(2, 'pur-a', '2026-09-01T17:00:00Z', { gross_cents: 18800, refunded_cents: 18000 }),
      settlement(3, 'pur-a', '2026-08-01T17:00:00Z', { gross_cents: 18800, refunded_cents: 0 }),
    ];
    store.refunds = [
      { ...refund(1, 'ch_1', 4900, '2026-10-02T00:00:00Z'), currency: 'gbp' },
      { ...refund(2, 'ch_2', 14900, '2026-09-02T00:00:00Z'), currency: 'gbp' },
    ];
    return store;
  }
  const money = (r: ClientReceipt) =>
    [r.amount_cents, r.currency, r.refunded_cents, r.net_cents, r.status] as const;

  it('never takes card-currency refunds off the settlement gross; no yearly total', async () => {
    const { svc, stripe } = make(convertedStore());
    for (const n of [1, 2, 3]) {
      stripe.charges.set(`ch_${n}`, { id: `ch_${n}`, amount: 14900, currency: 'gbp' });
    }
    stripe.failing = true;
    const res = await svc.list(CLIENT_A);
    // Refunded but the amount is unknown: full or partial is unknown (null).
    expect(res.receipts.map(money)).toEqual([
      [null, 'gbp', 4900, null, null],
      [null, 'gbp', 14900, null, null],
      [null, 'gbp', 0, null, 'paid'],
    ]);
    expect(res.receipts[0].refunds).toEqual([
      { amount_cents: 4900, created_at: '2026-10-02T00:00:00.000Z' },
    ]);
    expect(res.summary).toEqual({ paid_this_year_cents: null, currency: null });
    const one = await svc.get(CLIENT_A, uuid(1));
    expect(money(one)).toEqual([null, 'gbp', 4900, null, null]);
    expect(JSON.stringify(res)).not.toMatch(/13900|18000|18800|"usd"|partly_refunded/);

    // Stripe answers again once the 60 s failure cache ends: the card amounts.
    stripe.failing = false;
    jest.setSystemTime(new Date('2026-10-14T16:42:30Z'));
    const back = await svc.list(CLIENT_A);
    expect(back.receipts.map(money)).toEqual([
      [14900, 'gbp', 4900, 10000, 'partly_refunded'],
      [14900, 'gbp', 14900, 0, 'refunded'],
      [14900, 'gbp', 0, 14900, 'paid'],
    ]);
    expect(back.summary).toEqual({ paid_this_year_cents: 24900, currency: 'gbp' });
  });

  it('a full refund settled at a lower rate never reads partly_refunded (FIX1022 B1)', async () => {
    const store = baseStore();
    store.purchases[0].currency = 'gbp';
    store.settlements = [
      settlement(1, 'pur-a', '2026-10-01T17:00:00Z', { gross_cents: 18800, refunded_cents: 18000 }),
    ];
    store.refunds = [{ ...refund(1, 'ch_1', 14900, '2026-10-02T00:00:00Z'), currency: 'gbp' }];
    const { svc, stripe } = make(store);
    stripe.charges.set('ch_1', { id: 'ch_1', amount: 14900, currency: 'gbp' });
    stripe.failing = true;
    const res = await svc.list(CLIENT_A);
    const one = await svc.get(CLIENT_A, uuid(1));
    for (const r of [res.receipts[0], one]) {
      expect(money(r)).toEqual([null, 'gbp', 14900, null, null]);
    }
    expect(res.summary).toEqual({ paid_this_year_cents: null, currency: null });
    expect(JSON.stringify([res, one])).not.toMatch(/partly_refunded|18000|18800|"usd"/);

    stripe.failing = false;
    jest.setSystemTime(new Date('2026-10-14T16:42:30Z'));
    const back = await svc.get(CLIENT_A, uuid(1));
    expect(money(back)).toEqual([14900, 'gbp', 14900, 0, 'refunded']);
  });
});

describe('Stripe reads stay on the returned page (FIX1012 B2)', () => {
  it('a one-row page of three converted receipts reads Stripe once on a cold cache', async () => {
    const store = baseStore();
    store.purchases[0].currency = 'gbp';
    store.settlements = ['2026-08-01', '2026-09-01', '2026-10-01']
      .map((day, i) => settlement(i + 1, 'pur-a', `${day}T17:00:00Z`, { gross_cents: 18800 }))
      .concat(settlement(9, 'pur-b', '2026-10-01T17:00:00Z'));
    const { svc, stripe } = make(store);
    for (const n of [1, 2, 3]) {
      stripe.charges.set(`ch_${n}`, { id: `ch_${n}`, amount: 14900, currency: 'gbp' });
    }
    const one = await svc.list(CLIENT_A, { limit: 1 });
    expect(one.receipts.map((r) => r.id)).toEqual([uuid(3)]);
    expect(stripe.calls.map((c) => c.id)).toEqual(['ch_3']);
    // Two of this year's charges were not read, so the total is unknown, not guessed.
    expect(one.summary).toEqual({ paid_this_year_cents: null, currency: null });

    const all = await svc.list(CLIENT_A, { limit: 3 });
    expect(stripe.calls.map((c) => c.id)).toEqual(['ch_3', 'ch_2', 'ch_1']);
    expect(all.summary).toEqual({ paid_this_year_cents: 44700, currency: 'gbp' });

    const again = await svc.list(CLIENT_A, { limit: 1 });
    expect(stripe.calls).toHaveLength(3);
    expect(again.summary).toEqual(all.summary);
    const other = await svc.list(CLIENT_B);
    expect(other.receipts.map((r) => r.id)).toEqual([uuid(9)]);
    expect(other.summary).toEqual({ paid_this_year_cents: 14900, currency: 'usd' });
  });

  it('the yearly total of same-currency receipts reads no Stripe at all', async () => {
    const { svc, stripe } = make();
    const res = await svc.list(CLIENT_A, { limit: 1 });
    expect(stripe.calls.map((c) => c.id)).toEqual(['ch_3']);
    expect(res.summary).toEqual({ paid_this_year_cents: 14900 * 3, currency: 'usd' });
  });
});
