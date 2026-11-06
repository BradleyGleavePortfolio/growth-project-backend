// FIX-1225 (b): every money-bearing purchase state is checked, and a purchase
// that never charged is not "could not be confirmed yet".
//
// The real ReconciliationService over one in-memory purchase at a time;
// Stripe is a stand-in. No live Stripe, no network, no database.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import {
  RECONCILED_PURCHASE_STATUSES,
  ReconciliationService,
} from '../src/connect/fees/reconciliation.service';

interface Case {
  name: string;
  status: string;
  pi?: string | null;
  trial?: boolean;
  /** Destination + fee slices with what was reversed on them; empty = nothing recorded. */
  ledger?: Array<{ kind: string; amount_cents: number; reversed_cents: number; stripe_charge_id?: string }>;
  charge?: { amount: number; amount_refunded: number } | 'none';
  disputes?: Array<{ status: string; amount_cents: number; ledger_reversed: boolean }>;
  expect: { status: 'ok' | 'drift' | 'unknown'; notes?: string | null; disputeRead?: boolean };
}

const PAID_LEDGER = [
  { kind: 'destination', amount_cents: 9_800, reversed_cents: 0 },
  { kind: 'application_fee', amount_cents: 200, reversed_cents: 0 },
];
/** The handler's reversal: the whole 10,000 cents taken back across both slices. */
const REVERSED_LEDGER = [
  { kind: 'destination', amount_cents: 9_800, reversed_cents: 9_800 },
  { kind: 'application_fee', amount_cents: 200, reversed_cents: 200 },
];

function world(c: Case) {
  const purchase = {
    id: 'p1',
    status: c.status,
    source: null,
    amount_cents: 10_000,
    stripe_payment_intent_id: c.pi === undefined ? 'pi_1' : c.pi,
    trial_started_at: c.trial ? new Date('2026-10-01T00:00:00Z') : null,
    updated_at: new Date('2026-10-01T00:00:00Z'),
  };
  const ledger = (c.ledger ?? []).map((r) => ({ purchase_id: 'p1', status: 'posted', ...r }));
  const snapshots: any[] = [];
  const prisma = {
    clientPurchase: {
      findMany: jest.fn(async ({ where }: any) => (where.status.in.includes(purchase.status) ? [purchase] : [])),
      findUnique: jest.fn(async () => purchase),
    },
    splitLedgerEntry: {
      findMany: jest.fn(async () => ledger),
      findFirst: jest.fn(async () => ledger.find((r) => r.kind === 'destination') ?? null),
    },
    connectTransfer: { findMany: jest.fn(async () => []) },
    chargeSettlement: { findMany: jest.fn(async () => []) },
    payeeRecovery: { findMany: jest.fn(async () => []) },
    chargeDispute: {
      findMany: jest.fn(async ({ where }: any) =>
        (c.disputes ?? [])
          .filter((d) => d.status === where.status)
          .map((d) => ({ amount_cents: d.amount_cents })),
      ),
    },
    reconciliationSnapshot: {
      upsert: jest.fn(async ({ create }: any) => {
        snapshots.push(create);
        return create;
      }),
    },
  };
  const stripe = {
    retrievePaymentIntent: jest.fn(async (id: string) => ({
      id,
      latest_charge: c.charge === 'none' ? null : `ch_${id}`,
    })),
    retrieveCharge: jest.fn(async (id: string) => {
      const ch = c.charge === 'none' || !c.charge ? { amount: 10_000, amount_refunded: 0 } : c.charge;
      return { id, ...ch, application_fee_amount: 200 };
    }),
  };
  return { svc: new ReconciliationService(prisma as any, stripe as any), prisma, stripe, snapshots };
}

