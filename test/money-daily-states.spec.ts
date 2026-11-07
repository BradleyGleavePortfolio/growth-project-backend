// FIX-1225 (b): every money-bearing purchase state is checked, and a purchase
// that never charged is not "could not be confirmed yet".
//
// The real ReconciliationService over one in-memory purchase at a time;
// Stripe is a stand-in. No live Stripe, no network, no database.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Logger } from '@nestjs/common';
import {
  INVOICE_PAGE_CAP,
  RECONCILED_PURCHASE_STATUSES,
  ReconciliationService,
  UNCHARGED_PURCHASE_STATUSES,
} from '../src/connect/fees/reconciliation.service';
import { AdminPaymentOpsController } from '../src/checkout/payment-ops.controller';
import { RUN_BUDGET_MS, ReconciliationDailyCron } from '../src/checkout/reconciliation-daily.cron';
import { Table, asPrisma } from './utils/settlement-fakes';

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
      expect: { status: 'unknown', notes: 'charge_not_checked charge=ch_s1 status=legacy_destination' } },
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
      // :1142-1146 a delinquent plan takes Stripe's status only when it is paid
      // again: subPaid (:1129) = PAID_SUB_STATUSES (:105), active or trialing
      // (FIX-1225R3, LS-1225R3 N1).
      'checkout/client-billing.service.ts subStatus': ['active', 'trialing'],
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

// FIX-1225R3 (c), LS-1225R3 B1 + C1, LO-1225R3 B1: before any 'ok' every
// known charge on the purchase is read and matched (each ChargeSettlement row
// of any status, the payment intent's charge, every ledger slice and
// transfer); an older matched charge never speaks for a newer one; a drift
// already found stays drift; a web trial's SetupIntent is not a payment
// intent. One table, every money-bearing state, run through the three
// readers: the daily run, the per-purchase admin route
// (payment-ops.controller.ts getReconciliation) and the admin sweeper
// (runReconciliationSweeper). All three must agree.
type History = 'none' | 'settled' | 'settled_drift' | 'legacy';
interface KnownChargeRow {
  name: string;
  status: string;
  intent: 'none' | 'pi_matched' | 'pi_unsettled' | 'seti';
  history: History;
  renewal?: 'awaiting_fee' | 'error';
  expect: 'ok' | 'drift' | 'unknown';
  notes?: string;
}

const OLD_CHARGE = 'ch_r3_old';
const NEW_CHARGE = 'ch_r3_renewal';

