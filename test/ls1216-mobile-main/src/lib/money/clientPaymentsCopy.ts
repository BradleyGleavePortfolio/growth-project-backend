/**
 * COACH-PAY-M-130: plain-words copy for a coach's payments of one client.
 * Every line states what the backend reported or what the action really
 * does (CF-COACH-PAY-BE-128 rules):
 * - a refund that covers the whole payment ends the client's access to the
 *   plan, and pauses a live recurring plan's billing until it is restarted;
 * - pause charges nothing while paused and the client keeps access; resume
 *   bills again from the next renewal;
 * - cancel stops billing at the end of the paid period (access until then),
 *   or ends the plan now when its latest payment failed or it was paused by a
 *   full refund or a bank dispute.
 */
import type { ClientPayment, ClientPlan } from "../../api/coachClientPaymentsApi";
import { MoneyPayloadError } from "../../api/coachMoneyApi";
import { currencyMinorUnits } from "../../utils/currency";
import { describeError } from "../coachSetup/errors";
import { money, shortDate } from "./moneyCopy";

export type PlanChange = "pause" | "resume" | "cancel";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const who = (name: string) => name.trim() || "the client";
const IN_FLIGHT = new Set(["pending", "requires_action"]);
const sum = (p: ClientPayment, pick: (status: string) => boolean) =>
  p.refunds.filter((r) => pick(r.status)).reduce((n, r) => n + r.amountCents, 0);

export function priceLine(p: ClientPlan): string {
  return `${money(p.amountCents, p.currency)}, ${p.billingType === "recurring" ? "recurring" : "one time"}`;
}

export function planStateLine(p: ClientPlan, name: string): string {
  const until = shortDate(p.currentPeriodEnd ?? p.accessExpiresAt);
  const live = p.billing === "running" || p.billing === "paused";
  if (live && p.cancelAtPeriodEnd) {
    return `Canceled. ${cap(who(name))} keeps access until ${until ?? "the end of the paid period"}, and nothing more is charged.`;
  }
  switch (p.billing) {
    case "one_time":
      return p.status === "refunded"
        ? "Refunded in full, so access to this plan has ended."
        : "Paid once. Nothing more is charged.";
    case "paused":
      return `Billing is paused. Nothing is charged while it is paused, and ${who(name)} keeps access.`;
    case "paused_by_refund_or_dispute":
      return `Billing is paused after ${p.status === "refunded" ? "a full refund" : "a bank dispute or inquiry"}, and access to this plan has ended until the plan is restarted.`;
    case "ended":
      return p.status === "refunded"
        ? "Refunded in full. This plan has ended."
        : "This plan has ended. Nothing more is charged.";
    case "unknown":
      return "The billing state could not be read just now. Pull down to refresh.";
    case "running":
      if (p.status === "past_due" || p.status === "unpaid") {
        return "The latest payment did not go through, so billing cannot be paused. Cancel plan ends the plan now.";
      }
      if (p.status === "trialing") return until ? `In a free trial until ${until}.` : "In a free trial.";
      return until ? `Billing is on. The next payment is due ${until}.` : "Billing is on.";
  }
}

export function paymentLine(p: ClientPayment): string {
  const parts = [`Paid ${shortDate(p.paidAt) ?? ""}`.trim()];
  if (p.amountCents > 0 && p.refundedCents >= p.amountCents) parts.push("Refunded in full");
  else if (p.refundedCents > 0) parts.push(`${money(p.refundedCents, p.currency)} refunded`);
  const moving = sum(p, (s) => IN_FLIGHT.has(s));
  if (moving > 0) parts.push(`${money(moving, p.currency)} refund in progress`);
  const failed = sum(p, (s) => s === "failed" || s === "canceled");
  if (failed > 0) parts.push(`${money(failed, p.currency)} refund did not go through`);
  return `${parts.join(". ")}.`;
}

/**
 * What refunding `cents` of this payment does, said before the tap. Refunding
 * all of any payment, an earlier month included, ends access (owner decision
 * 7, refund-dispute-handler coversCharge -> revokeFullyRefunded), so that
 * case is said plainly and `endsAccess` puts it on the button too.
 */
export function refundConsequence(
  plan: ClientPlan,
  p: ClientPayment,
  cents: number,
  name: string,
): { text: string; endsAccess: boolean } {
  const live = plan.billing === "running" || plan.billing === "paused";
  // B-545-1: when the billing read failed, a refund of all of a payment still
  // ends access, so say that, with no claim about billing either way.
  const unread = plan.billing === "unknown";
  if (!live && !unread && plan.billing !== "one_time") {
    return { text: "Access and billing on this plan stay as they are.", endsAccess: false };
  }
  const before = p.refundedCents + sum(p, (s) => IN_FLIGHT.has(s));
  if (before + cents < p.amountCents) {
    if (unread) {
      return { text: `A partial refund leaves ${who(name)}'s access to ${plan.packageName} as it is.`, endsAccess: false };
    }
    const keeps = live ? "keeps access, and billing carries on as before" : `keeps access to ${plan.packageName}`;
    return { text: `${cap(who(name))} ${keeps}.`, endsAccess: false };
  }
  const ends = `ends ${who(name)}'s access to ${plan.packageName}${live ? " and pauses its billing until the plan is restarted" : ""}`;
  const part = before > 0 ? "the rest" : "all";
  const earlier = plan.payments.some((o) => Date.parse(o.paidAt) > Date.parse(p.paidAt));
  return {
    text: earlier
      ? `This is an earlier payment, but refunding ${part} of it still ${ends}.`
      : `Refunding ${part} of this payment ${ends}.`,
    endsAccess: true,
  };
}

