/**
 * S-COACH-MOB-2 — typed client for TGP Money (coach Home card + Money page).
 *
 * Every number comes from a live backend route (backend #641 and existing
 * Connect routes); nothing is estimated on the device:
 *   GET  /v1/coach/money/summary?from&to&compare_from&compare_to[&currency]
 *   GET  /v1/coach/money/export.csv?from&to[&currency]  tax CSV (C-641-4)
 *   GET  /v1/coach/money/charges?status&cursor&limit
 *   GET  /v1/coach/money/charges/:id         price - processing - TGP 2% = net
 *   GET  /v1/coach/money/attention           failed payments, disputes, Stripe
 *   GET  /coach/connect/payouts?limit        Stripe payouts (pending + paid)
 *   GET  /coach/connect/metrics              roster counts (no amounts)
 *   POST /v1/connect/accounts/dashboard-link Stripe Express dashboard link
 *
 * Every amount in a summary is in that summary's ONE currency (#641
 * B-641-3); a coach who sells in more than one currency switches between
 * them, and amounts in different currencies are never added together.
 * `held_from_next_sale_cents` is null until the server records held amounts
 * (backend #627 / OR-111-1) and the UI then hides the row.
 * Errors are thrown as-is; screens turn them into specific copy with
 * describeError (src/lib/coachSetup/errors.ts).
 */
import api from "../services/api";

export type MoneyRange = "today" | "30d" | "90d" | "ytd";
export const MONEY_RANGES: readonly MoneyRange[] = [
  "today",
  "30d",
  "90d",
  "ytd",
];

export type ProcessingPaidBy = "coach" | "platform" | "mixed" | "none";

export interface MoneyTotals {
  grossCents: number;
  processingCents: number;
  platformFeeCents: number;
  headCoachSplitCents: number;
  refundedCents: number;
  headCoachIncomeCents: number;
  netCents: number;
  chargeCount: number;
  processingPaidBy: ProcessingPaidBy;
}

export interface MoneySummary {
  /** The one currency every amount in this summary is in. */
  currency: string;
  /** Every currency the coach has money in; switch with `?currency=`. */
  currencies: string[];
  window: { from: string; to: string };
  compare: { from: string; to: string } | null;
  totals: MoneyTotals;
  compareTotals: MoneyTotals | null;
  changeCents: number | null;
  changePct: number | null;
  recurring: {
    mrrCents: number;
    payingClients: number;
    churned30d: number;
    newClients30d: number;
  };
  attentionCount: number;
  /**
   * What TGP holds from the coach's next sale after a refund or chargeback
   * (TGP 2% + Stripe fees, OR-111-1). null = the server does not send it yet.
   */
  heldFromNextSaleCents: number | null;
  generatedAt: string;
}

/** Coach-facing charge states, including ones newer backends add. */
export type ChargeState =
  | "paid"
  | "failed"
  | "refunded"
  | "partially_refunded"
  | "disputed"
  | "charged_back"
  | "pending"
  | "canceled";

export const CHARGE_STATES: readonly ChargeState[] = [
  "paid",
  "failed",
  "refunded",
  "partially_refunded",
  "disputed",
  "charged_back",
  "pending",
  "canceled",
];

export type BillingUnit = "week" | "month" | "year";

export interface MoneyCharge {
  id: string;
  client: { id: string; name: string };
  packageName: string;
  amountCents: number;
  currency: string;
  billingType: "one_time" | "recurring";
  /** The cadence this charge bills at; null when one-time or not known. */
  billingInterval: BillingUnit | null;
  billingIntervalCount: number | null;
  /** null when the server sent a state this build does not know. */
  state: ChargeState | null;
  rawState: string;
  refundedCents: number;
  /** What the bank took back on a lost dispute (0 when none). */
  chargedBackCents: number;
  createdAt: string;
  /** SWITCH-TELL (b#1132): when this client moved to another coach after this charge; null when they did not. */
  movedAwayAt: string | null;
}