function knownChargeWorld(r: KnownChargeRow) {
  const purchase = {
    id: 'p-r3',
    status: r.status,
    source: null,
    billing_type: 'recurring',
    amount_cents: 4_900,
    stripe_payment_intent_id:
      r.intent === 'none' ? null : r.intent === 'seti' ? 'seti_r3_trial' : 'pi_r3',
    updated_at: new Date('2026-01-01T00:00:00Z'),
  };
  const settled = r.history === 'settled' || r.history === 'settled_drift';
  const settlements: any[] = [];
  if (settled) {
    settlements.push({
      id: 'cs-r3-old', purchase_id: purchase.id, stripe_charge_id: OLD_CHARGE,
      mechanism: 'separate_charge_transfer', status: 'settled',
      coach_user_id: 'coach-r3', head_coach_user_id: null,
      gross_cents: 4_900, stripe_fee_cents: 172, platform_fee_cents: 98, head_coach_split_cents: 0,
      coach_net_cents: 4_630, refunded_cents: 0, dispute_withdrawn_cents: 0, dispute_fee_cents: 0,
      target_platform_fee_cents: 98, target_head_coach_cents: 0, target_coach_net_cents: 4_630,
      currency: 'usd', created_at: new Date('2026-01-01T00:00:00Z'),
    });
  }
  if (r.renewal) {
    settlements.push({
      id: 'cs-r3-new', purchase_id: purchase.id, stripe_charge_id: NEW_CHARGE,
      mechanism: 'separate_charge_transfer', status: r.renewal, coach_user_id: 'coach-r3',
      gross_cents: 4_900, refunded_cents: 0, dispute_withdrawn_cents: 0, dispute_fee_cents: 0,
      currency: 'usd', created_at: new Date('2026-02-01T00:00:00Z'),
    });
  }
  const slice = (kind: string, amount_cents: number) => ({
    purchase_id: purchase.id, stripe_charge_id: OLD_CHARGE, kind, amount_cents,
    payee_user_id: kind === 'destination' ? 'coach-r3' : null,
    reversed_cents: 0, status: 'posted', posted_at: new Date('2026-01-01T00:00:00Z'),
  });
  const ledger = settled
    ? [slice('application_fee', 98), slice('stripe_fee', 172), slice('destination', 4_630)]
    : r.history === 'legacy'
      ? [slice('application_fee', 98), slice('destination', 4_802)]
      : [];
  const transfers = settled
    ? [{
        id: 'tr-r3-old', purchase_id: purchase.id, settlement_id: 'cs-r3-old',
        destination_user_id: 'coach-r3', source_stripe_charge_id: OLD_CHARGE, amount_cents: 4_630,
        netted_recovery_cents: 0, reversed_amount_cents: 0, status: 'succeeded',
      }]
    : [];
  const prisma = asPrisma({
    clientPurchase: new Table([purchase], { prefix: 'purchase' }),
    chargeSettlement: new Table(settlements, { prefix: 'settlement' }),
    splitLedgerEntry: new Table(ledger, { prefix: 'ledger' }),
    connectTransfer: new Table(transfers, { prefix: 'transfer' }),
    payeeRecovery: new Table([], { prefix: 'recovery' }),
    chargeDispute: new Table([], { prefix: 'dispute' }),
    reconciliationSnapshot: new Table([], { prefix: 'snapshot', unique: ['purchase_id'] }),
  });
  const stripe = {
    retrievePaymentIntent: jest.fn(async (id: string) => {
      // Stripe has no payment intent for a SetupIntent id.
      if (id.startsWith('seti_')) throw new Error('resource_missing: No such payment_intent');
      return { id, latest_charge: r.intent === 'pi_unsettled' ? 'ch_r3_intent_unsettled' : OLD_CHARGE };
    }),
    retrieveCharge: jest.fn(async (id: string) => {
      // The renewal (and any charge not seeded) cannot be read; the old charge matches.
      if (id !== OLD_CHARGE) throw new Error('charge read unavailable');
      const fee = r.history === 'settled_drift' ? 200 : 172;
      return {
        id, amount: 4_900, amount_refunded: 0, application_fee_amount: 98,
        balance_transaction: { id: 'txn_r3_old', amount: 4_900, fee, net: 4_900 - fee, currency: 'usd' },
      };
    }),
  };
  const service = new ReconciliationService(prisma, stripe as any);
  const admin = Object.create(AdminPaymentOpsController.prototype) as AdminPaymentOpsController;
  Object.assign(admin, { reconciliation: service });
  const cron = new ReconciliationDailyCron(
    { tryAcquire: jest.fn(async () => ({ acquired: true })) } as any,
    service,
    {
      createNotification: jest.fn(async (input: unknown) => input),
      pushToUser: jest.fn(async () => ({ delivered: true })),
    } as any,
    { user: { findFirst: jest.fn(async () => ({ id: 'owner-r3' })) } } as any,
  );
  return { service, admin, cron };
}

