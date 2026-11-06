// FIX-1225 (b): every money-bearing purchase state is checked, and a purchase
// that never charged is not "could not be confirmed yet".
//
// The real ReconciliationService over one in-memory purchase at a time;
// Stripe is a stand-in. No live Stripe, no network, no database.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Logger } from '@nestjs/common';
import {
  RECONCILED_PURCHASE_STATUSES,
  ReconciliationService,
  UNCHARGED_PURCHASE_STATUSES,
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
  /** ChargeSettlement rows of any status (FIX-1225R2 (b)); the settled read asks for 'settled' only. */
  settlements?: Array<{ status: string; mechanism?: string }>;
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
    chargeSettlement: {
      findMany: jest.fn(async ({ where }: any) =>
        (c.settlements ?? [])
          .map((r) => ({ purchase_id: 'p1', mechanism: 'separate_charge_transfer', stripe_charge_id: 'ch_s1', ...r }))
          .filter((r) => r.purchase_id === where.purchase_id)
          .filter((r) => where.mechanism === undefined || r.mechanism === where.mechanism)
          .filter((r) => where.status === undefined || r.status === where.status),
      ),
    },
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
  // FIX-1225R2 (a), LS-1225R2 B1: an unpaid renewal after paid periods is read, clean or not.
  { name: 'unpaid renewal, ledger matches Stripe', status: 'unpaid', ledger: PAID_LEDGER,
    charge: { amount: 10_000, amount_refunded: 0 }, expect: { status: 'ok' } },
  { name: 'unpaid renewal, ledger short', status: 'unpaid',
    ledger: [{ kind: 'destination', amount_cents: 9_300, reversed_cents: 0 }, { kind: 'application_fee', amount_cents: 200, reversed_cents: 0 }],
    charge: { amount: 10_000, amount_refunded: 0 }, expect: { status: 'drift' } },
  // FIX-1225R2 (b), LS-1225R2 B2 = LO-1225R2 C1: a ChargeSettlement row of any status is a charge, never never_charged.
  ...(['canceled', 'past_due', 'unpaid', 'trialing', 'paused'] as const).flatMap((status): Case[] => [
    { name: `${status}, no payment intent, a settlement awaiting its fee`, status, pi: null,
      settlements: [{ status: 'awaiting_fee' }],
      expect: { status: 'unknown', notes: 'settlement_not_settled charge=ch_s1 status=awaiting_fee' } },
    { name: `${status}, no payment intent, a legacy destination settlement`, status, pi: null,
      settlements: [{ status: 'legacy_destination', mechanism: 'legacy_destination' }],
      expect: { status: 'unknown', notes: 'settlement_not_settled charge=ch_s1 status=legacy_destination' } },
    { name: `${status}, no payment intent, no settlement of any status`, status, pi: null,
      settlements: [], expect: { status: 'ok', notes: 'never_charged' } },
  ]),
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

  // FIX-1225R2 (a), LS-1225R2 B1: the shared list is built from every status
  // any code writes to ClientPurchase.status. Each write in src is read; a
  // literal status must be classified, and a status written from a variable
  // must be in WRITTEN_FROM_VARIABLES with the values it can take. A new
  // writer or a new status fails here until it is classified.
  it('every status written to ClientPurchase.status is classified, and every money one is read', () => {
    const STRIPE_SUBSCRIPTION_STATUSES = [
      'active', 'past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'trialing', 'paused',
    ];
    /** `<file under src> <expression>` -> the statuses that expression can hold. */
    const WRITTEN_FROM_VARIABLES: Record<string, string[]> = {
      // :1418-1424 checkout completed: recurring ? 'active' : 'paid'.
      'checkout/checkout-webhook-handler.service.ts newStatus': ['active', 'paid'],
      // :1746 + :1849 and :2679 + :2715: normalizeSubscriptionStatus (:3269), Stripe's status or 'pending'.
      'checkout/checkout-webhook-handler.service.ts status': [...STRIPE_SUBSCRIPTION_STATUSES, 'pending'],
      // :2322 keeps the row's own status (a compare-and-set, no new status).
      'checkout/checkout-webhook-handler.service.ts purchase.status': [],
      // :2584 where: the version seen; data: failure = { status: 'payment_failed' } (:2443-2447).
      'checkout/checkout-webhook-handler.service.ts seen.status': [],
      'checkout/checkout-webhook-handler.service.ts data:failure': ['payment_failed'],
      // :1143 a delinquent plan takes Stripe's subscription status.
      'checkout/client-billing.service.ts subStatus': STRIPE_SUBSCRIPTION_STATUSES,
      // :1736-1750 keepPaidPeriod: 'active', or Stripe's status when active or trialing.
      'checkout/client-billing.service.ts status': ['active', 'trialing'],
      // :1660-1700 restart: 'active'.
      'checkout/dunning-v2/dunning-v2.service.ts status': ['active'],
      // $0 invite grants (:81, :89).
      'invite-grant/invite-grant.service.ts GRANT_PENDING_CONSENT_STATUS': ['pending_consent'],
      'invite-grant/invite-grant.service.ts GRANT_REVOKED_STATUS': ['revoked'],
      // :1961-1998 statusSnapshot.
      'storefront/guest-checkout.service.ts statusSnapshot': [
        'paid', 'active', 'trialing', 'past_due', 'canceled', 'incomplete', 'unpaid', 'expired',
      ],
    };
    const root = join(__dirname, '../src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) files.push(p);
      }
    };
    walk(root);
    const written = new Set<string>();
    const usedVariables = new Set<string>();
    const unclassifiedVariables: string[] = [];
    const literalsOf = (expr: string) => [...expr.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    const variable = (rel: string, expr: string) => {
      const key = `${rel} ${expr}`;
      if (!(key in WRITTEN_FROM_VARIABLES)) unclassifiedVariables.push(key);
      else {
        usedVariables.add(key);
        for (const s of WRITTEN_FROM_VARIABLES[key]) written.add(s);
      }
    };
    let writes = 0;
    for (const file of files) {
      const rel = relative(root, file).split(sep).join('/');
      // Comments out, so a comment that mentions a status is not a write.
      const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
      for (const m of src.matchAll(/clientPurchase\.(?:update|updateMany|create|createMany|upsert)\s*\(/g)) {
        writes += 1;
        let depth = 0;
        let i = m.index! + m[0].length - 1;
        for (; i < src.length; i++) {
          if (src[i] === '(') depth += 1;
          else if (src[i] === ')' && --depth === 0) break;
        }
        const call = src.slice(m.index!, i + 1);
        for (const s of call.matchAll(/(?<![.\w])status\s*:\s*([^,\n}]+)/g)) {
          const expr = s[1].trim();
          if (expr.startsWith('{') || expr === 'true') continue; // a where filter or a select
          for (const l of literalsOf(expr)) written.add(l);
          // A bare variable, or a variable on either side of a ternary.
          const sides = expr.includes('?') ? expr.split(/[?:]/).slice(1) : [expr];
          for (const side of sides.map((x) => x.trim()))
            if (/^[A-Za-z_][\w.]*$/.test(side)) variable(rel, side);
        }
        if (/(?<![.\w'])status(?=\s*[,}])/.test(call)) variable(rel, 'status');
        for (const d of call.matchAll(/\bdata\s*:\s*([A-Za-z_][\w.]*)/g)) variable(rel, `data:${d[1]}`);
      }
      // Raw SQL writers.
      for (const q of src.matchAll(/UPDATE\s+"ClientPurchase"[\s\S]*?`/g)) {
        for (const s of q[0].matchAll(/"status"\s*=\s*'([a-z_]+)'/g)) written.add(s[1]);
      }
    }
    expect(writes).toBeGreaterThan(40);
    expect(unclassifiedVariables).toEqual([]);
    expect(Object.keys(WRITTEN_FROM_VARIABLES).filter((k) => !usedVariables.has(k))).toEqual([]);
    const read = new Set<string>(RECONCILED_PURCHASE_STATUSES);
    const skipped = new Set<string>(UNCHARGED_PURCHASE_STATUSES);
    expect([...read].filter((s) => skipped.has(s))).toEqual([]);
    expect([...written].filter((s) => !read.has(s) && !skipped.has(s)).sort()).toEqual([]);
    // Listed only if written (no stale entries).
    expect([...read, ...skipped].filter((s) => !written.has(s)).sort()).toEqual([]);
    // LS-1225R2 B1: an unpaid renewal after paid periods is money.
    expect(read.has('unpaid')).toBe(true);
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