export interface MoneyChargeBreakdown {
  charge: MoneyCharge;
  priceCents: number;
  processingCents: number;
  platformFeeCents: number;
  headCoachSplitCents: number;
  refundedCents: number;
  netCents: number;
  processingPaidBy: ProcessingPaidBy;
  settled: boolean;
}

export type ChargeFilter = "all" | "paid" | "failed" | "refunded" | "disputed";
export const CHARGE_FILTERS: readonly ChargeFilter[] = [
  "all",
  "paid",
  "failed",
  "refunded",
  "disputed",
];

export interface MoneyChargesPage {
  charges: MoneyCharge[];
  nextCursor: string | null;
}

export type AttentionKind =
  "failed_payment" | "dispute" | "stripe_requirements";

export interface AttentionItem {
  kind: AttentionKind;
  id: string;
  client: { id: string; name: string } | null;
  amountCents: number | null;
  currency: string | null;
  createdAt: string | null;
  failedPayment: {
    packageName: string;
    attempt: number;
    maxAttempts: number;
    nextRetryAt: string | null;
    lockedOutAt: string | null;
    cardUpdateLinkSentAt: string | null;
    lastFailureReason: string | null;
  } | null;
  dispute: {
    status: string;
    reason: string | null;
    evidenceDueBy: string | null;
  } | null;
  stripeRequirements: {
    currentlyDue: string[];
    pastDue: string[];
    currentDeadline: string | null;
    disabledReason: string | null;
  } | null;
}

export interface MoneyAttention {
  count: number;
  items: AttentionItem[];
}

export type KnownPayoutStatus =
  "pending" | "in_transit" | "paid" | "failed" | "canceled";
/** `unknown` = a Stripe status this build does not know (never "next"). */
export type PayoutStatus = KnownPayoutStatus | "unknown";

export interface MoneyPayout {
  id: string;
  amountCents: number;
  currency: string;
  status: PayoutStatus;
  /** Stripe's status as sent, for the unknown case. */
  rawStatus: string;
  arrivalDate: string | null;
  failureMessage: string | null;
}

/**
 * Roster figures from /coach/connect/metrics (the old Business metrics
 * screen). Money amounts are NOT read from it: every amount on the Money
 * page comes from the Money read model so two numbers never disagree.
 */
export interface RosterMetrics {
  rosterClients: number;
  joined30d: number;
  team: { acquired30d: number; churned30d: number };
}

// ─── parsing (the server is the contract; never invent a number) ───────────
//
// B-332-3: every money amount, count and currency is REQUIRED and checked.
// A missing or non-integer amount, an unknown currency or an incoherent
// window fails the whole read with MONEY_PAYLOAD_INVALID (specific copy, the
// request reference, Sentry) instead of turning into a believable $0.00.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  !!v && typeof v === "object" && !Array.isArray(v);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const strOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

/** Thrown when a Money response does not match the contract. */
export class MoneyPayloadError extends Error {
  readonly response: {
    status: number;
    data: { code: "MONEY_PAYLOAD_INVALID"; field: string };
    headers: unknown;
  };
  constructor(
    readonly what: string,
    readonly field: string,
    headers?: unknown,
  ) {
    super(`${what} payload invalid at ${field}`);
    this.name = "MoneyPayloadError";
    this.response = {
      status: 502,
      data: { code: "MONEY_PAYLOAD_INVALID", field },
      headers: headers ?? {},
    };
  }
}