/** The plan states that do not claim a payment (reconciliation.service.ts NEVER_CHARGED_OK_STATUSES). */
const NEVER_CHARGED_STATES = new Set(['trialing', 'past_due', 'unpaid', 'paused', 'canceled']);
const CLAIMS_PAYMENT = new Set(['paid', 'active', 'refunded', 'disputed', 'chargeback_lost']);
const KNOWN_CHARGE_ROWS: KnownChargeRow[] = RECONCILED_PURCHASE_STATUSES.flatMap((status): KnownChargeRow[] => [
  // settled-only history
  { name: 'settled history only', status, intent: 'none', history: 'settled', expect: 'ok' },
  { name: 'settled history, payment intent on the settled charge', status, intent: 'pi_matched', history: 'settled', expect: 'ok' },
  // mixed history: an older matched charge never speaks for a newer one
  { name: 'settled history + unreadable awaiting_fee renewal', status, intent: 'none', history: 'settled',
    renewal: 'awaiting_fee', expect: 'unknown', notes: `settlement_not_settled charge=${NEW_CHARGE} status=awaiting_fee` },
  { name: 'settled history + error renewal', status, intent: 'none', history: 'settled',
    renewal: 'error', expect: 'unknown', notes: `settlement_not_settled charge=${NEW_CHARGE} status=error` },
  { name: 'settled history + payment intent on a charge with no settlement', status, intent: 'pi_unsettled',
    history: 'settled', expect: 'unknown', notes: 'charge_not_checked charge=ch_r3_intent_unsettled' },
  { name: 'settled history drifting + awaiting_fee renewal: drift stays drift', status, intent: 'none',
    history: 'settled_drift', renewal: 'awaiting_fee', expect: 'drift' },
  // legacy (ledger-only) history
  { name: 'legacy ledger history only', status, intent: 'none', history: 'legacy', expect: 'ok' },
  { name: 'legacy ledger history + unreadable awaiting_fee renewal', status, intent: 'none', history: 'legacy',
    renewal: 'awaiting_fee', expect: 'unknown', notes: `settlement_not_settled charge=${NEW_CHARGE} status=awaiting_fee` },
  // a web trial's SetupIntent, with and without real money
  NEVER_CHARGED_STATES.has(status)
    ? { name: 'SetupIntent only, nothing else', status, intent: 'seti', history: 'none', expect: 'ok', notes: 'never_charged' }
    : { name: 'SetupIntent only, nothing else (a paid state)', status, intent: 'seti', history: 'none',
        expect: 'unknown', notes: 'no_charge_id_yet' },
  { name: 'SetupIntent + awaiting_fee charge', status, intent: 'seti', history: 'none', renewal: 'awaiting_fee',
    expect: 'unknown', notes: `settlement_not_settled charge=${NEW_CHARGE} status=awaiting_fee` },
  { name: 'SetupIntent + settled history', status, intent: 'seti', history: 'settled', expect: 'ok' },
  { name: 'SetupIntent + settled history + awaiting_fee renewal', status, intent: 'seti', history: 'settled',
    renewal: 'awaiting_fee', expect: 'unknown', notes: `settlement_not_settled charge=${NEW_CHARGE} status=awaiting_fee` },
  { name: 'SetupIntent + legacy ledger history', status, intent: 'seti', history: 'legacy', expect: 'ok' },
  { name: 'SetupIntent + legacy ledger history + awaiting_fee renewal', status, intent: 'seti', history: 'legacy',
    renewal: 'awaiting_fee', expect: 'unknown', notes: `settlement_not_settled charge=${NEW_CHARGE} status=awaiting_fee` },
]);

