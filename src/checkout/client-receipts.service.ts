import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  StripeConnectApiService,
  type StripeChargeObject,
} from '../connect/stripe-connect-api.service';
import { resolveRecipientTimeZone } from '../notifications/recipient-timezone';
import { PrismaService } from '../prisma.service';
import { normalizeCurrency } from './client-billing.money';

// C5RECEIPTS (MOCKUP-3 C5 slice 6) — the signed-in client's own receipts.
//
//   GET /v1/checkout/receipts        newest first, cursor paged, + summary
//   GET /v1/checkout/receipts/:id    one receipt
//
// One receipt per Stripe charge the client paid (ChargeSettlement: the first
// charge and every renewal), scoped by ClientPurchase.client_user_id. Another
// client's receipt id answers 404, exactly like an unknown id. Never in a
// response: the TGP fee, the coach payout or split, the coach's Stripe
// account, any other client (RECEIPT_SETTLEMENT_SELECT reads none of them).
//
// Money comes from stored rows: amount = ChargeSettlement.gross_cents, refunds
// = the charge's succeeded ChargeRefund rows (the coach Money rule), net and
// status computed here. Stripe-only fields (receipt number, card, statement
// descriptor, receipt link, invoice period) come from the charge through the
// existing Stripe client, cached briefly; any Stripe failure leaves them null.
// Stripe is read only for the rows a response returns, never for the summary.
// A converted charge (settled in another currency) needs Stripe for what the
// card paid; when that is unknown its paid and net amounts are null (refunds
// stay in the card currency), so is its status once it has refunds, and the
// yearly total is null, never mixed.

/** Stripe answers slower than this leave the Stripe-only fields null. */
const STRIPE_DEADLINE_MS = 3_000;
const DETAILS_TTL_MS = 10 * 60_000;
const DETAILS_FAILURE_TTL_MS = 60_000;
const DETAILS_CACHE_MAX = 2_000;
const DEFAULT_PAGE = 20;
const MAX_PAGE = 50;
/** Covers the client's calendar year in any time zone. */
const YEAR_WINDOW_MS = 367 * 24 * 60 * 60_000;
const YEAR_ROWS_CAP = 500;

export type ReceiptStatus = 'paid' | 'partly_refunded' | 'refunded';

export interface ClientReceipt {
  id: string;
  number: string | null;
  charged_at: string;
  // null: a converted charge whose card amount Stripe could not give.
  amount_cents: number | null;
  currency: string;
  refunded_cents: number;
  refunds: Array<{ amount_cents: number; created_at: string }>;
  net_cents: number | null;
  // null: refunded, but the amount is null, so full or partial is unknown.
  status: ReceiptStatus | null;
  plan_name: string | null;
  coach_name: string | null;
  period_start: string | null;
  period_end: string | null;
  card_brand: string | null;
  card_last4: string | null;
  statement_descriptor: string | null;
  receipt_url: string | null;
}

export interface ClientReceiptList {
  receipts: ClientReceipt[];
  next_cursor: string | null;
  // null when this year's total is not known in one currency.
  summary: { paid_this_year_cents: number | null; currency: string | null };
}

/** The only ChargeSettlement fields a receipt reads. */
const RECEIPT_SETTLEMENT_SELECT = {
  id: true,
  stripe_charge_id: true,
  currency: true,
  gross_cents: true,
  created_at: true,
  purchase: { select: { coach_user_id: true, currency: true, package: { select: { name: true } } } },
} as const satisfies Prisma.ChargeSettlementSelect;

type SettlementRow = Prisma.ChargeSettlementGetPayload<{
  select: typeof RECEIPT_SETTLEMENT_SELECT;
}>;

type StripeFields = 'number' | 'card_brand' | 'card_last4' | 'statement_descriptor' | 'receipt_url';
type ChargeDetails = Pick<ClientReceipt, StripeFields | 'period_start' | 'period_end'> & {
  amount_cents: number | null;
  currency: string | null;
};

export function receiptNotFound(): NotFoundException {
  return new NotFoundException({
    code: 'RECEIPT_NOT_FOUND',
    error: 'RECEIPT_NOT_FOUND',
    message: 'That receipt was not found on your account. Pull down to refresh your receipts.',
  });
}

/** Net and status from the paid amount and its succeeded refunds. */
export function receiptMoney(
  amountCents: number,
  refundedCents: number,
): { net_cents: number; status: ReceiptStatus } {
  const net = Math.max(0, amountCents - refundedCents);
  if (refundedCents > 0 && net === 0) return { net_cents: 0, status: 'refunded' };
  if (refundedCents > 0) return { net_cents: net, status: 'partly_refunded' };
  return { net_cents: net, status: 'paid' };
}