export function refundDone(status: string, cents: number, currency: string, name: string): string {
  const amount = money(cents, currency);
  if (status === "succeeded") return `Refunded ${amount}. It goes back to the card ${who(name)} paid with.`;
  if (status === "failed" || status === "canceled") {
    return `The refund of ${amount} did not go through, so no money was returned.`;
  }
  return `Refund of ${amount} started. It shows as in progress on this payment until it goes through.`;
}

export function confirmCopy(
  change: PlanChange,
  plan: ClientPlan,
  name: string,
): { title: string; body: string; confirm: string; keep: string } {
  if (change === "pause") {
    return {
      title: "Pause billing?",
      body: `Nothing is charged while billing is paused, and ${who(name)} keeps access to ${plan.packageName}. When billing resumes, the next payment is taken at the next renewal.`,
      confirm: "Pause billing",
      keep: "Not now",
    };
  }
  if (change === "resume") {
    return {
      title: "Resume billing?",
      body: `Billing starts again at ${who(name)}'s next renewal. Nothing is charged for the time it was paused.`,
      confirm: "Resume billing",
      keep: "Not now",
    };
  }
  const until = shortDate(plan.currentPeriodEnd);
  const failed = plan.status === "past_due" || plan.status === "unpaid";
  const body =
    failed || plan.billing === "paused_by_refund_or_dispute"
      ? `The plan ends now and unpaid invoices are voided, so nothing more is charged.${failed ? ` ${cap(who(name))}'s access to ${plan.packageName} ends.` : ""}`
      : `Billing stops at the end of the current period${until ? `, on ${until}` : ""}. ${cap(who(name))} keeps access until then and is not charged again.`;
  return { title: "Cancel this plan?", body, confirm: "Cancel plan", keep: "Keep plan" };
}

export function changeDone(change: PlanChange, plan: ClientPlan, message: string | null): string {
  if (change === "pause") return `Billing paused for ${plan.packageName}.`;
  if (change === "resume") {
    return `Billing resumed for ${plan.packageName}. The next payment is taken at the next renewal.`;
  }
  return message ?? planStateLine(plan, "");
}

/** Backend codes whose `message` is written for coaches (CF-COACH-PAY-BE-128). */
const SERVER_COPY = new Set([
  "PLAN_NOT_FOUND",
  "PAYMENT_NOT_FOUND",
  "REFUND_AMOUNT_TOO_LARGE",
  "PLAN_PAUSED_BY_REFUND_OR_DISPUTE",
  "PLAN_PAYMENT_FAILED",
  "ACTION_NOT_AVAILABLE",
  "STRIPE_REFUSED",
  "PAYMENT_ACTION_UNCONFIRMED",
]);

/** One specific sentence for a failed action; `what` completes "TGP could not ...". */
export function actionFailure(err: unknown, what: string): string {
  const response = (err as { response?: { data?: unknown } } | null)?.response;
  const unknown = !response
    ? "No answer came back"
    : err instanceof MoneyPayloadError
      ? "The answer could not be checked"
      : null;
  if (unknown || !response) {
    return `${unknown}, so it is not known whether TGP could ${what}. Pull down to refresh before trying again: anything that went through shows on this plan.`;
  }
  const d = response.data && typeof response.data === "object" ? (response.data as Record<string, unknown>) : {};
  const code = typeof d.code === "string" ? d.code : null;
  if (code && SERVER_COPY.has(code) && typeof d.message === "string" && d.message) return d.message;
  const f = describeError(err, what);
  return `${f.title}. ${f.body}`;
}

/** Minor units as an editable amount, e.g. 3500 usd -> "35.00". */
export function amountText(cents: number, currency: string): string {
  const { exponent } = currencyMinorUnits(currency);
  return exponent === 0 ? String(cents) : (cents / 10 ** exponent).toFixed(exponent);
}

/** "35", "35.5" or "35.50" -> minor units; null when it is not an amount. */
export function parseAmount(text: string, currency: string): number | null {
  const { exponent } = currencyMinorUnits(currency);
  const m = /^(\d{1,7})(?:[.,](\d*))?$/.exec(text.trim());
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.length > exponent) return null;
  return Number(m[1]) * 10 ** exponent + Number(frac.padEnd(exponent, "0") || "0");
}