describe('FIX-1225R3 (c): every known charge is read before ok; the daily run, the admin route and the sweeper agree', () => {
  beforeAll(() => {
    for (const level of ['log', 'error', 'debug'] as const)
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });
  beforeEach(() => delete process.env.RECONCILIATION_DAILY_ENABLED);

  it('covers every money-bearing state, and each state both ways for a SetupIntent', () => {
    expect(new Set(KNOWN_CHARGE_ROWS.map((r) => r.status))).toEqual(new Set(RECONCILED_PURCHASE_STATUSES));
    for (const s of RECONCILED_PURCHASE_STATUSES) expect(NEVER_CHARGED_STATES.has(s) || CLAIMS_PAYMENT.has(s)).toBe(true);
  });

  it.each(KNOWN_CHARGE_ROWS)('$status: $name -> $expect', async (r) => {
    // The per-purchase admin route.
    const one = await knownChargeWorld(r).admin.getReconciliation('p-r3');
    expect(one.status).toBe(r.expect);
    if (r.notes !== undefined) expect(one.notes ?? '').toContain(r.notes);
    if (r.expect === 'drift') expect(one.notes ?? '').toContain(`settlement_not_settled charge=${NEW_CHARGE}`);
    // The admin sweeper.
    await expect(knownChargeWorld(r).admin.runReconciliationSweeper('50')).resolves.toEqual({
      scanned: 1,
      drifted: r.expect === 'drift' ? 1 : 0,
      unknown: r.expect === 'unknown' ? 1 : 0,
    });
    // The daily run.
    await expect(
      knownChargeWorld(r).cron.runOnce(new Date(Date.now() - 1_000), 'machine-r3', async () => undefined),
    ).resolves.toMatchObject({
      ran: true,
      verdict: r.expect === 'ok' ? 'clean' : 'needs_review',
      tally: {
        checked: 1,
        ok: r.expect === 'ok' ? 1 : 0,
        drift: r.expect === 'drift' ? 1 : 0,
        unknown: r.expect === 'unknown' ? 1 : 0,
      },
    });
  });
});

// FIX-1225R4 (d), LS-1225R4 B1: for a purchase on a Stripe subscription the
// check also reads that subscription's paid invoices, every page, any payment
// method. A paid charge we have no record of is "could not be confirmed yet";
// a history not read in full (a failed read, the page cap, the run's time
// budget) is unknown, and the daily run says "could not be checked". A trial
// is never_charged only when the invoices show no money paid. The daily run,
// the admin route and the admin sweeper agree.
interface R4Invoice {
  id: string;
  status: string;
  amount_paid: number;
  charge: string | null;
  payments?: { data: Array<{ status: string; payment: { payment_intent: string } }> };
}
interface InvoiceRow {
  name: string;
  status: string;
  /** Our records: nothing; the first charge settled and matched; or that and a renewal on a second card. */
  history: 'none' | 'settled' | 'settled_two';
  /** Stripe's paid invoices, one array per page, newest first; 'unreadable' = the read fails; 'endless' = always more. */
  invoices: R4Invoice[][] | 'unreadable' | 'endless';
  expect: 'ok' | 'unknown' | 'not_checked';
  notes: string | null;
}

const R4_FIRST = 'ch_r4_first';
const R4_CARD2 = 'ch_r4_card2';
const R4_LOST = 'ch_r4_lost';
const paidInvoice = (id: string, charge: string | null, amount_paid = 4_900): R4Invoice => ({
  id, status: 'paid', amount_paid, charge,
});
const TRIAL_INVOICE = paidInvoice('in_r4_trial', null, 0);

