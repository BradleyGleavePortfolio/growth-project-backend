// S-FEE — in-memory Prisma + Stripe fakes for the coach-payout settlement
// specs. No database and no network: every Stripe object below is modelled on
// the real API shape (Charge with an expanded balance_transaction, Dispute
// balance_transactions, Transfer, TransferReversal) at API version
// 2024-09-30.acacia.
import type { PrismaService } from '../../src/prisma.service';
import {
  StripeConnectApiError,
  StripeConnectApiService,
  type StripeChargeObject,
} from '../../src/connect/stripe-connect-api.service';

export type Row = Record<string, any>;

export function asPrisma(m: object): PrismaService {
  return m as PrismaService;
}

function cmp(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a ?? '').localeCompare(String(b ?? ''));
}

function matchValue(value: unknown, cond: unknown): boolean {
  if (cond === null) return value === null || value === undefined;
  if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
  if (typeof cond !== 'object') return value === cond;
  const c = cond as Row;
  if ('not' in c) {
    if (c.not === null) return value !== null && value !== undefined;
    if (typeof c.not === 'object') return !matchValue(value, c.not);
    return value !== c.not;
  }
  if ('in' in c) return Array.isArray(c.in) && c.in.includes(value);
  if ('notIn' in c) return Array.isArray(c.notIn) && !c.notIn.includes(value);
  if ('startsWith' in c) return typeof value === 'string' && value.startsWith(String(c.startsWith));
  let ok = true;
  if ('gt' in c) ok = ok && cmp(value, c.gt) > 0;
  if ('gte' in c) ok = ok && cmp(value, c.gte) >= 0;
  if ('lt' in c) ok = ok && cmp(value, c.lt) < 0;
  if ('lte' in c) ok = ok && cmp(value, c.lte) <= 0;
  return ok;
}

export function matches(
  row: Row,
  where: Row | undefined,
  rel?: (row: Row, key: string) => Row[] | null,
): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (k === 'AND') return (cond as Row[]).every((w) => matches(row, w, rel));
    if (k === 'OR') return (cond as Row[]).some((w) => matches(row, w, rel));
    if (
      cond &&
      typeof cond === 'object' &&
      !(cond instanceof Date) &&
      ('none' in (cond as Row) || 'some' in (cond as Row))
    ) {
      const related = rel ? rel(row, k) : null;
      if (!related) return true;
      const inner = ('none' in (cond as Row) ? (cond as Row).none : (cond as Row).some) as Row;
      const hits = related.filter((r) => matches(r, inner));
      if ('none' in (cond as Row)) return hits.length === 0;
      return hits.length > 0;
    }
    return matchValue(row[k], cond);
  });
}

function applyData(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (v && typeof v === 'object' && !(v instanceof Date) && 'increment' in (v as Row)) {
      row[k] = (row[k] ?? 0) + (v as Row).increment;
    } else if (v && typeof v === 'object' && !(v instanceof Date) && 'decrement' in (v as Row)) {
      row[k] = (row[k] ?? 0) - (v as Row).decrement;
    } else {
      row[k] = v;
    }
  }
  row.updated_at = new Date();
}

let seq = 0;

export class Table {
  constructor(
    public rows: Row[],
    private readonly opts: {
      prefix: string;
      unique?: string[];
      defaults?: () => Row;
      rel?: (row: Row, key: string) => Row[] | null;
    },
  ) {}

  private sorted(rows: Row[], orderBy: unknown): Row[] {
    if (!orderBy) return rows;
    const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Row[];
    return [...rows].sort((a, b) => {
      for (const spec of specs) {
        const [field, dir] = Object.entries(spec)[0];
        const d = cmp(a[field], b[field]);
        if (d !== 0) return dir === 'desc' ? -d : d;
      }
      return 0;
    });
  }

  findUnique = jest.fn(async ({ where }: { where: Row }) => {
    const row = this.rows.find((r) => matches(r, where, this.opts.rel));
    return row ? { ...row } : null;
  });

  findUniqueOrThrow = jest.fn(async ({ where }: { where: Row }) => {
    const row = this.rows.find((r) => matches(r, where, this.opts.rel));
    if (!row) throw new Error(`${this.opts.prefix}: not found ${JSON.stringify(where)}`);
    return { ...row };
  });