class Reader {
  constructor(
    private readonly what: string,
    private readonly headers?: unknown,
  ) {}
  fail(field: string): never {
    throw new MoneyPayloadError(this.what, field, this.headers);
  }
  obj(v: unknown, field: string): Obj {
    return isObj(v) ? v : this.fail(field);
  }
  /** A whole number of cents (may be negative: refunds can exceed sales). */
  cents(v: unknown, field: string): number {
    return typeof v === "number" && Number.isSafeInteger(v)
      ? v
      : this.fail(field);
  }
  centsOrNull(v: unknown, field: string): number | null {
    return v === null || v === undefined ? null : this.cents(v, field);
  }
  count(v: unknown, field: string): number {
    return typeof v === "number" && Number.isSafeInteger(v) && v >= 0
      ? v
      : this.fail(field);
  }
  pctOrNull(v: unknown, field: string): number | null {
    if (v === null || v === undefined) return null;
    return typeof v === "number" && Number.isFinite(v) ? v : this.fail(field);
  }
  str(v: unknown, field: string): string {
    return typeof v === "string" && v.length > 0 ? v : this.fail(field);
  }
  date(v: unknown, field: string): string {
    const s = this.str(v, field);
    return Number.isFinite(Date.parse(s)) ? s : this.fail(field);
  }
  dateOrNull(v: unknown, field: string): string | null {
    return v === null || v === undefined ? null : this.date(v, field);
  }
  currency(v: unknown, field: string): string {
    return typeof v === "string" && CURRENCY_RE.test(v)
      ? v.toLowerCase()
      : this.fail(field);
  }
}

/** ISO 4217 shape; the backend sells in usd / gbp / eur / aud / cad. */
const CURRENCY_RE = /^[A-Za-z]{3}$/;

const PAID_BY: readonly ProcessingPaidBy[] = [
  "coach",
  "platform",
  "mixed",
  "none",
];

function toTotals(r: Reader, raw: unknown, at: string): MoneyTotals {
  const t = r.obj(raw, at);
  const by = t.processing_paid_by;
  return {
    grossCents: r.cents(t.gross_cents, `${at}.gross_cents`),
    processingCents: r.cents(t.processing_cents, `${at}.processing_cents`),
    platformFeeCents: r.cents(t.platform_fee_cents, `${at}.platform_fee_cents`),
    headCoachSplitCents: r.cents(
      t.head_coach_split_cents,
      `${at}.head_coach_split_cents`,
    ),
    refundedCents: r.cents(t.refunded_cents, `${at}.refunded_cents`),
    headCoachIncomeCents: r.cents(
      t.head_coach_income_cents,
      `${at}.head_coach_income_cents`,
    ),
    netCents: r.cents(t.net_cents, `${at}.net_cents`),
    chargeCount: r.count(t.charge_count, `${at}.charge_count`),
    processingPaidBy: (PAID_BY as readonly unknown[]).includes(by)
      ? (by as ProcessingPaidBy)
      : r.fail(`${at}.processing_paid_by`),
  };
}

function toWindow(r: Reader, raw: unknown, at: string) {
  const w = r.obj(raw, at);
  const from = r.date(w.from, `${at}.from`);
  const to = r.date(w.to, `${at}.to`);
  if (Date.parse(from) >= Date.parse(to)) r.fail(at);
  return { from, to };
}

/**
 * Exported for tests. `expect` (optional) is what the app asked for: the
 * response must be for exactly that window and currency, so an answer for
 * another period can never be shown under this period's name (B-332-1).
 */