function invoiceWorld(r: InvoiceRow, opts: { onInvoiceRead?: () => void; second?: boolean } = {}) {
  const purchase = (id: string, sub: string | null) => ({
    id, status: r.status, source: null, billing_type: 'recurring', amount_cents: 4_900,
    stripe_payment_intent_id: null, stripe_subscription_id: sub, updated_at: new Date('2026-01-01T00:00:00Z'),
  });
  const charges = r.history === 'none' ? [] : r.history === 'settled' ? [R4_FIRST] : [R4_FIRST, R4_CARD2];
  const settlements = charges.map((charge, i) => ({
    id: `cs-r4-${i}`, purchase_id: 'p-r4', stripe_charge_id: charge, mechanism: 'separate_charge_transfer',
    status: 'settled', coach_user_id: 'coach-r4', head_coach_user_id: null,
    gross_cents: 4_900, stripe_fee_cents: 172, platform_fee_cents: 98, head_coach_split_cents: 0,
    coach_net_cents: 4_630, refunded_cents: 0, dispute_withdrawn_cents: 0, dispute_fee_cents: 0,
    target_platform_fee_cents: 98, target_head_coach_cents: 0, target_coach_net_cents: 4_630,
    currency: 'usd', created_at: new Date(Date.UTC(2026, i, 1)),
  }));
  const ledger = charges.flatMap((charge, i) =>
    ([['application_fee', 98], ['stripe_fee', 172], ['destination', 4_630]] as const).map(([kind, amount_cents]) => ({
      purchase_id: 'p-r4', stripe_charge_id: charge, kind, amount_cents,
      payee_user_id: kind === 'destination' ? 'coach-r4' : null,
      reversed_cents: 0, status: 'posted', posted_at: new Date(Date.UTC(2026, i, 1)),
    })),
  );
  const transfers = charges.map((charge, i) => ({
    id: `tr-r4-${i}`, purchase_id: 'p-r4', settlement_id: `cs-r4-${i}`, destination_user_id: 'coach-r4',
    source_stripe_charge_id: charge, amount_cents: 4_630, netted_recovery_cents: 0, reversed_amount_cents: 0,
    status: 'succeeded',
  }));
  const purchases = [purchase('p-r4', 'sub-r4'), ...(opts.second ? [purchase('p-r4-next', null)] : [])];
  const prisma = asPrisma({
    clientPurchase: new Table(purchases, { prefix: 'purchase' }),
    chargeSettlement: new Table(settlements, { prefix: 'settlement' }),
    splitLedgerEntry: new Table(ledger, { prefix: 'ledger' }),
    connectTransfer: new Table(transfers, { prefix: 'transfer' }),
    payeeRecovery: new Table([], { prefix: 'recovery' }),
    chargeDispute: new Table([], { prefix: 'dispute' }),
    reconciliationSnapshot: new Table([], { prefix: 'snapshot', unique: ['purchase_id'] }),
  });
  let endless = 0;
  const listInvoices = jest.fn(async (args: { subscription: string; status?: string; starting_after?: string | null }) => {
    opts.onInvoiceRead?.();
    if (r.invoices === 'unreadable') throw new Error('stripe unavailable');
    if (r.invoices === 'endless') {
      endless += 1;
      return { data: [paidInvoice(`in_r4_e${endless}`, R4_FIRST)], has_more: true };
    }
    const pages = r.invoices;
    const at = args.starting_after ? pages.findIndex((p) => p[p.length - 1]?.id === args.starting_after) + 1 : 0;
    return { data: pages[at] ?? [], has_more: at < pages.length - 1 };
  });
  const stripe = {
    // A renewal on a second payment method, named only by its payment intent.
    retrievePaymentIntent: jest.fn(async (id: string) => ({ id, latest_charge: id === 'pi_r4_card2' ? R4_CARD2 : null })),
    retrieveCharge: jest.fn(async (id: string) => {
      if (!charges.includes(id)) throw new Error('charge read unavailable');
      return {
        id, amount: 4_900, amount_refunded: 0, application_fee_amount: 98,
        balance_transaction: { id: `txn_${id}`, amount: 4_900, fee: 172, net: 4_728, currency: 'usd' },
      };
    }),
    listInvoices,
  };
  const service = new ReconciliationService(prisma, stripe as any);
  const admin = Object.create(AdminPaymentOpsController.prototype) as AdminPaymentOpsController;
  Object.assign(admin, { reconciliation: service });
  const notifications = {
    createNotification: jest.fn(async (input: unknown) => input),
    pushToUser: jest.fn(async () => ({ delivered: true })),
  };
  const cron = new ReconciliationDailyCron(
    { tryAcquire: jest.fn(async () => ({ acquired: true })) } as any,
    service,
    notifications as any,
    { user: { findFirst: jest.fn(async () => ({ id: 'owner-r4' })) } } as any,
  );
  const body = () => notifications.createNotification.mock.calls.map(([input]) => (input as { body: string }).body).join(' ');
  return { admin, cron, listInvoices, body };
}