  findFirst = jest.fn(async (args: { where?: Row; orderBy?: unknown } = {}) => {
    const row = this.sorted(
      this.rows.filter((r) => matches(r, args.where, this.opts.rel)),
      args.orderBy,
    )[0];
    return row ? { ...row } : null;
  });

  findMany = jest.fn(
    async (
      args: {
        where?: Row;
        orderBy?: unknown;
        take?: number;
        cursor?: { id: string };
        skip?: number;
      } = {},
    ) => {
      let rows = this.sorted(
        this.rows.filter((r) => matches(r, args.where, this.opts.rel)),
        args.orderBy,
      );
      // Prisma cursor pagination: start at the cursor row, then skip.
      if (args.cursor) {
        const at = rows.findIndex((r) => r.id === args.cursor!.id);
        rows = at < 0 ? [] : rows.slice(at);
      }
      if (typeof args.skip === 'number') rows = rows.slice(args.skip);
      return (typeof args.take === 'number' ? rows.slice(0, args.take) : rows).map((r) => ({
        ...r,
      }));
    },
  );

  count = jest.fn(
    async (args: { where?: Row } = {}) =>
      this.rows.filter((r) => matches(r, args.where, this.opts.rel)).length,
  );

  create = jest.fn(async ({ data }: { data: Row }) => {
    for (const key of this.opts.unique ?? []) {
      if (data[key] != null && this.rows.some((r) => r[key] === data[key])) {
        throw Object.assign(new Error(`Unique constraint failed on ${key}`), { code: 'P2002' });
      }
    }
    const now = new Date(Date.now() + seq);
    seq += 1;
    const row: Row = {
      id: `${this.opts.prefix}-${seq}`,
      created_at: now,
      updated_at: now,
      ...(this.opts.defaults ? this.opts.defaults() : {}),
      ...data,
    };
    this.rows.push(row);
    return { ...row };
  });

  update = jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
    const row = this.rows.find((r) => matches(r, where, this.opts.rel));
    if (!row)
      throw new Error(`${this.opts.prefix}: update target missing ${JSON.stringify(where)}`);
    applyData(row, data);
    return { ...row };
  });

  updateMany = jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
    const hits = this.rows.filter((r) => matches(r, where, this.opts.rel));
    for (const row of hits) applyData(row, data);
    return { count: hits.length };
  });

  deleteMany = jest.fn(async ({ where }: { where?: Row } = {}) => {
    const keep = this.rows.filter((r) => !matches(r, where, this.opts.rel));
    const count = this.rows.length - keep.length;
    this.rows.splice(0, this.rows.length, ...keep);
    return { count };
  });

  upsert = jest.fn(async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
    const row = this.rows.find((r) => matches(r, where, this.opts.rel));
    if (row) {
      applyData(row, update);
      return { ...row };
    }
    return this.create({ data: create });
  });

  aggregate = jest.fn(async ({ where, _sum }: { where?: Row; _sum: Row }) => {
    const hits = this.rows.filter((r) => matches(r, where, this.opts.rel));
    const sums: Row = {};
    for (const field of Object.keys(_sum)) {
      sums[field] = hits.length === 0 ? null : hits.reduce((n, r) => n + (r[field] ?? 0), 0);
    }
    return { _sum: sums };
  });

  groupBy = jest.fn(async ({ by, where, _sum }: { by: string[]; where?: Row; _sum: Row }) => {
    const groups = new Map<string, Row[]>();
    for (const r of this.rows.filter((x) => matches(x, where, this.opts.rel))) {
      const key = by.map((b) => String(r[b])).join('|');
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    return [...groups.values()].map((rows) => {
      const out: Row = {};
      for (const b of by) out[b] = rows[0][b];
      const sums: Row = {};
      for (const field of Object.keys(_sum))
        sums[field] = rows.reduce((n, r) => n + (r[field] ?? 0), 0);
      out._sum = sums;
      return out;
    });
  });
}