export function toSummary(
  raw: unknown,
  expect?: { window?: { from: Date; to: Date }; currency?: string | null },
  headers?: unknown,
): MoneySummary {
  const r: Reader = new Reader("summary", headers);
  const s = r.obj(raw, "summary");
  const currency = r.currency(s.currency, "currency");
  const currencies = Array.isArray(s.currencies)
    ? s.currencies.map((c, i) => r.currency(c, `currencies[${i}]`))
    : s.currencies === undefined
      ? [currency]
      : r.fail("currencies");
  const window = toWindow(r, s.window, "window");
  const compare =
    s.compare === null || s.compare === undefined
      ? null
      : toWindow(r, s.compare, "compare");
  const totals = toTotals(r, s.totals, "totals");
  const compareTotals =
    s.compare_totals === null || s.compare_totals === undefined
      ? null
      : toTotals(r, s.compare_totals, "compare_totals");
  const changeCents = r.centsOrNull(s.change_cents, "change_cents");
  const changePct = r.pctOrNull(s.change_pct, "change_pct");
  // Coherence: a change needs a comparison, and it must be the difference.
  if (compareTotals === null && changeCents !== null) r.fail("change_cents");
  if (
    compareTotals !== null &&
    changeCents !== null &&
    changeCents !== totals.netCents - compareTotals.netCents
  )
    r.fail("change_cents");
  if (expect?.window) {
    if (
      Date.parse(window.from) !== expect.window.from.getTime() ||
      Date.parse(window.to) !== expect.window.to.getTime()
    )
      r.fail("window");
  }
  if (expect?.currency && expect.currency !== currency) r.fail("currency");
  const rec = r.obj(s.recurring, "recurring");
  return {
    currency,
    currencies: currencies.includes(currency)
      ? currencies
      : [...currencies, currency].sort(),
    window,
    compare,
    totals,
    compareTotals,
    changeCents,
    changePct,
    recurring: {
      mrrCents: r.cents(rec.mrr_cents, "recurring.mrr_cents"),
      payingClients: r.count(rec.paying_clients, "recurring.paying_clients"),
      churned30d: r.count(rec.churned_30d, "recurring.churned_30d"),
      newClients30d: r.count(rec.new_clients_30d, "recurring.new_clients_30d"),
    },
    attentionCount: r.count(s.attention_count, "attention_count"),
    // #641 C-641-3 names exactly one field; null = not recorded on this server.
    heldFromNextSaleCents: r.centsOrNull(
      s.held_from_next_sale_cents,
      "held_from_next_sale_cents",
    ),
    generatedAt: r.date(s.generated_at, "generated_at"),
  };
}

/**
 * An error response whose body is still JSON text (a text-mode request)
 * gets its parsed object back in place, so code-based copy can read it.
 * A non-JSON body is left as it is.
 */
export function parseJsonErrorBody(err: unknown): void {
  const response = (err as { response?: { data?: unknown } } | null)?.response;
  if (!response || typeof response.data !== "string") return;
  const text = response.data.replace(/^\uFEFF/, "").trim();
  if (!text.startsWith("{")) return;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") response.data = parsed;
  } catch {
    // Not JSON after all: the generic reader keeps the reference path.
  }
}

const INTERVALS: readonly BillingUnit[] = ["week", "month", "year"];

function readCharge(r: Reader, raw: unknown, at: string): MoneyCharge {
  const c = r.obj(raw, at);
  const client = r.obj(c.client, `${at}.client`);
  const pkg = r.obj(c.package, `${at}.package`);
  const rawState = r.str(c.state, `${at}.state`);
  const billingType =
    c.billing_type === "recurring" || c.billing_type === "one_time"
      ? c.billing_type
      : r.fail(`${at}.billing_type`);
  const unit = c.billing_interval;
  const billingInterval =
    unit === null || unit === undefined
      ? null
      : (INTERVALS as readonly unknown[]).includes(unit)
        ? (unit as BillingUnit)
        : null; // a cadence this build does not know reads as "Recurring"
  // B-332-2 (R2): a missing, null, malformed or non-positive count is an
  // unknown cadence ("Recurring"); a count is never guessed.
  const count = c.billing_interval_count;
  const countKnown =
    typeof count === "number" && Number.isSafeInteger(count) && count >= 1;
  const billingIntervalCount =
    billingInterval === null || !countKnown ? null : (count as number);
  return {
    id: r.str(c.id, `${at}.id`),
    client: {
      id: typeof client.id === "string" ? client.id : "",
      name: strOrNull(client.name) ?? "Client",
    },
    packageName: typeof pkg.name === "string" ? pkg.name : "",
    amountCents: r.cents(c.amount_cents, `${at}.amount_cents`),
    currency: r.currency(c.currency, `${at}.currency`),
    billingType,
    billingInterval:
      billingType === "recurring" && billingIntervalCount !== null
        ? billingInterval
        : null,
    billingIntervalCount:
      billingType === "recurring" ? billingIntervalCount : null,
    state: (CHARGE_STATES as readonly string[]).includes(rawState)
      ? (rawState as ChargeState)
      : null,
    rawState,
    refundedCents: r.cents(c.refunded_cents, `${at}.refunded_cents`),
    chargedBackCents:
      c.charged_back_cents === undefined
        ? 0
        : r.cents(c.charged_back_cents, `${at}.charged_back_cents`),
    createdAt: r.date(c.created_at, `${at}.created_at`),
    movedAwayAt: r.dateOrNull(c.moved_away_at, `${at}.moved_away_at`),
  };
}