const CASES: Case[] = [
  // LS-1225 B2: the refund and dispute handlers' states are read, and each can still be wrong.
  { name: 'refunded in full, ledger reversed in full', status: 'refunded', ledger: REVERSED_LEDGER,
    charge: { amount: 10_000, amount_refunded: 10_000 }, expect: { status: 'ok' } },
  { name: 'refunded at Stripe, ledger never reversed', status: 'refunded', ledger: PAID_LEDGER,
    charge: { amount: 10_000, amount_refunded: 10_000 }, expect: { status: 'drift', disputeRead: false } },
  { name: 'restarted after a lost dispute (status back to paid), ledger reversed by it', status: 'paid', ledger: REVERSED_LEDGER,
    charge: { amount: 10_000, amount_refunded: 0 },
    disputes: [{ status: 'lost', amount_cents: 10_000, ledger_reversed: true }],
    expect: { status: 'ok', disputeRead: true } },
  { name: 'dispute open, nothing reversed yet', status: 'disputed', ledger: PAID_LEDGER,
    charge: { amount: 10_000, amount_refunded: 0 }, expect: { status: 'ok', disputeRead: false } },
  { name: 'dispute open, ledger short', status: 'disputed',
    ledger: [{ kind: 'destination', amount_cents: 9_300, reversed_cents: 0 }, { kind: 'application_fee', amount_cents: 200, reversed_cents: 0 }],
    charge: { amount: 10_000, amount_refunded: 0 }, expect: { status: 'drift' } },
  { name: 'chargeback lost, ledger reversed by the lost dispute', status: 'chargeback_lost', ledger: REVERSED_LEDGER,
    charge: { amount: 10_000, amount_refunded: 0 },
    disputes: [{ status: 'lost', amount_cents: 10_000, ledger_reversed: true }],
    expect: { status: 'ok', disputeRead: true } },
  { name: 'chargeback lost, ledger reversed with no lost dispute on record', status: 'chargeback_lost', ledger: REVERSED_LEDGER,
    charge: { amount: 10_000, amount_refunded: 0 },
    disputes: [{ status: 'won', amount_cents: 10_000, ledger_reversed: false }],
    expect: { status: 'drift', disputeRead: true } },
  { name: 'chargeback lost, dispute recorded but the ledger never reversed', status: 'chargeback_lost', ledger: PAID_LEDGER,
    charge: { amount: 10_000, amount_refunded: 0 },
    disputes: [{ status: 'lost', amount_cents: 10_000, ledger_reversed: false }],
    expect: { status: 'drift', disputeRead: true } },
  // LO-1225 B1: never charged is 'ok' (never_charged), not "could not be confirmed yet".
  { name: 'free trial canceled before any charge', status: 'canceled', pi: null, trial: true,
    expect: { status: 'ok', notes: 'never_charged' } },
  { name: 'trial whose first charge failed (past_due)', status: 'past_due', pi: null, trial: true,
    expect: { status: 'ok', notes: 'never_charged' } },
  { name: 'canceled before any charge, no trial', status: 'canceled', pi: null,
    expect: { status: 'ok', notes: 'never_charged' } },
  // Still "could not be confirmed yet": a paid state with nothing recorded, or a payment intent with no charge.
  { name: 'paid with nothing recorded', status: 'paid', pi: null, expect: { status: 'unknown', notes: 'no_charge_id_yet' } },
  { name: 'active with nothing recorded', status: 'active', pi: null, trial: true, expect: { status: 'unknown', notes: 'no_charge_id_yet' } },
  { name: 'canceled with a payment intent and no charge', status: 'canceled', pi: 'pi_1', charge: 'none',
    expect: { status: 'unknown', notes: 'no_charge_id_yet' } },
  { name: 'refunded with nothing recorded', status: 'refunded', pi: null, expect: { status: 'unknown', notes: 'no_charge_id_yet' } },
];

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterAll(() => jest.restoreAllMocks());

describe('FIX-1225 (b): the money check reads every money state', () => {
  it.each(CASES)('$name ($status) -> $expect.status', async (c) => {
    const { svc, prisma, snapshots } = world(c);
    const r = await svc.runSweep(50, { staleBefore: new Date() });
    expect(r.scanned).toBe(1);
    expect(r.outcomes).toEqual([{ purchase_id: 'p1', status: c.expect.status }]);
    if (c.expect.notes !== undefined) expect(snapshots[0].notes).toBe(c.expect.notes);
    if (c.expect.disputeRead !== undefined) {
      expect(prisma.chargeDispute.findMany).toHaveBeenCalledTimes(c.expect.disputeRead ? 1 : 0);
    }
  });

  it('every purchase state the refund and dispute handler writes is in the shared selection', () => {
    const src = readFileSync(join(__dirname, '../src/checkout/refund-dispute-handler.service.ts'), 'utf8');
    // The first `data:` after each clientPurchase.update / updateMany, when it sets a status.
    const written: string[] = [];
    for (const m of src.matchAll(/clientPurchase\.update(?:Many)?\(\{/g)) {
      const d = src.slice(m.index).match(/data: \{ ?status: '([a-z_]+)'|data:/);
      if (d?.[1]) written.push(d[1]);
    }
    expect(new Set(written)).toEqual(new Set(['refunded', 'chargeback_lost', 'paid', 'disputed']));
    for (const s of written) expect(RECONCILED_PURCHASE_STATUSES).toContain(s);
  });

  it('a lost-dispute read asks for this purchase, this charge and lost disputes only', async () => {
    const c = CASES.find((x) => x.name.startsWith('chargeback lost, ledger reversed by'))!;
    const { svc, prisma } = world(c);
    await svc.runSweep(50, { staleBefore: new Date() });
    expect(prisma.chargeDispute.findMany).toHaveBeenCalledWith({
      where: { purchase_id: 'p1', stripe_charge_id: 'ch_pi_1', status: 'lost' },
      select: { amount_cents: true },
    });
  });
});
