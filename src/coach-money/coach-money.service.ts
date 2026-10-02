import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { DUNNING_V2_CADENCE_DAYS } from '../checkout/dunning-v2/dunning-v2.cadence';

// S-COACH (agent 111) — TGP Money read model for the coach Money page.
//
// Every number here is derived from rows the payment pipeline already
// writes (ClientPurchase, SplitLedgerEntry, ChargeRefund, ChargeDispute,
// DunningState, PaymentReminder). Nothing is estimated:
//   - net, TGP fee and head-coach split come from the split ledger slices
//     (`destination`, `application_fee`, `head_coach_split`);
//   - card processing comes from `stripe_fee` slices, which only the
//     separate-charges settlement (backend #627) writes. Before #627 the
//     platform pays Stripe's fee on a destination charge, so a charge with
//     no `stripe_fee` slice reports processing 0 with
//     `processing_paid_by: 'platform'` instead of an invented estimate.
//
// Tenancy: every query is scoped to the authenticated coach (seller
// `coach_user_id` or ledger `payee_user_id`). No method accepts a coach id
// from the request.

export const MONEY_MAX_WINDOW_DAYS = 400;
export const MONEY_CHARGES_PAGE_DEFAULT = 20;
export const MONEY_CHARGES_PAGE_MAX = 50;

const DAY_MS = 86_400_000;

/** Purchase statuses that mean "the client's payment did not go through". */
export const FAILED_PURCHASE_STATUSES = ['past_due', 'payment_failed'] as const;
/** Purchase statuses that mean "the client paid and access is live". */
export const PAID_PURCHASE_STATUSES = ['paid', 'active'] as const;
/** Dispute statuses that still need the coach's attention. */
export const OPEN_DISPUTE_STATUSES = [
  'warning_needs_response',
  'warning_under_review',
  'needs_response',
  'under_review',
] as const;

export type ChargeStatusFilter = 'all' | 'paid' | 'failed' | 'refunded';
export const CHARGE_STATUS_FILTERS: readonly ChargeStatusFilter[] = [
  'all',
  'paid',
  'failed',
  'refunded',
];

export type ProcessingPaidBy = 'coach' | 'platform' | 'mixed' | 'none';

export interface MoneyWindow {
  from: Date;
  to: Date;
}

export interface MoneyTotals {
  /** What clients were charged for sales in the window (sum of slices). */
  gross_cents: number;
  /** Stripe's actual processing fee borne by the coach (stripe_fee slices). */
  processing_cents: number;
  /** TGP's 2% (application_fee slices, net of reversals). */
  platform_fee_cents: number;
  /** Head-coach share taken from this coach's sales (sub-coach sellers). */
  head_coach_split_cents: number;
  /** Coach share returned on refunds / disputes (destination reversals). */
  refunded_cents: number;
  /** Head-coach income this coach earned on their sub-coaches' sales. */
  head_coach_income_cents: number;
  /** Net to the coach = destination - reversals + head-coach income. */
  net_cents: number;
  /** Charges (purchases) that contributed a destination slice. */
  charge_count: number;
  processing_paid_by: ProcessingPaidBy;
}

export interface MoneySummaryDto {
  currency: string;
  window: { from: string; to: string };
  compare: { from: string; to: string } | null;
  totals: MoneyTotals;
  compare_totals: MoneyTotals | null;
  /** totals.net - compare_totals.net, or null with no compare window. */
  change_cents: number | null;
  /** Percent change, 1 decimal; null when the previous net was 0. */
  change_pct: number | null;
  recurring: {
    mrr_cents: number;
    paying_clients: number;
    churned_30d: number;
    new_clients_30d: number;
  };
  attention_count: number;
  generated_at: string;
}

export interface MoneyChargeDto {
  id: string;
  client: { id: string; name: string };
  package: { id: string; name: string };
  amount_cents: number;
  currency: string;
  billing_type: 'one_time' | 'recurring';
  /** Coach-facing state. `canceled` = the checkout never completed. */
  state:
    'paid' | 'failed' | 'refunded' | 'partially_refunded' | 'disputed' | 'pending' | 'canceled';
  refunded_cents: number;
  created_at: string;
}