/** Exported for tests. */
export function toCharge(raw: unknown, headers?: unknown): MoneyCharge {
  return readCharge(new Reader("charge", headers), raw, "charge");
}

const KINDS: readonly AttentionKind[] = [
  "failed_payment",
  "dispute",
  "stripe_requirements",
];

function strings(r: Reader, v: unknown, at: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) r.fail(at);
  return v.map((x, i) => (typeof x === "string" ? x : r.fail(`${at}[${i}]`)));
}

/** Exported for tests. Unknown kinds return null (skipped, never guessed). */
export function toAttentionItem(
  raw: unknown,
  index = 0,
  headers?: unknown,
): AttentionItem | null {
  const r: Reader = new Reader("attention", headers);
  const at = `items[${index}]`;
  const a = r.obj(raw, at);
  if (!(KINDS as readonly unknown[]).includes(a.kind)) return null;
  const kind = a.kind as AttentionKind;
  const client =
    a.client === null || a.client === undefined
      ? null
      : r.obj(a.client, `${at}.client`);
  const amountCents = r.centsOrNull(a.amount_cents, `${at}.amount_cents`);
  const currency =
    a.currency === null || a.currency === undefined
      ? null
      : r.currency(a.currency, `${at}.currency`);
  // An amount without its currency would be shown in the wrong money.
  if (amountCents !== null && currency === null) r.fail(`${at}.currency`);
  const fp =
    kind === "failed_payment"
      ? r.obj(a.failed_payment, `${at}.failed_payment`)
      : null;
  const d = kind === "dispute" ? r.obj(a.dispute, `${at}.dispute`) : null;
  const sr =
    kind === "stripe_requirements"
      ? r.obj(a.stripe_requirements, `${at}.stripe_requirements`)
      : null;
  return {
    kind,
    id: r.str(a.id, `${at}.id`),
    client:
      client && typeof client.id === "string" && client.id
        ? { id: client.id, name: strOrNull(client.name) ?? "Client" }
        : null,
    amountCents,
    currency,
    createdAt: r.dateOrNull(a.created_at, `${at}.created_at`),
    failedPayment: fp
      ? {
          packageName:
            typeof fp.package_name === "string" ? fp.package_name : "",
          attempt: r.count(fp.attempt, `${at}.failed_payment.attempt`),
          maxAttempts: r.count(
            fp.max_attempts,
            `${at}.failed_payment.max_attempts`,
          ),
          nextRetryAt: r.dateOrNull(
            fp.next_retry_at,
            `${at}.failed_payment.next_retry_at`,
          ),
          lockedOutAt: r.dateOrNull(
            fp.locked_out_at,
            `${at}.failed_payment.locked_out_at`,
          ),
          cardUpdateLinkSentAt: r.dateOrNull(
            fp.card_update_link_sent_at,
            `${at}.failed_payment.card_update_link_sent_at`,
          ),
          lastFailureReason: strOrNull(fp.last_failure_reason),
        }
      : null,
    dispute: d
      ? {
          status: r.str(d.status, `${at}.dispute.status`),
          reason: strOrNull(d.reason),
          evidenceDueBy: r.dateOrNull(
            d.evidence_due_by,
            `${at}.dispute.evidence_due_by`,
          ),
        }
      : null,
    stripeRequirements: sr
      ? {
          currentlyDue: strings(r, sr.currently_due, `${at}.currently_due`),
          pastDue: strings(r, sr.past_due, `${at}.past_due`),
          currentDeadline: r.dateOrNull(
            sr.current_deadline,
            `${at}.current_deadline`,
          ),
          disabledReason: strOrNull(sr.disabled_reason),
        }
      : null,
  };
}