export interface SettlementDb {
  purchases: Row[];
  accounts: Row[];
  feePolicies: Row[];
  assignments: Row[];
  settlements: Row[];
  recoveries: Row[];
  ledger: Row[];
  transfers: Row[];
  refunds: Row[];
  // CronLease rows (sweep lease, per-charge money locks, backfill cursor).
  leases?: Row[];
  // TransferReversalOp rows (round 4 keyed reversal operations).
  reversalOps?: Row[];
  // ChargeDispute rows (dispute webhook path).
  disputes?: Row[];
  // PayoutAdjustmentNotice rows (round 5, OR-111-1 payee notices).
  notices?: Row[];
}

export function makeSettlementDb(): SettlementDb {
  return {
    purchases: [],
    accounts: [],
    feePolicies: [],
    assignments: [],
    settlements: [],
    recoveries: [],
    ledger: [],
    transfers: [],
    refunds: [],
    leases: [],
    reversalOps: [],
    notices: [],
  };
}

/** Prisma delegates used by the settlement path, backed by `db` arrays. */
export function settlementTables(db: SettlementDb) {
  const rel = (row: Row, key: string): Row[] | null => {
    if (key === 'settlements') return db.settlements.filter((s) => s.purchase_id === row.id);
    if (key === 'splits') return db.ledger.filter((e) => e.purchase_id === row.id);
    return null;
  };
  return {
    clientPurchase: new Table(db.purchases, { prefix: 'cp', rel }),
    connectAccount: new Table(db.accounts, { prefix: 'ca', unique: ['coach_user_id'] }),
    feePolicy: new Table(db.feePolicies, { prefix: 'fp', unique: ['coach_id'] }),
    teamSubCoachAssignment: new Table(db.assignments, { prefix: 'tsa' }),
    chargeSettlement: new Table(db.settlements, {
      prefix: 'cs',
      unique: ['stripe_charge_id'],
      defaults: () => ({
        head_coach_user_id: null,
        stripe_balance_transaction_id: null,
        stripe_invoice_id: null,
        currency: 'usd',
        rail: 'card',
        mechanism: 'separate_charge_transfer',
        status: 'awaiting_fee',
        head_coach_bps: 0,
        stripe_fee_cents: null,
        platform_fee_cents: null,
        head_coach_split_cents: null,
        coach_net_cents: null,
        refunded_cents: 0,
        dispute_withdrawn_cents: 0,
        dispute_fee_cents: 0,
        target_platform_fee_cents: null,
        target_head_coach_cents: null,
        target_coach_net_cents: null,
        settled_at: null,
        adjusted_at: null,
        last_error: null,
        reconcile_requested_at: null,
        reconcile_dispute_id: null,
        reconcile_reason: null,
      }),
    }),
    payeeRecovery: new Table(db.recoveries, {
      prefix: 'pr',
      unique: ['idempotency_key'],
      defaults: () => ({ collected_cents: 0, status: 'open', collected_at: null, currency: 'usd' }),
    }),
    splitLedgerEntry: new Table(db.ledger, {
      prefix: 'le',
      defaults: () => ({
        status: 'pending',
        reversed_cents: 0,
        stripe_charge_id: null,
        stripe_transfer_id: null,
        stripe_application_fee_id: null,
        posted_at: null,
        reversed_at: null,
        last_error: null,
      }),
    }),
    connectTransfer: new Table(db.transfers, {
      prefix: 'tr',
      unique: ['idempotency_key', 'ledger_entry_id'],
      defaults: () => ({
        attempts: 0,
        max_attempts: 6,
        reversed_amount_cents: 0,
        netted_recovery_cents: 0,
        reversal_seq: 0,
        stripe_send_unresolved_at: null,
        kind: 'head_coach_split',
        settlement_id: null,
        stripe_transfer_id: null,
        last_error: null,
        reversed_at: null,
      }),
    }),
    chargeRefund: new Table(db.refunds, { prefix: 'rf', unique: ['stripe_refund_id'] }),
    cronLease: new Table(db.leases ?? (db.leases = []), {
      prefix: 'lease',
      unique: ['name'],
      defaults: () => ({ cursor: null }),
    }),
    chargeDispute: new Table(db.disputes ?? (db.disputes = []), {
      prefix: 'cd',
      unique: ['stripe_dispute_id'],
      defaults: () => ({ ledger_reversed: false, closed_at: null, balance_transaction_id: null }),
    }),
    payoutAdjustmentNotice: new Table(db.notices ?? (db.notices = []), {
      prefix: 'pan',
      unique: ['idempotency_key'],
      defaults: () => ({
        currency: 'usd',
        reinstated_cents: 0,
        inapp_status: 'pending',
        inapp_notification_id: null,
        push_status: 'pending',
        push_notification_id: null,
        email_status: 'pending',
        email_attempts: 0,
        dispatch_attempts: 0,
        dispatch_claimed_at: null,
        dispatched_at: null,
        acknowledged_at: null,
      }),
    }),
    transferReversalOp: new Table(db.reversalOps ?? (db.reversalOps = []), {
      prefix: 'rop',
      unique: ['idempotency_key', 'stripe_reversal_id'],
      defaults: () => ({
        purpose: 'adjust',
        status: 'pending',
        stripe_reversal_id: null,
        attempts: 0,
        last_attempt_at: null,
        last_error: null,
        resolved_at: null,
      }),
    }),
  };
}