/**
 * Net and status when the paid amount is unknown (a converted charge Stripe
 * could not price). With no refunds it is `paid`; with refunds, full or partial
 * is unknown too. The settlement's refund debits are no guide: Stripe converts
 * each refund at that day's rate, so a full refund can debit less than the gross.
 */
export function unknownMoney(
  refundedCents: number,
): { net_cents: null; status: ReceiptStatus | null } {
  return { net_cents: null, status: refundedCents === 0 ? 'paid' : null };
}

/** The calendar year of `d` in `timeZone`. */
export function yearIn(d: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(d));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const unixIso = (v: unknown): string | null =>
  typeof v === 'number' && Number.isFinite(v) ? new Date(v * 1000).toISOString() : null;

/** The Stripe-only receipt fields of one charge (invoice expanded). */
export function chargeDetails(charge: StripeChargeObject): ChargeDetails {
  const pmd: unknown = charge.payment_method_details;
  const card: Record<string, unknown> = isRecord(pmd) && isRecord(pmd.card) ? pmd.card : {};
  const url = str(charge.receipt_url);
  const invoice: unknown = charge.invoice;
  const lines = isRecord(invoice) && isRecord(invoice.lines) ? invoice.lines.data : null;
  const withPeriod = (Array.isArray(lines) ? lines : []).filter(
    (l): l is Record<string, unknown> & { period: Record<string, unknown> } =>
      isRecord(l) && isRecord(l.period),
  );
  const line = withPeriod.find((l) => l.type === 'subscription') ?? withPeriod[0];
  return {
    number: str(charge.receipt_number),
    amount_cents: Number.isInteger(charge.amount) ? charge.amount : null,
    currency: str(charge.currency) ? normalizeCurrency(charge.currency) : null,
    card_brand: str(card.brand),
    card_last4: str(card.last4),
    statement_descriptor: str(charge.calculated_statement_descriptor),
    receipt_url: url && url.startsWith('https://') ? url : null,
    period_start: line ? unixIso(line.period.start) : null,
    period_end: line ? unixIso(line.period.end) : null,
  };
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('stripe_deadline')), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