const PAYOUT_STATUSES: readonly KnownPayoutStatus[] = [
  "pending",
  "in_transit",
  "paid",
  "failed",
  "canceled",
];

/**
 * /coach/connect/payouts returns major units; convert to cents. A status
 * this build does not know is `unknown` (C-332-3): it is listed under its
 * own label and never offered as the next payout.
 */
export function toPayout(
  raw: unknown,
  index = 0,
  headers?: unknown,
): MoneyPayout {
  const r: Reader = new Reader("payouts", headers);
  const at = `[${index}]`;
  const p = r.obj(raw, at);
  const amount = p.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount))
    r.fail(`${at}.amount`);
  const rawStatus = typeof p.status === "string" ? p.status : "";
  const status: PayoutStatus = (PAYOUT_STATUSES as readonly string[]).includes(
    rawStatus,
  )
    ? (rawStatus as KnownPayoutStatus)
    : "unknown";
  // B-332-3 (R2): the converted amount must be a safe integer number of
  // cents that the major-unit value states exactly (at most two decimals).
  const major = amount as number;
  const amountCents = Math.round(major * 100);
  // C-332-7 (Sol): exact, not a relative tolerance. A value with at most two
  // decimals parses to the same double as its cents / 100 (both are the
  // nearest double to the same decimal), so 94.8 passes and 10000.005 fails.
  if (!Number.isSafeInteger(amountCents) || amountCents / 100 !== major)
    r.fail(`${at}.amount`);
  const arrival = strOrNull(p.arrival_date);
  return {
    id: r.str(p.id, `${at}.id`),
    amountCents,
    currency: r.currency(p.currency, `${at}.currency`),
    status,
    rawStatus,
    // The snapshot fallback sends the epoch when it has no date.
    arrivalDate: arrival && Date.parse(arrival) > 0 ? arrival : null,
    failureMessage: status === "failed" ? strOrNull(p.description) : null,
  };
}

/**
 * The next payout: the soonest pending or in-transit payout. Stripe lists
 * pending payouts too, so this is Stripe's own figure. Exported for tests.
 */
export function nextPayout(payouts: MoneyPayout[]): MoneyPayout | null {
  const open = payouts.filter(
    (p) => p.status === "pending" || p.status === "in_transit",
  );
  open.sort(
    (a, b) =>
      (a.arrivalDate ? Date.parse(a.arrivalDate) : Infinity) -
      (b.arrivalDate ? Date.parse(b.arrivalDate) : Infinity),
  );
  return open[0] ?? null;
}

// ─── windows (device computes calendar windows in the coach's time zone) ───

export interface MoneyWindows {
  from: Date;
  to: Date;
  compareFrom: Date;
  compareTo: Date;
}

/**
 * Today = local midnight to now, compared with yesterday over the same
 * hours. 30d / 90d = the last N days, compared with the N days before.
 * YTD = 1 January to now, compared with the same span last year.
 * Exported for tests.
 */