export interface MoneyChargeBreakdownDto {
  charge: MoneyChargeDto;
  breakdown: {
    price_cents: number;
    processing_cents: number;
    platform_fee_cents: number;
    head_coach_split_cents: number;
    refunded_cents: number;
    net_cents: number;
    processing_paid_by: ProcessingPaidBy;
    /** False until the ledger has slices for this charge (e.g. still pending). */
    settled: boolean;
  };
}

export interface MoneyAttentionItem {
  kind: 'failed_payment' | 'dispute' | 'stripe_requirements';
  id: string;
  client: { id: string; name: string } | null;
  amount_cents: number | null;
  currency: string | null;
  created_at: string | null;
  failed_payment?: {
    purchase_id: string;
    package_name: string;
    attempt: number;
    max_attempts: number;
    next_retry_at: string | null;
    locked_out_at: string | null;
    card_update_link_sent_at: string | null;
    last_failure_reason: string | null;
  };
  dispute?: {
    purchase_id: string;
    status: string;
    reason: string | null;
    evidence_due_by: string | null;
  };
  stripe_requirements?: {
    currently_due: string[];
    past_due: string[];
    current_deadline: string | null;
    disabled_reason: string | null;
  };
}

export interface MoneyAttentionDto {
  count: number;
  items: MoneyAttentionItem[];
}

interface SliceRow {
  kind: string;
  payee_user_id: string | null;
  amount_cents: number;
  reversed_cents: number;
  status: string;
  purchase_id: string;
  currency: string;
}

const COUNTED_SLICE_STATUSES = ['posted', 'reversed'];

/**
 * A purchase was paid when its status says so OR the ledger holds a posted
 * coach slice for it (a paid purchase that later canceled or expired keeps
 * its ledger rows, so it still counts as a sale).
 */
const PAID_WHERE = {
  OR: [
    { status: { in: [...PAID_PURCHASE_STATUSES] } },
    { splits: { some: { kind: 'destination', status: { in: COUNTED_SLICE_STATUSES } } } },
  ],
};

function emptyTotals(): MoneyTotals {
  return {
    gross_cents: 0,
    processing_cents: 0,
    platform_fee_cents: 0,
    head_coach_split_cents: 0,
    refunded_cents: 0,
    head_coach_income_cents: 0,
    net_cents: 0,
    charge_count: 0,
    processing_paid_by: 'none',
  };
}

/**
 * Pure fold of ledger slices into coach-facing totals. Exported for tests.
 *
 * `sellerSlices` are every slice of purchases the coach SOLD; `incomeSlices`
 * are head_coach_split slices where the coach is the PAYEE on a sub-coach's
 * sale. A reversal never counts twice: each slice contributes
 * amount - reversed exactly once.
 */
export function foldTotals(
  coachId: string,
  sellerSlices: readonly SliceRow[],
  incomeSlices: readonly SliceRow[],
): MoneyTotals {
  const t = emptyTotals();
  const chargesWithDestination = new Set<string>();
  const chargesWithStripeFee = new Set<string>();
  for (const s of sellerSlices) {
    const kept = Math.max(0, s.amount_cents - s.reversed_cents);
    t.gross_cents += s.amount_cents;
    switch (s.kind) {
      case 'destination':
        if (s.payee_user_id === coachId) {
          t.net_cents += kept;
          t.refunded_cents += s.reversed_cents;
          chargesWithDestination.add(s.purchase_id);
        }
        break;
      case 'application_fee':
        t.platform_fee_cents += kept;
        break;
      case 'head_coach_split':
        t.head_coach_split_cents += kept;
        break;
      case 'stripe_fee':
        t.processing_cents += s.amount_cents;
        chargesWithStripeFee.add(s.purchase_id);
        break;
      default:
        break;
    }
  }
  for (const s of incomeSlices) {
    if (s.kind !== 'head_coach_split' || s.payee_user_id !== coachId) continue;
    const kept = Math.max(0, s.amount_cents - s.reversed_cents);
    t.head_coach_income_cents += kept;
    t.net_cents += kept;
  }
  t.charge_count = chargesWithDestination.size;
  if (chargesWithDestination.size === 0) t.processing_paid_by = 'none';
  else {
    let coachPaid = 0;
    for (const id of chargesWithDestination) if (chargesWithStripeFee.has(id)) coachPaid += 1;
    t.processing_paid_by =
      coachPaid === 0 ? 'platform' : coachPaid === chargesWithDestination.size ? 'coach' : 'mixed';
  }
  return t;
}