@Injectable()
export class ClientReceiptsService {
  private readonly logger = new Logger(ClientReceiptsService.name);
  private readonly details = new Map<string, { at: number; value: ChargeDetails | null }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeConnectApiService,
  ) {}

  async list(
    clientUserId: string,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<ClientReceiptList> {
    const take =
      Number.isInteger(opts.limit) && (opts.limit ?? 0) > 0
        ? Math.min(opts.limit ?? DEFAULT_PAGE, MAX_PAGE)
        : DEFAULT_PAGE;
    const rows = await this.prisma.chargeSettlement.findMany({
      where: { purchase: { client_user_id: clientUserId } },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: take + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      select: RECEIPT_SETTLEMENT_SELECT,
    });
    const page = rows.slice(0, take);
    const [receipts, year] = await Promise.all([
      this.build(page, true),
      this.yearRows(clientUserId),
    ]);
    return {
      receipts,
      next_cursor: rows.length > take ? (page[page.length - 1]?.id ?? null) : null,
      // After the page, so its converted rows are already in the cache.
      summary: await this.paidThisYear(year),
    };
  }

  async get(clientUserId: string, receiptId: string): Promise<ClientReceipt> {
    const row = await this.prisma.chargeSettlement.findFirst({
      where: { id: receiptId, purchase: { client_user_id: clientUserId } },
      select: RECEIPT_SETTLEMENT_SELECT,
    });
    if (!row) throw receiptNotFound();
    const [receipt] = await this.build([row], true);
    return receipt;
  }

  /** The client's settlement rows in their own calendar year (time zone resolved). */
  private async yearRows(clientUserId: string): Promise<SettlementRow[]> {
    const now = new Date();
    const [rows, zone] = await Promise.all([
      this.prisma.chargeSettlement.findMany({
        where: {
          purchase: { client_user_id: clientUserId },
          created_at: { gte: new Date(now.getTime() - YEAR_WINDOW_MS) },
        },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: YEAR_ROWS_CAP,
        select: RECEIPT_SETTLEMENT_SELECT,
      }),
      resolveRecipientTimeZone(this.prisma, clientUserId),
    ]);
    const timeZone = zone ?? 'UTC';
    const year = yearIn(now, timeZone);
    return rows.filter((r) => yearIn(r.created_at, timeZone) === year);
  }

  /**
   * Sum of net_cents for the year, with no Stripe read: a converted row counts
   * only when its card amount is already cached, else the total is unknown.
   */
  private async paidThisYear(rows: SettlementRow[]): Promise<ClientReceiptList['summary']> {
    const receipts = await this.build(rows, false);
    const currencies = new Set(receipts.map((r) => r.currency));
    let total = 0;
    for (const r of receipts) {
      if (r.net_cents === null || currencies.size > 1) {
        return { paid_this_year_cents: null, currency: null };
      }
      total += r.net_cents;
    }
    return { paid_this_year_cents: total, currency: receipts[0]?.currency ?? null };
  }

  /**
   * Receipts for settlement rows the caller already scoped to the client.
   * `readStripe`: read Stripe for every row; otherwise use only cached answers.
   */
  private async build(rows: SettlementRow[], readStripe: boolean): Promise<ClientReceipt[]> {
    if (rows.length === 0) return [];
    const chargeIds = rows.map((r) => r.stripe_charge_id);
    const coachIds = [...new Set(rows.map((r) => r.purchase.coach_user_id))];
    const [refunds, coaches] = await Promise.all([
      this.prisma.chargeRefund.findMany({
        where: { stripe_charge_id: { in: chargeIds }, status: 'succeeded' },
        orderBy: { created_at: 'asc' },
        select: { stripe_charge_id: true, amount_cents: true, created_at: true },
      }),
      this.prisma.user.findMany({
        where: { id: { in: coachIds } },
        select: { id: true, name: true },
      }),
    ]);
    const coachName = new Map(coaches.map((u) => [u.id, u.name || null] as const));
    return Promise.all(
      rows.map(async (row) => {
        const converted = row.currency !== normalizeCurrency(row.purchase.currency);
        const details = readStripe
          ? await this.chargeDetails(row.stripe_charge_id)
          : this.cachedDetails(row.stripe_charge_id);
        // A converted charge's settlement gross is in the platform currency;
        // the client paid the Stripe charge amount in their own currency, the
        // currency its refunds are in. Without that amount it is unknown.
        const card =
          converted && details?.amount_cents != null && details.currency ? details : null;
        const amount = converted ? (card?.amount_cents ?? null) : row.gross_cents;
        const currency = converted ? row.purchase.currency : row.currency;
        const own = refunds.filter((r) => r.stripe_charge_id === row.stripe_charge_id);
        const refunded = own.reduce((sum, r) => sum + r.amount_cents, 0);
        return {
          id: row.id,
          number: details?.number ?? null,
          charged_at: row.created_at.toISOString(),
          amount_cents: amount,
          currency: card?.currency ?? normalizeCurrency(currency),
          refunded_cents: refunded,
          refunds: own.map((r) => ({
            amount_cents: r.amount_cents,
            created_at: r.created_at.toISOString(),
          })),
          ...(amount === null ? unknownMoney(refunded) : receiptMoney(amount, refunded)),
          plan_name: row.purchase.package?.name ?? null,
          coach_name: coachName.get(row.purchase.coach_user_id) ?? null,
          period_start: details?.period_start ?? null,
          period_end: details?.period_end ?? null,
          card_brand: details?.card_brand ?? null,
          card_last4: details?.card_last4 ?? null,
          statement_descriptor: details?.statement_descriptor ?? null,
          receipt_url: details?.receipt_url ?? null,
        };
      }),
    );
  }

  /** A fresh cached answer for one charge, with no Stripe read; undefined if none. */
  private cachedDetails(chargeId: string, now = Date.now()): ChargeDetails | null | undefined {
    const hit = this.details.get(chargeId);
    const ttl = hit?.value ? DETAILS_TTL_MS : DETAILS_FAILURE_TTL_MS;
    return hit && now - hit.at < ttl ? hit.value : undefined;
  }

  /** Cached Stripe-only fields of one charge; null when Stripe cannot answer. */
  private async chargeDetails(chargeId: string): Promise<ChargeDetails | null> {
    const now = Date.now();
    const hit = this.cachedDetails(chargeId, now);
    if (hit !== undefined) return hit;
    let value: ChargeDetails | null = null;
    try {
      const charge = await withDeadline(
        this.stripe.retrieveCharge(chargeId, { expandInvoice: true }),
        STRIPE_DEADLINE_MS,
      );
      value = chargeDetails(charge);
    } catch (err) {
      this.logger.warn(`receipt details unavailable charge=${chargeId}: ${(err as Error).name}`);
    }
    if (this.details.size >= DETAILS_CACHE_MAX) {
      const oldest = this.details.keys().next().value;
      if (oldest !== undefined) this.details.delete(oldest);
    }
    this.details.set(chargeId, { at: now, value });
    return value;
  }
}