export function windowsFor(range: MoneyRange, now: Date): MoneyWindows {
  const to = new Date(now.getTime());
  if (range === "today") {
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const span = to.getTime() - from.getTime();
    const compareFrom = new Date(from.getTime() - 86_400_000);
    return {
      from,
      to,
      compareFrom,
      compareTo: new Date(compareFrom.getTime() + Math.max(span, 1)),
    };
  }
  if (range === "ytd") {
    const from = new Date(now.getFullYear(), 0, 1);
    const compareFrom = new Date(now.getFullYear() - 1, 0, 1);
    const compareTo = new Date(
      now.getFullYear() - 1,
      now.getMonth(),
      now.getDate(),
      now.getHours(),
      now.getMinutes(),
      now.getSeconds(),
    );
    return { from, to, compareFrom, compareTo };
  }
  const days = range === "30d" ? 30 : 90;
  const from = new Date(to.getTime() - days * 86_400_000);
  return {
    from,
    to,
    compareFrom: new Date(from.getTime() - days * 86_400_000),
    compareTo: from,
  };
}

// ─── API ───────────────────────────────────────────────────────────────────

export interface MoneySummaryRequest {
  /** null = the server's default currency (USD when the coach has any). */
  currency?: string | null;
  now?: Date;
}

const headersOf = (res: unknown): unknown =>
  (res as { headers?: unknown } | null)?.headers;