/** A Prisma fake with `$transaction(fn)` running `fn` against itself. */
export function makeSettlementPrisma(db: SettlementDb = makeSettlementDb()) {
  const tables = settlementTables(db);
  const prisma: ReturnType<typeof settlementTables> & { $transaction: jest.Mock } = {
    ...tables,
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(async (fn: (tx: object) => Promise<unknown>) =>
    fn(prisma),
  );
  return { prisma, db };
}

// ---------------------------------------------------------------------------
// Stripe fixtures
// ---------------------------------------------------------------------------

/** Stripe's published US card price: 2.9% + 30c, rounded to the cent. */
export function usCardFeeCents(amountCents: number): number {
  return Math.round(amountCents * 0.029) + 30;
}

/** International card: +1.5% (Stripe US pricing), no currency conversion. */
export function intlCardFeeCents(amountCents: number): number {
  return Math.round(amountCents * 0.044) + 30;
}

export function makeCharge(args: {
  id: string;
  amount: number;
  fee: number;
  currency?: string;
  amount_refunded?: number;
  payment_method_type?: string;
  legacy_application_fee_amount?: number;
  payment_intent?: string;
}): StripeChargeObject {
  const currency = args.currency ?? 'usd';
  const legacy = typeof args.legacy_application_fee_amount === 'number';
  return {
    id: args.id,
    object: 'charge',
    amount: args.amount,
    currency,
    amount_refunded: args.amount_refunded ?? 0,
    refunded: (args.amount_refunded ?? 0) >= args.amount,
    paid: true,
    status: 'succeeded',
    payment_intent: args.payment_intent ?? `pi_${args.id}`,
    on_behalf_of: 'acct_coach',
    transfer: legacy ? `tr_dest_${args.id}` : null,
    transfer_data: legacy ? { destination: 'acct_coach' } : null,
    application_fee: legacy ? `fee_${args.id}` : null,
    application_fee_amount: legacy ? args.legacy_application_fee_amount : null,
    payment_method_details: { type: args.payment_method_type ?? 'card' },
    balance_transaction: {
      id: `txn_${args.id}`,
      object: 'balance_transaction',
      amount: args.amount,
      fee: args.fee,
      net: args.amount - args.fee,
      currency,
      type: 'charge',
    },
  };
}

export interface FakeTransfer {
  [k: string]: unknown;
  id: string;
  amount: number;
  currency: string;
  destination: string;
  source_transaction?: string;
  transfer_group: string | null;
  metadata: Record<string, string>;
  created: number;
}

export interface FakeReversal {
  [k: string]: unknown;
  id: string;
  transfer: string;
  amount: number;
  metadata?: Record<string, string>;
}

/**
 * Stripe client fake: charges are looked up from `charges`; transfers and
 * reversals are recorded and collapse on the idempotency key like Stripe.
 */
export class FakeStripe extends StripeConnectApiService {
  charges = new Map<string, StripeChargeObject>();
  /**
   * B-627-8 (round 7): Stripe's durable transfer objects (never forgotten)
   * are kept apart from the idempotency-key cache for creates, which expires
   * with `expireIdempotencyKeys()` like every other key. A create re-sent with
   * an expired key makes a second transfer, like Stripe would.
   */
  transfers: FakeTransfer[] = [];
  transferKeyCache = new Map<string, FakeTransfer>();
  /** Every transfer Stripe holds, by id (values() for totals). */
  get transfersByKey(): Map<string, FakeTransfer> {
    return new Map(this.transfers.map((t) => [t.id, t]));
  }
  /** Network failure BEFORE Stripe executes the next N transfer creates. */
  transferNetworkFailures = 0;
  /** Stripe EXECUTES the next N transfer creates, then the response is lost. */
  transferResponsesLost = 0;
  /**
   * Round 9: Stripe definitively refuses the next N transfer creates (400,
   * nothing executed). Stripe saves that answer under the key, so a later
   * request with the same key gets the same refusal until the key expires.
   */
  transferRefusals = 0;
  transferRefusalCache = new Map<string, StripeConnectApiError>();
  /** Listing transfers fails (Stripe unavailable). */
  failListTransfers = false;
  /** Transfer listing always says has_more (an endless / incomplete listing). */
  transferListAlwaysHasMore = false;
  /** Transfer listing pages hold this many transfers (Stripe's limit, or smaller). */
  transferListPageSize = 100;
  /** Seconds since the epoch; tests may move Stripe's clock. */
  nowSeconds = (): number => Math.floor(Date.now() / 1000);
  /**
   * B-627-5 (round 6): Stripe's durable reversal objects (never forgotten)
   * are kept apart from its idempotency-key cache, which expires (Stripe
   * keeps keys for 24 h). `expireIdempotencyKeys()` ages every key out, so a
   * re-send with the same key after that creates a second reversal, like
   * Stripe would.
   */
  reversals: FakeReversal[] = [];
  reversalKeyCache = new Map<string, FakeReversal>();
  /** Every reversal Stripe holds (keyed by position; values() for totals). */
  get reversalsByKey(): Map<string, FakeReversal> {
    return new Map(this.reversals.map((r) => [r.id, r]));
  }
  expireIdempotencyKeys(): void {
    this.reversalKeyCache.clear();
    this.transferKeyCache.clear();
    this.transferRefusalCache.clear();
  }
  /** Listing pages hold this many reversals (Stripe's limit, or smaller). */
  reversalListPageSize = 100;
  /** Listing always says has_more (an endless / incomplete listing). */
  reversalListAlwaysHasMore = false;
  /** Definitive refusal (Stripe 400 balance_insufficient): nothing is reversed. */
  failReversals = false;
  /** Network failure BEFORE Stripe executes the next N reversal requests. */
  reversalNetworkFailures = 0;
  /** Stripe EXECUTES the next N reversals, then the response is lost. */
  reversalResponsesLost = 0;
  /** Listing a transfer's reversals fails (Stripe unavailable). */
  failListReversals = false;
  /** Paid-invoice pages for listPaidInvoices, newest first (like Stripe). */
  paidInvoices: Array<{
    id: string;
    amount_paid: number;
    charge: string | null;
    subscription: string | null;
    created: number;
  }> = [];
  disputes = new Map<
    string,
    { id: string; balance_transactions?: Array<{ id: string; amount: number; fee: number }> }
  >();

  retrieveCharge = jest.fn(async (id: string) => {
    const c = this.charges.get(id);
    if (!c) throw new Error(`No such charge: '${id}'`);
    return c;
  });

  /**
   * Round 13: a charge's refunds as Stripe lists them (newest first). Without an entry, a
   * charge's amount_refunded is one succeeded refund at the charge's own rate (older fixtures).
   */
  refundsByCharge = new Map<
    string,
    Array<{ id: string; status: string; amount: number; currency?: string; debit?: number }>
  >();
  refundListPageSize = 100;
  failListRefunds = false;
  listChargeRefunds = jest.fn(async (chargeId: string, after: string | null) => {
    if (this.failListRefunds)
      throw new StripeConnectApiError('Stripe API 500', 500, null, 'api_error');
    const c = this.charges.get(chargeId);
    const bt = c?.balance_transaction as { amount: number; currency: string } | undefined;
    const refunded = c?.amount_refunded ?? 0;
    const all =
      this.refundsByCharge.get(chargeId) ??
      (refunded > 0 ? [{ id: `re_${chargeId}`, status: 'succeeded', amount: refunded }] : []);
    const start = after ? all.findIndex((r) => r.id === after) + 1 : 0;
    const page = all.slice(start, start + this.refundListPageSize);
    const data = page.map((r) => ({
      id: r.id,
      status: r.status,
      amount: r.amount,
      currency: r.currency ?? c?.currency ?? 'usd',
      balance_transaction: {
        amount: -(r.debit ?? Math.round((r.amount * (bt?.amount ?? 1)) / (c?.amount || 1))),
        currency: bt?.currency ?? 'usd',
      },
    }));
    return { data, has_more: start + page.length < all.length };
  });

  retrievePaymentIntent = jest.fn(async (id: string) => {
    const charge = [...this.charges.values()].find((c) => c.payment_intent === id);
    return { id, latest_charge: charge?.id ?? null };
  });

  listInvoices = jest.fn(async () => ({
    data: [] as Array<{ id: string; amount_paid?: number; charge?: string | null }>,
  }));

  createTransfer = jest.fn(
    async (args: {
      amount: number;
      destination: string;
      source_transaction?: string;
      transfer_group?: string;
      metadata?: Record<string, string>;
      idempotencyKey: string;
      beforeSend?: () => void;
    }) => {
      // Like StripeConnectApiService.post: the caller's last synchronous
      // check runs right before the request starts; a throw sends nothing.
      if (args.beforeSend) args.beforeSend();
      if (this.transferNetworkFailures > 0) {
        this.transferNetworkFailures -= 1;
        throw new StripeConnectApiError(
          'Stripe API timed out after 10000ms on /transfers',
          503,
          'request_timeout',
          'api_connection_error',
        );
      }
      const existing = this.transferKeyCache.get(args.idempotencyKey);
      if (existing) return { ...existing };
      const refused = this.transferRefusalCache.get(args.idempotencyKey);
      if (refused) throw refused;
      if (this.transferRefusals > 0) {
        this.transferRefusals -= 1;
        const err = new StripeConnectApiError(
          'Insufficient funds in Stripe account.',
          400,
          'balance_insufficient',
          'invalid_request_error',
        );
        this.transferRefusalCache.set(args.idempotencyKey, err);
        throw err;
      }
      const t: FakeTransfer = {
        id: `tr_${this.transfers.length + 1}`,
        amount: args.amount,
        currency: 'usd',
        destination: args.destination,
        source_transaction: args.source_transaction,
        transfer_group: args.transfer_group ?? null,
        metadata: args.metadata ?? {},
        created: this.nowSeconds(),
      };
      this.transfers.push(t);
      this.transferKeyCache.set(args.idempotencyKey, t);
      if (this.transferResponsesLost > 0) {
        this.transferResponsesLost -= 1;
        throw new Error('socket closed after transfer execution');
      }
      return { ...t };
    },
  );

  listTransfers = jest.fn(
    async (args: {
      destination: string;
      transfer_group?: string;
      created_gte?: number;
      limit?: number;
      starting_after?: string | null;
    }) => {
      if (this.failListTransfers) {
        throw new StripeConnectApiError('Stripe API 500', 500, null, 'api_error');
      }
      // Newest first, filtered and paginated by starting_after, like Stripe.
      const all = this.transfers
        .filter(
          (t) =>
            t.destination === args.destination &&
            (args.transfer_group === undefined || t.transfer_group === args.transfer_group) &&
            (args.created_gte === undefined || t.created >= args.created_gte),
        )
        .reverse();
      const start = args.starting_after
        ? all.findIndex((t) => t.id === args.starting_after) + 1
        : 0;
      const size = Math.min(args.limit ?? 100, this.transferListPageSize);
      const data = all.slice(start, start + size).map((t) => ({ ...t }));
      return { data, has_more: this.transferListAlwaysHasMore || start + size < all.length };
    },
  );

  listPaidInvoices = jest.fn(
    async (args: { created_gte: number; starting_after?: string | null; limit?: number }) => {
      const all = this.paidInvoices
        .filter((i) => i.created >= args.created_gte)
        .sort((a, b) => b.created - a.created);
      const start = args.starting_after
        ? all.findIndex((i) => i.id === args.starting_after) + 1
        : 0;
      const limit = args.limit ?? 100;
      const data = start > 0 || !args.starting_after ? all.slice(start, start + limit) : [];
      return { data, has_more: start + limit < all.length };
    },
  );

  retrieveDispute = jest.fn(async (id: string) => {
    const d = this.disputes.get(id);
    if (!d) throw new Error(`No such dispute: '${id}'`);
    return { amount: 0, currency: 'usd', status: 'needs_response', ...d };
  });

  reverseTransfer = jest.fn(
    async (args: {
      transfer_id: string;
      amount?: number;
      idempotencyKey: string;
      beforeSend?: () => void;
    }) => {
      // Round 11 (B-682-1): the caller's send-start check, as in createTransfer.
      if (args.beforeSend) args.beforeSend();
      if (this.failReversals) {
        throw new StripeConnectApiError(
          'Insufficient funds in the connected account to reverse this transfer',
          400,
          'balance_insufficient',
          'invalid_request_error',
        );
      }
      if (this.reversalNetworkFailures > 0) {
        this.reversalNetworkFailures -= 1;
        throw new StripeConnectApiError(
          'Stripe API timed out after 10000ms on /transfers/reversals',
          503,
          'request_timeout',
          'api_connection_error',
        );
      }
      const existing = this.reversalKeyCache.get(args.idempotencyKey);
      if (existing) return existing;
      // Like Stripe: a transfer can never be reversed past its amount.
      const transfer = [...this.transfersByKey.values()].find((t) => t.id === args.transfer_id);
      const already = this.reversals
        .filter((r) => r.transfer === args.transfer_id)
        .reduce((n, r) => n + r.amount, 0);
      if (transfer && already + (args.amount ?? transfer.amount - already) > transfer.amount) {
        throw new StripeConnectApiError(
          'The transfer has insufficient remaining amount to be reversed by the requested amount.',
          400,
          'parameter_invalid_integer',
          'invalid_request_error',
        );
      }
      const r: FakeReversal = {
        id: `trr_${this.reversals.length + 1}`,
        transfer: args.transfer_id,
        amount: args.amount ?? 0,
        metadata: (args as { metadata?: Record<string, string> }).metadata,
      };
      this.reversals.push(r);
      this.reversalKeyCache.set(args.idempotencyKey, r);
      if (this.reversalResponsesLost > 0) {
        this.reversalResponsesLost -= 1;
        throw new Error('socket hang up');
      }
      return r;
    },
  );

  listTransferReversals = jest.fn(
    async (transferId: string, opts: { limit?: number; starting_after?: string | null } = {}) => {
      if (this.failListReversals) {
        throw new StripeConnectApiError('Stripe API 500', 500, null, 'api_error');
      }
      // Newest first, paginated by starting_after, like Stripe.
      const all = this.reversals.filter((r) => r.transfer === transferId).reverse();
      const start = opts.starting_after
        ? all.findIndex((r) => r.id === opts.starting_after) + 1
        : 0;
      const size = Math.min(opts.limit ?? 100, this.reversalListPageSize);
      const data = all.slice(start, start + size);
      return { data, has_more: this.reversalListAlwaysHasMore || start + size < all.length };
    },
  );

  /** Total Stripe reversed on one Stripe transfer id. */
  reversedOn(transferId: string): number {
    return this.reversals
      .filter((r) => r.transfer === transferId)
      .reduce((n, r) => n + r.amount, 0);
  }

  /** Net money Stripe moved to `destination` (transfers - reversals). */
  netTo(destination: string): number {
    let total = 0;
    const byId = new Map<string, string>();
    for (const t of this.transfersByKey.values()) {
      byId.set(t.id, t.destination);
      if (t.destination === destination) total += t.amount;
    }
    for (const r of this.reversals) {
      if (byId.get(r.transfer) === destination) total -= r.amount;
    }
    return total;
  }
}
