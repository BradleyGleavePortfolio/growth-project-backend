/**
 * S-COACH-MOB-2 — plain-words copy for TGP Money. Pure functions so every
 * label is testable. No emojis, no exclamation marks.
 */
import type {
  AttentionItem,
  ChargeFilter,
  MoneyCharge,
  MoneyRange,
  MoneyTotals,
  PayoutStatus,
} from "../../api/coachMoneyApi";
import { formatCurrencyCents } from "../../utils/currency";
import { requirementLabels } from "../coachSetup/connectCopy";

export const money = (cents: number, currency = "usd"): string =>
  formatCurrencyCents(cents, currency);

export function shortDate(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** SWITCH-TELL (b#1132): the quiet line on a charge whose client moved to another coach. */
export function movedAwayLine(c: MoneyCharge): string | null {
  const day = shortDate(c.movedAwayAt);
  return day ? `Moved to another coach · ${day}` : null;
}

/** A charge row's spoken label; a moved client's row has no package name. */
export function chargeRowLabel(c: MoneyCharge): string {
  const moved = movedAwayLine(c)?.replace(" · ", ", ");
  return `${[c.client.name, c.packageName, money(c.amountCents, c.currency), chargeStateLabel(c), moved]
    .filter(Boolean)
    .join(", ")}. Open the breakdown`;
}

export const RANGE_LABEL: Record<MoneyRange, string> = {
  today: "Today",
  "30d": "30 days",
  "90d": "90 days",
  ytd: "Year to date",
};

export const RANGE_COMPARE_LABEL: Record<MoneyRange, string> = {
  today: "yesterday",
  "30d": "the 30 days before",
  "90d": "the 90 days before",
  ytd: "the same time last year",
};

export const FILTER_LABEL: Record<ChargeFilter, string> = {
  all: "All",
  paid: "Paid",
  failed: "Failed",
  refunded: "Refunded",
  disputed: "Disputed",
};

/**
 * B-332-2: the cadence a charge bills at, in plain words, from the
 * backend's billing_interval / billing_interval_count. Never assumes
 * "Monthly": a recurring charge with no known cadence says "Recurring".
 */
export function cadenceLabel(
  c: Pick<
    MoneyCharge,
    "billingType" | "billingInterval" | "billingIntervalCount"
  >,
): string {
  if (c.billingType !== "recurring") return "One time";
  // B-332-2 (R2): an unknown count is an unknown cadence, never "Monthly".
  const n = c.billingIntervalCount;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1)
    return "Recurring";
  switch (c.billingInterval) {
    case "week":
      return n === 1 ? "Weekly" : `Every ${n} weeks`;
    case "month":
      if (n === 1) return "Monthly";
      if (n === 3) return "Every 3 months";
      if (n === 12) return "Yearly";
      return `Every ${n} months`;
    case "year":
      return n === 1 ? "Yearly" : `Every ${n} years`;
    default:
      return "Recurring";
  }
}

/** "Up $40.00 on yesterday", "Down 12.5% on the 30 days before". */
export function changeLine(
  range: MoneyRange,
  changeCents: number | null,
  changePct: number | null,
  currency: string,
): string | null {
  if (changeCents === null) return null;
  const vs = RANGE_COMPARE_LABEL[range];
  if (changeCents === 0) return `Same as ${vs}`;
  const dir = changeCents > 0 ? "Up" : "Down";
  const amount = money(Math.abs(changeCents), currency);
  const pct = changePct === null ? "" : ` (${Math.abs(changePct).toFixed(1)}%)`;
  return `${dir} ${amount}${pct} on ${vs}`;
}

export function humanize(raw: string): string {
  const s = raw.replace(/_/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Unknown state";
}

export function chargeStateLabel(c: MoneyCharge): string {
  switch (c.state) {
    case "paid":
      return "Paid";
    case "failed":
      return "Payment failed";
    case "refunded":
      return "Refunded";
    case "partially_refunded":
      return `Partly refunded (${money(c.refundedCents, c.currency)})`;
    case "disputed":
      return "Disputed";
    case "charged_back":
      return c.chargedBackCents > 0
        ? `Charged back (${money(c.chargedBackCents, c.currency)})`
        : "Charged back";
    case "pending":
      // B-348-1 (Sol): pending means no payment has gone through yet (for
      // example a free trial that has not billed), never a payment in flight.
      return "Not paid yet";
    case "canceled":
      return "Checkout not finished";
    default:
      return humanize(c.rawState);
  }
}

/**
 * B-332-10 (Opus): Stripe's decline message is written to the cardholder and
 * already ends in a period. Show it as the bank's words, quoted, without the
 * trailing punctuation, so it never reads "Your card was declined.." as if
 * the coach were the cardholder.
 */
export function bankSaid(reason: string | null | undefined): string | null {
  const text = (reason ?? "").trim().replace(/[\s.!?]+$/u, "");
  return text ? `The bank said: "${text}"` : null;
}

/** True for states that should read as a problem (colour + label). */
export function chargeIsProblem(c: MoneyCharge): boolean {
  return (
    c.state === "failed" ||
    c.state === "disputed" ||
    c.state === "charged_back" ||
    c.state === null
  );
}

export const PAYOUT_LABEL: Record<PayoutStatus, string> = {
  pending: "On the way soon",
  in_transit: "On the way to your bank",
  paid: "In your bank",
  failed: "Payout failed",
  canceled: "Payout canceled",
  unknown: "Status from Stripe not recognised",
};

/** One line per fee row, for the "how this adds up" breakdown. */
export interface BreakdownRow {
  key: string;
  label: string;
  cents: number;
  /** -1 = taken away, +1 = added, 0 = the result. */
  sign: -1 | 0 | 1;
  note?: string;
}

export function breakdownRows(t: {
  priceCents: number;
  processingCents: number;
  platformFeeCents: number;
  headCoachSplitCents: number;
  refundedCents: number;
  headCoachIncomeCents?: number;
  netCents: number;
  processingPaidBy: MoneyTotals["processingPaidBy"];
}): BreakdownRow[] {
  const rows: BreakdownRow[] = [
    { key: "price", label: "Clients paid", cents: t.priceCents, sign: 1 },
    {
      key: "processing",
      label: "Card processing (Stripe)",
      cents: t.processingCents,
      sign: -1,
      note:
        t.processingPaidBy === "platform"
          ? "TGP paid Stripe's processing on these sales."
          : t.processingPaidBy === "mixed"
            ? "TGP paid Stripe's processing on some of these sales."
            : undefined,
    },
    {
      key: "platform",
      label: "TGP fee (2%)",
      cents: t.platformFeeCents,
      sign: -1,
    },
  ];
  // B-332-5: every nonzero contribution is listed with its real direction,
  // so the rows always add up to the net. A refund or chargeback booked in
  // this period on an earlier sale reverses the head-coach share: for the
  // seller the share comes back (added), for the head coach their team
  // income goes down (taken away).
  const split = t.headCoachSplitCents;
  if (split !== 0) {
    rows.push(
      split > 0
        ? {
            key: "head_coach",
            label: "Head coach share",
            cents: split,
            sign: -1,
          }
        : {
            key: "head_coach",
            label: "Head coach share returned on refunds",
            cents: -split,
            sign: 1,
          },
    );
  }
  if (t.refundedCents !== 0) {
    rows.push({
      key: "refunds",
      label: "Refunds and chargebacks",
      cents: Math.abs(t.refundedCents),
      sign: t.refundedCents > 0 ? -1 : 1,
    });
  }
  const team = t.headCoachIncomeCents ?? 0;
  if (team !== 0) {
    rows.push(
      team > 0
        ? {
            key: "team_income",
            label: "Your share of your team's sales",
            cents: team,
            sign: 1,
          }
        : {
            key: "team_income",
            label: "Your share of refunds on your team's sales",
            cents: -team,
            sign: -1,
          },
    );
  }
  rows.push({ key: "net", label: "Net to you", cents: t.netCents, sign: 0 });
  return rows;
}

export interface AttentionCopy {
  title: string;
  lines: string[];
  /** The main action for this item. */
  action: "message_client" | "update_stripe";
  actionLabel: string;
}

function disputeStatus(raw: string): string {
  if (raw === "needs_response" || raw === "warning_needs_response")
    return "Needs a response";
  if (raw === "under_review" || raw === "warning_under_review")
    return "Under review with the bank";
  return humanize(raw);
}

export function attentionCopy(a: AttentionItem): AttentionCopy {
  const who = a.client?.name ?? "A client";
  const amount =
    a.amountCents !== null ? money(a.amountCents, a.currency ?? "usd") : null;
  if (a.kind === "failed_payment" && a.failedPayment) {
    const f = a.failedPayment;
    const lines: string[] = [];
    lines.push(
      [f.packageName, amount].filter(Boolean).join(", ") || "Payment failed",
    );
    if (f.maxAttempts > 0)
      lines.push(`Try ${Math.max(f.attempt, 1)} of ${f.maxAttempts}.`);
    const locked = shortDate(f.lockedOutAt);
    const retry = shortDate(f.nextRetryAt);
    if (locked) lines.push(`Access paused on ${locked}.`);
    else if (retry) lines.push(`TGP tries the card again on ${retry}.`);
    const sent = shortDate(f.cardUpdateLinkSentAt);
    if (sent) lines.push(`TGP emailed them a card update link on ${sent}.`);
    const said = bankSaid(f.lastFailureReason);
    if (said) lines.push(said);
    return {
      title: `${who}'s payment did not go through`,
      lines,
      action: "message_client",
      actionLabel: `Message ${who}`,
    };
  }
  if (a.kind === "dispute" && a.dispute) {
    const d = a.dispute;
    const lines = [
      [amount, disputeStatus(d.status)].filter(Boolean).join(". ") + ".",
    ];
    if (d.reason) lines.push(`Reason given: ${humanize(d.reason)}.`);
    const due = shortDate(d.evidenceDueBy);
    if (due) lines.push(`Evidence is due by ${due}.`);
    return {
      title: `${who} disputed a charge`,
      lines,
      action: "message_client",
      actionLabel: `Message ${who}`,
    };
  }
  const r = a.stripeRequirements;
  const due = requirementLabels([
    ...(r?.pastDue ?? []),
    ...(r?.currentlyDue ?? []),
  ]);
  const lines: string[] = [];
  if (due.length) lines.push(`Stripe asks for: ${due.join(", ")}.`);
  const deadline = shortDate(r?.currentDeadline ?? null);
  if (deadline) lines.push(`Finish by ${deadline} to keep payouts running.`);
  return {
    title: "Stripe needs a few details",
    lines,
    action: "update_stripe",
    actionLabel: "Update details with Stripe",
  };
}