const INVOICE_ROWS: InvoiceRow[] = RECONCILED_PURCHASE_STATUSES.flatMap((status): InvoiceRow[] => [
  { name: 'history matched, one page', status, history: 'settled',
    invoices: [[paidInvoice('in_r4_1', R4_FIRST), TRIAL_INVOICE]], expect: 'ok', notes: null },
  { name: 'history matched across two pages', status, history: 'settled',
    invoices: [[paidInvoice('in_r4_1', R4_FIRST)], [TRIAL_INVOICE]], expect: 'ok', notes: null },
  { name: 'Stripe-only renewal (its webhook was lost)', status, history: 'settled',
    invoices: [[paidInvoice('in_r4_2', R4_LOST), paidInvoice('in_r4_1', R4_FIRST)]],
    expect: 'unknown', notes: `charge_not_recorded charge=${R4_LOST} invoice=in_r4_2` },
  { name: 'Stripe-only charge on the second page', status, history: 'settled',
    invoices: [[paidInvoice('in_r4_2', R4_FIRST)], [paidInvoice('in_r4_1', R4_LOST)]],
    expect: 'unknown', notes: `charge_not_recorded charge=${R4_LOST} invoice=in_r4_1` },
  { name: 'renewal on a second card, recorded and settled', status, history: 'settled_two',
    invoices: [[paidInvoice('in_r4_2', R4_CARD2), paidInvoice('in_r4_1', R4_FIRST)]], expect: 'ok', notes: null },
  { name: 'renewal on a second payment method, named in the invoice payments, not recorded', status, history: 'settled',
    invoices: [[
      { ...paidInvoice('in_r4_2', null), payments: { data: [{ status: 'paid', payment: { payment_intent: 'pi_r4_card2' } }] } },
      paidInvoice('in_r4_1', R4_FIRST),
    ]],
    expect: 'unknown', notes: `charge_not_recorded charge=${R4_CARD2} invoice=in_r4_2` },
  { name: 'a paid invoice with no charge Stripe can name', status, history: 'settled',
    invoices: [[paidInvoice('in_r4_2', null), paidInvoice('in_r4_1', R4_FIRST)]],
    expect: 'unknown', notes: 'invoice_paid_no_charge invoice=in_r4_2' },
  { name: 'invoice history unreadable', status, history: 'settled', invoices: 'unreadable',
    expect: 'not_checked', notes: 'invoices_not_read reason=read_failed' },
  { name: 'invoice history cut short by the page cap', status, history: 'settled', invoices: 'endless',
    expect: 'not_checked', notes: 'invoices_not_read reason=page_cap' },
  NEVER_CHARGED_STATES.has(status)
    ? { name: 'nothing recorded, only the $0 trial invoice', status, history: 'none', invoices: [[TRIAL_INVOICE]],
        expect: 'ok', notes: 'never_charged' }
    : { name: 'nothing recorded, only the $0 trial invoice (a paid state)', status, history: 'none',
        invoices: [[TRIAL_INVOICE]], expect: 'unknown', notes: 'no_charge_id_yet' },
  { name: 'nothing recorded, a renewal Stripe charged', status, history: 'none',
    invoices: [[paidInvoice('in_r4_2', R4_LOST), TRIAL_INVOICE]],
    expect: 'unknown', notes: `charge_not_recorded charge=${R4_LOST} invoice=in_r4_2` },
  { name: 'nothing recorded, invoice history unreadable', status, history: 'none', invoices: 'unreadable',
    expect: 'not_checked', notes: 'invoices_not_read reason=read_failed' },
]);