export const coachMoneyApi = {
  async summary(
    range: MoneyRange,
    opts: MoneySummaryRequest = {},
  ): Promise<MoneySummary> {
    const w = windowsFor(range, opts.now ?? new Date());
    const res = await api.get("/v1/coach/money/summary", {
      params: {
        from: w.from.toISOString(),
        to: w.to.toISOString(),
        compare_from: w.compareFrom.toISOString(),
        compare_to: w.compareTo.toISOString(),
        ...(opts.currency ? { currency: opts.currency } : {}),
      },
    });
    return toSummary(
      res.data,
      { window: { from: w.from, to: w.to }, currency: opts.currency ?? null },
      headersOf(res),
    );
  },

  async charges(
    filter: ChargeFilter,
    opts: { cursor?: string | null; limit?: number } = {},
  ): Promise<MoneyChargesPage> {
    const res = await api.get("/v1/coach/money/charges", {
      params: {
        status: filter,
        limit: opts.limit ?? 20,
        ...(opts.cursor ? { cursor: opts.cursor } : {}),
      },
    });
    const r: Reader = new Reader("charges", headersOf(res));
    const d = r.obj(res.data, "charges");
    if (!Array.isArray(d.charges)) r.fail("charges");
    const nc = d.next_cursor;
    if (!(nc === null || nc === undefined || typeof nc === "string"))
      r.fail("next_cursor");
    return {
      charges: d.charges.map((c, i) => readCharge(r, c, `charges[${i}]`)),
      nextCursor: strOrNull(nc),
    };
  },

  async charge(id: string): Promise<MoneyChargeBreakdown> {
    const res = await api.get(
      `/v1/coach/money/charges/${encodeURIComponent(id)}`,
    );
    const r: Reader = new Reader("charge", headersOf(res));
    const d = r.obj(res.data, "charge");
    const charge = readCharge(r, d.charge, "charge");
    const b = r.obj(d.breakdown, "breakdown");
    const by = b.processing_paid_by;
    if (typeof b.settled !== "boolean") r.fail("breakdown.settled");
    return {
      charge,
      priceCents: r.cents(b.price_cents, "breakdown.price_cents"),
      processingCents: r.cents(
        b.processing_cents,
        "breakdown.processing_cents",
      ),
      platformFeeCents: r.cents(
        b.platform_fee_cents,
        "breakdown.platform_fee_cents",
      ),
      headCoachSplitCents: r.cents(
        b.head_coach_split_cents,
        "breakdown.head_coach_split_cents",
      ),
      refundedCents: r.cents(b.refunded_cents, "breakdown.refunded_cents"),
      netCents: r.cents(b.net_cents, "breakdown.net_cents"),
      processingPaidBy: (PAID_BY as readonly unknown[]).includes(by)
        ? (by as ProcessingPaidBy)
        : r.fail("breakdown.processing_paid_by"),
      settled: b.settled,
    };
  },

  async attention(): Promise<MoneyAttention> {
    const res = await api.get("/v1/coach/money/attention");
    const r: Reader = new Reader("attention", headersOf(res));
    const d = r.obj(res.data, "attention");
    if (!Array.isArray(d.items)) r.fail("items");
    const count = r.count(d.count, "count");
    const items = d.items
      .map((x, i) => toAttentionItem(x, i, headersOf(res)))
      .filter((i): i is AttentionItem => i !== null);
    return { count: Math.max(count, items.length), items };
  },

  async payouts(limit = 10): Promise<MoneyPayout[]> {
    const res = await api.get("/coach/connect/payouts", {
      params: { limit },
    });
    if (!Array.isArray(res.data))
      new Reader("payouts", headersOf(res)).fail("payouts");
    return (res.data as unknown[]).map((p, i) =>
      toPayout(p, i, headersOf(res)),
    );
  },

  async roster(): Promise<RosterMetrics> {
    const res = await api.get("/coach/connect/metrics");
    const r: Reader = new Reader("metrics", headersOf(res));
    const m = r.obj(res.data, "metrics");
    return {
      rosterClients: r.count(m.active_clients, "active_clients"),
      joined30d: r.count(m.clients_added_30d, "clients_added_30d"),
      team: {
        acquired30d: r.count(
          m.sub_coach_acquisition_30d ?? 0,
          "sub_coach_acquisition_30d",
        ),
        churned30d: r.count(m.sub_coach_churn_30d ?? 0, "sub_coach_churn_30d"),
      },
    };
  },

  /** Stripe Express dashboard (Payout settings). */
  async dashboardLink(): Promise<string> {
    const res = await api.post("/v1/connect/accounts/dashboard-link");
    const url = obj(res.data).url;
    if (typeof url !== "string" || !url)
      new Reader("dashboard link", headersOf(res)).fail("url");
    return url as string;
  },

  /**
   * C-332-4 / C-641-4 — "Export CSV for taxes": sales, refunds and
   * chargebacks in [from, to) for one currency, as the server's CSV text
   * (the net_to_you column sums to the summary's net for the same window).
   */
  async exportCsv(
    window: { from: Date; to: Date },
    currency: string | null,
  ): Promise<{ csv: string; filename: string }> {
    // B-332-4 (Opus): the text transform also applies to error bodies, so
    // a 400 arrives as a JSON string. Parse it back so the server's code
    // (MONEY_EXPORT_TOO_LARGE, MONEY_WINDOW_INVALID, ...) reaches its copy.
    const res = await api
      .get("/v1/coach/money/export.csv", {
        params: {
          from: window.from.toISOString(),
          to: window.to.toISOString(),
          ...(currency ? { currency } : {}),
        },
        responseType: "text",
        transformResponse: (body: unknown) => body,
      })
      .catch((err: unknown) => {
        parseJsonErrorBody(err);
        throw err;
      });
    const csv =
      typeof res.data === "string" ? res.data.replace(/^\uFEFF/, "") : null;
    if (csv === null || !csv.startsWith("date_utc,"))
      new Reader("export", headersOf(res)).fail("csv");
    const disposition = String(
      (headersOf(res) as Record<string, unknown> | undefined)?.[
        "content-disposition"
      ] ?? "",
    );
    const named = /filename="([^"]+)"/.exec(disposition)?.[1];
    const day = (d: Date) => d.toISOString().slice(0, 10);
    return {
      csv: csv as string,
      filename:
        named ??
        `tgp-money-${day(window.from)}-to-${day(window.to)}${
          currency ? `-${currency}` : ""
        }.csv`,
    };
  },
};