export function changePct(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

/** Parse and bound a money window. Throws 400 with a stable code. */
export function parseWindow(
  fromRaw: string | undefined,
  toRaw: string | undefined,
  label: 'window' | 'compare',
): MoneyWindow {
  const code = label === 'window' ? 'MONEY_WINDOW_INVALID' : 'MONEY_COMPARE_WINDOW_INVALID';
  const from = fromRaw ? new Date(fromRaw) : null;
  const to = toRaw ? new Date(toRaw) : null;
  if (!from || !to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new BadRequestException({
      code,
      message: 'from and to must be ISO-8601 timestamps.',
    });
  }
  if (from.getTime() >= to.getTime()) {
    throw new BadRequestException({ code, message: 'from must be before to.' });
  }
  if (to.getTime() - from.getTime() > MONEY_MAX_WINDOW_DAYS * DAY_MS) {
    throw new BadRequestException({
      code,
      message: `A window can span at most ${MONEY_MAX_WINDOW_DAYS} days.`,
    });
  }
  return { from, to };
}

function displayName(u: { name?: string | null } | null | undefined): string {
  const n = (u?.name ?? '').trim();
  return n.length > 0 ? n : 'Client';
}

@Injectable()
export class CoachMoneyService {
  constructor(private readonly prisma: PrismaService) {}

  // ── summary ──────────────────────────────────────────────────────────

  async getSummary(
    coachId: string,
    window: MoneyWindow,
    compare: MoneyWindow | null,
    now: Date = new Date(),
  ): Promise<MoneySummaryDto> {
    const [totals, compareTotals, recurring, attention] = await Promise.all([
      this.totalsFor(coachId, window),
      compare ? this.totalsFor(coachId, compare) : Promise.resolve(null),
      this.recurring(coachId, now),
      this.getAttention(coachId),
    ]);
    return {
      currency: 'usd',
      window: { from: window.from.toISOString(), to: window.to.toISOString() },
      compare: compare ? { from: compare.from.toISOString(), to: compare.to.toISOString() } : null,
      totals,
      compare_totals: compareTotals,
      change_cents: compareTotals ? totals.net_cents - compareTotals.net_cents : null,
      change_pct: compareTotals ? changePct(totals.net_cents, compareTotals.net_cents) : null,
      recurring,
      attention_count: attention.count,
      generated_at: now.toISOString(),
    };
  }

  private windowWhere(window: MoneyWindow) {
    // A slice belongs to the window it was posted in; slices without a
    // posted_at (legacy rows) fall back to their creation time.
    return {
      OR: [
        { posted_at: { gte: window.from, lt: window.to } },
        { posted_at: null, created_at: { gte: window.from, lt: window.to } },
      ],
    };
  }

  async totalsFor(coachId: string, window: MoneyWindow): Promise<MoneyTotals> {
    const select = {
      kind: true,
      payee_user_id: true,
      amount_cents: true,
      reversed_cents: true,
      status: true,
      purchase_id: true,
      currency: true,
    } as const;
    const [sellerSlices, incomeSlices] = await Promise.all([
      this.prisma.splitLedgerEntry.findMany({
        where: {
          status: { in: COUNTED_SLICE_STATUSES },
          purchase: { coach_user_id: coachId, source: null },
          ...this.windowWhere(window),
        },
        select,
      }),
      this.prisma.splitLedgerEntry.findMany({
        where: {
          status: { in: COUNTED_SLICE_STATUSES },
          kind: 'head_coach_split',
          payee_user_id: coachId,
          purchase: { coach_user_id: { not: coachId } },
          ...this.windowWhere(window),
        },
        select,
      }),
    ]);
    return foldTotals(coachId, sellerSlices, incomeSlices);
  }

  private async recurring(coachId: string, now: Date) {
    const thirtyAgo = new Date(now.getTime() - 30 * DAY_MS);
    const [active, churned, newPurchases] = await Promise.all([
      this.prisma.clientPurchase.findMany({
        where: {
          coach_user_id: coachId,
          entitlement_active: true,
          source: null,
          amount_cents: { gt: 0 },
        },
        select: {
          client_user_id: true,
          amount_cents: true,
          billing_type: true,
          package: { select: { interval: true } },
        },
      }),
      this.prisma.clientPurchase.findMany({
        where: {
          coach_user_id: coachId,
          source: null,
          amount_cents: { gt: 0 },
          canceled_at: { gte: thirtyAgo, lte: now },
        },
        select: { client_user_id: true },
      }),
      this.prisma.clientPurchase.findMany({
        where: {
          coach_user_id: coachId,
          source: null,
          amount_cents: { gt: 0 },
          ...PAID_WHERE,
          created_at: { gte: thirtyAgo, lte: now },
        },
        select: { client_user_id: true },
      }),
    ]);
    let mrr = 0;
    for (const p of active) {
      if (p.billing_type !== 'recurring') continue;
      mrr += p.package?.interval === 'year' ? Math.round(p.amount_cents / 12) : p.amount_cents;
    }
    const payingIds = new Set(active.map((p) => p.client_user_id));
    // A client counts as new when their first paid purchase with this coach
    // is inside the last 30 days.
    const candidateIds = [...new Set(newPurchases.map((p) => p.client_user_id))];
    let newClients = 0;
    if (candidateIds.length > 0) {
      const earlier = await this.prisma.clientPurchase.findMany({
        where: {
          coach_user_id: coachId,
          source: null,
          amount_cents: { gt: 0 },
          client_user_id: { in: candidateIds },
          created_at: { lt: thirtyAgo },
          ...PAID_WHERE,
        },
        select: { client_user_id: true },
      });
      const returning = new Set(earlier.map((p) => p.client_user_id));
      newClients = candidateIds.filter((id) => !returning.has(id)).length;
    }
    // Churned = clients who canceled in the window and hold no other active
    // paid purchase with this coach today.
    const churnedIds = new Set(
      churned.map((p) => p.client_user_id).filter((id) => !payingIds.has(id)),
    );
    return {
      mrr_cents: mrr,
      paying_clients: payingIds.size,
      churned_30d: churnedIds.size,
      new_clients_30d: newClients,
    };
  }

  // ── charges ──────────────────────────────────────────────────────────

  async listCharges(
    coachId: string,
    opts: { status: ChargeStatusFilter; cursor?: string | null; limit?: number },
  ): Promise<{ charges: MoneyChargeDto[]; next_cursor: string | null }> {
    const limit = Math.min(
      Math.max(opts.limit ?? MONEY_CHARGES_PAGE_DEFAULT, 1),
      MONEY_CHARGES_PAGE_MAX,
    );
    const statusWhere =
      opts.status === 'paid'
        ? PAID_WHERE
        : opts.status === 'failed'
          ? { status: { in: [...FAILED_PURCHASE_STATUSES] } }
          : opts.status === 'refunded'
            ? { refunds: { some: { status: 'succeeded' } } }
            : {};
    const rows = await this.prisma.clientPurchase.findMany({
      where: { coach_user_id: coachId, source: null, amount_cents: { gt: 0 }, ...statusWhere },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      select: this.chargeSelect(),
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      charges: page.map((r) => this.toCharge(r)),
      next_cursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  async getChargeBreakdown(coachId: string, purchaseId: string): Promise<MoneyChargeBreakdownDto> {
    const row = await this.prisma.clientPurchase.findFirst({
      where: { id: purchaseId, coach_user_id: coachId, source: null },
      select: this.chargeSelect(),
    });
    if (!row) {
      throw new NotFoundException({
        code: 'MONEY_CHARGE_NOT_FOUND',
        message: 'This charge is not one of your sales.',
      });
    }
    const slices = await this.prisma.splitLedgerEntry.findMany({
      where: { purchase_id: row.id, status: { in: COUNTED_SLICE_STATUSES } },
      select: {
        kind: true,
        payee_user_id: true,
        amount_cents: true,
        reversed_cents: true,
        status: true,
        purchase_id: true,
        currency: true,
      },
    });
    const t = foldTotals(coachId, slices, []);
    const settled = slices.some((s) => s.kind === 'destination');
    return {
      charge: this.toCharge(row),
      breakdown: {
        price_cents: settled ? t.gross_cents : row.amount_cents,
        processing_cents: t.processing_cents,
        platform_fee_cents: t.platform_fee_cents,
        head_coach_split_cents: t.head_coach_split_cents,
        refunded_cents: t.refunded_cents,
        net_cents: t.net_cents,
        processing_paid_by: settled ? t.processing_paid_by : 'none',
        settled,
      },
    };
  }

  private chargeSelect() {
    return {
      id: true,
      amount_cents: true,
      currency: true,
      billing_type: true,
      status: true,
      created_at: true,
      client: { select: { id: true, name: true } },
      package: { select: { id: true, name: true } },
      refunds: { where: { status: 'succeeded' }, select: { amount_cents: true } },
      disputes: { select: { status: true } },
      splits: {
        where: { kind: 'destination', status: { in: COUNTED_SLICE_STATUSES } },
        select: { id: true },
        take: 1,
      },
    } as const;
  }

  private toCharge(r: {
    id: string;
    amount_cents: number;
    currency: string;
    billing_type: string;
    status: string;
    created_at: Date;
    client: { id: string; name: string | null } | null;
    package: { id: string; name: string } | null;
    refunds: Array<{ amount_cents: number }>;
    disputes: Array<{ status: string }>;
    splits: Array<{ id: string }>;
  }): MoneyChargeDto {
    const refunded = r.refunds.reduce((acc, x) => acc + x.amount_cents, 0);
    const openDispute = r.disputes.some((d) =>
      (OPEN_DISPUTE_STATUSES as readonly string[]).includes(d.status),
    );
    let state: MoneyChargeDto['state'];
    if (openDispute) state = 'disputed';
    else if (refunded > 0 && refunded >= r.amount_cents) state = 'refunded';
    else if (refunded > 0) state = 'partially_refunded';
    else if ((FAILED_PURCHASE_STATUSES as readonly string[]).includes(r.status)) state = 'failed';
    else if (
      (PAID_PURCHASE_STATUSES as readonly string[]).includes(r.status) ||
      r.splits.length > 0
    )
      state = 'paid';
    else if (r.status === 'canceled' || r.status === 'expired') state = 'canceled';
    else state = 'pending';
    return {
      id: r.id,
      client: { id: r.client?.id ?? '', name: displayName(r.client) },
      package: { id: r.package?.id ?? '', name: r.package?.name ?? 'Package' },
      amount_cents: r.amount_cents,
      currency: r.currency,
      billing_type: r.billing_type === 'recurring' ? 'recurring' : 'one_time',
      state,
      refunded_cents: refunded,
      created_at: r.created_at.toISOString(),
    };
  }

  // ── needs attention ──────────────────────────────────────────────────

  async getAttention(coachId: string): Promise<MoneyAttentionDto> {
    const [failed, disputes, account] = await Promise.all([
      this.prisma.clientPurchase.findMany({
        where: {
          coach_user_id: coachId,
          source: null,
          status: { in: [...FAILED_PURCHASE_STATUSES] },
        },
        orderBy: { updated_at: 'desc' },
        take: 50,
        select: {
          id: true,
          amount_cents: true,
          currency: true,
          updated_at: true,
          last_error: true,
          client: { select: { id: true, name: true } },
          package: { select: { name: true } },
          dunning: {
            select: {
              status: true,
              failure_count: true,
              step_index: true,
              next_attempt_at: true,
              locked_out_at: true,
              last_failed_amount_cents: true,
              last_failure_at: true,
              last_failure_reason: true,
            },
          },
          reminders: {
            where: { status: 'sent' },
            orderBy: { sent_at: 'desc' },
            take: 1,
            select: { sent_at: true },
          },
        },
      }),
      this.prisma.chargeDispute.findMany({
        where: {
          status: { in: [...OPEN_DISPUTE_STATUSES] },
          purchase: { coach_user_id: coachId },
        },
        orderBy: { created_at: 'desc' },
        take: 50,
        select: {
          id: true,
          purchase_id: true,
          amount_cents: true,
          currency: true,
          status: true,
          reason: true,
          evidence_due_by: true,
          created_at: true,
          purchase: { select: { client: { select: { id: true, name: true } } } },
        },
      }),
      this.prisma.connectAccount.findUnique({
        where: { coach_user_id: coachId },
        select: { requirements_due: true, disabled_reason: true },
      }),
    ]);

    const maxAttempts = DUNNING_V2_CADENCE_DAYS.length;
    const items: MoneyAttentionItem[] = [];
    for (const p of failed) {
      const d = p.dunning;
      const attempt = Math.min(
        maxAttempts,
        Math.max(1, d ? Math.max(d.failure_count, d.step_index + 1) : 1),
      );
      items.push({
        kind: 'failed_payment',
        id: `failed:${p.id}`,
        client: p.client ? { id: p.client.id, name: displayName(p.client) } : null,
        amount_cents: d?.last_failed_amount_cents ?? p.amount_cents,
        currency: p.currency,
        created_at: (d?.last_failure_at ?? p.updated_at).toISOString(),
        failed_payment: {
          purchase_id: p.id,
          package_name: p.package?.name ?? 'Package',
          attempt,
          max_attempts: maxAttempts,
          next_retry_at: d?.next_attempt_at ? d.next_attempt_at.toISOString() : null,
          locked_out_at: d?.locked_out_at ? d.locked_out_at.toISOString() : null,
          card_update_link_sent_at: p.reminders[0]?.sent_at
            ? p.reminders[0].sent_at.toISOString()
            : null,
          last_failure_reason: d?.last_failure_reason ?? p.last_error ?? null,
        },
      });
    }
    for (const dsp of disputes) {
      const c = dsp.purchase?.client;
      items.push({
        kind: 'dispute',
        id: `dispute:${dsp.id}`,
        client: c ? { id: c.id, name: displayName(c) } : null,
        amount_cents: dsp.amount_cents,
        currency: dsp.currency,
        created_at: dsp.created_at.toISOString(),
        dispute: {
          purchase_id: dsp.purchase_id,
          status: dsp.status,
          reason: dsp.reason,
          evidence_due_by: dsp.evidence_due_by ? dsp.evidence_due_by.toISOString() : null,
        },
      });
    }
    const req = readRequirements(account?.requirements_due);
    if (req.currently_due.length > 0 || req.past_due.length > 0) {
      items.push({
        kind: 'stripe_requirements',
        id: 'stripe_requirements',
        client: null,
        amount_cents: null,
        currency: null,
        created_at: null,
        stripe_requirements: {
          currently_due: req.currently_due,
          past_due: req.past_due,
          current_deadline: req.current_deadline,
          disabled_reason: account?.disabled_reason ?? null,
        },
      });
    }
    return { count: items.length, items };
  }
}

export interface ParsedRequirements {
  currently_due: string[];
  past_due: string[];
  eventually_due: string[];
  pending_verification: string[];
  current_deadline: string | null;
}

/** Read Stripe's `requirements` hash as mirrored on ConnectAccount. */
export function readRequirements(raw: unknown): ParsedRequirements {
  const out: ParsedRequirements = {
    currently_due: [],
    past_due: [],
    eventually_due: [],
    pending_verification: [],
    current_deadline: null,
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  const list = (k: string): string[] =>
    Array.isArray(r[k])
      ? (r[k] as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
  out.currently_due = list('currently_due');
  out.past_due = list('past_due');
  out.eventually_due = list('eventually_due');
  out.pending_verification = list('pending_verification');
  const deadline = r['current_deadline'];
  if (typeof deadline === 'number' && Number.isFinite(deadline) && deadline > 0) {
    out.current_deadline = new Date(deadline * 1000).toISOString();
  }
  return out;
}