describe('FIX-1225R4 (d): Stripe paid invoices are read for every subscription purchase; the three readers agree', () => {
  beforeAll(() => {
    for (const level of ['log', 'error', 'debug'] as const)
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });
  beforeEach(() => delete process.env.RECONCILIATION_DAILY_ENABLED);

  it('covers every money-bearing state', () => {
    expect(new Set(INVOICE_ROWS.map((r) => r.status))).toEqual(new Set(RECONCILED_PURCHASE_STATUSES));
  });

  it.each(INVOICE_ROWS)('$status: $name -> $expect', async (r) => {
    // The per-purchase admin route: a history not read in full is unknown.
    const one = await invoiceWorld(r).admin.getReconciliation('p-r4');
    expect(one.status).toBe(r.expect === 'not_checked' ? 'unknown' : r.expect);
    if (r.notes !== null) expect(one.notes ?? '').toContain(r.notes);
    // The admin sweeper.
    await expect(invoiceWorld(r).admin.runReconciliationSweeper('50')).resolves.toEqual({
      scanned: 1, drifted: 0, unknown: r.expect === 'ok' ? 0 : 1,
    });
    // The daily run.
    const daily = invoiceWorld(r);
    await expect(
      daily.cron.runOnce(new Date(Date.now() - 1_000), 'machine-r4', async () => undefined),
    ).resolves.toMatchObject({
      ran: true,
      verdict: r.expect === 'ok' ? 'clean' : 'needs_review',
      tally: {
        checked: 1,
        ok: r.expect === 'ok' ? 1 : 0,
        unknown: r.expect === 'unknown' ? 1 : 0,
        failed: r.expect === 'not_checked' ? 1 : 0,
        stopped: null,
      },
    });
    if (r.expect === 'ok') expect(daily.body()).toContain('Every one matches.');
    else expect(daily.body()).not.toContain('Every one matches.');
    if (r.expect === 'unknown') expect(daily.body()).toContain('1 could not be confirmed yet.');
    if (r.expect === 'not_checked') expect(daily.body()).toContain('1 could not be checked.');
    // Every page, never only the newest invoice or one limited list; the page cap ends endless paging.
    const pages = r.invoices === 'endless' ? INVOICE_PAGE_CAP : r.invoices === 'unreadable' ? 1 : r.invoices.length;
    expect(daily.listInvoices).toHaveBeenCalledTimes(pages);
    for (const [args] of daily.listInvoices.mock.calls) {
      expect(args).toMatchObject({ subscription: 'sub-r4', status: 'paid', limit: 100 });
    }
    if (Array.isArray(r.invoices) && r.invoices.length > 1) {
      expect(daily.listInvoices.mock.calls[1][0].starting_after).toBe(r.invoices[0][r.invoices[0].length - 1].id);
    }
  });

  const matched = INVOICE_ROWS.find((x) => x.status === 'active' && x.name === 'history matched across two pages')!;

  it('the time budget, asked before each page of invoices, ends the run and says so (W7)', async () => {
    let now = 0;
    const w = invoiceWorld(matched, { onInvoiceRead: () => { now = RUN_BUDGET_MS; } });
    const res = await w.cron.runOnce(new Date(Date.now() - 1_000), 'machine-r4', async () => undefined, () => now);
    expect(res).toMatchObject({
      ran: true, verdict: 'needs_review', tally: { checked: 1, ok: 0, failed: 1, stopped: 'time_limit' },
    });
    expect(w.listInvoices).toHaveBeenCalledTimes(1);
    expect(w.body()).toContain('1 could not be checked.');
    expect(w.body()).toContain('The check hit its time limit before it reached every purchase.');
    expect(w.body()).not.toContain('Every one matches.');
  });

  it('the time budget, asked before each purchase, ends the run inside a batch and says so (W7)', async () => {
    let now = 0;
    const single = { ...matched, invoices: [[paidInvoice('in_r4_1', R4_FIRST)]] };
    const w = invoiceWorld(single, { second: true, onInvoiceRead: () => { now = RUN_BUDGET_MS; } });
    const res = await w.cron.runOnce(new Date(Date.now() - 1_000), 'machine-r4', async () => undefined, () => now);
    expect(res).toMatchObject({ ran: true, verdict: 'needs_review', tally: { checked: 1, ok: 1, stopped: 'time_limit' } });
    expect(w.body()).toContain('The check hit its time limit before it reached every purchase.');
    expect(w.body()).not.toContain('Every one matches.');
  });
});
