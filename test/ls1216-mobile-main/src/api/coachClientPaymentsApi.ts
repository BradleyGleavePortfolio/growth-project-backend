/**
 * COACH-PAY-M-130: a coach's payments for one client, with refund,
 * pause/resume and cancel (backend CF-COACH-PAY-BE-128, behind
 * FEATURE_COACH_PAYMENT_ACTIONS; the app shows the screen only while
 * /me/feature-flags says coach_payment_actions).
 *   GET  /v1/coach/clients/:clientId/payments                       { plans }
 *   POST /v1/coach/clients/:clientId/payments/:purchaseId/refund    { refund, plan }
 *   POST .../:purchaseId/pause | resume                             { plan }
 *   POST .../:purchaseId/cancel                                     { message, plan, ... }
 * Every POST carries the idempotency key of one confirmed tap; a retry of
 * that tap sends the same key. Amounts are integer minor units and are
 * checked: a drifted shape throws MoneyPayloadError (specific copy) instead
 * of showing a believable number.
 */
import api from "../services/api";
import { MoneyPayloadError } from "./coachMoneyApi";

export type PlanBilling =
  | "one_time" | "running" | "paused" | "paused_by_refund_or_dispute" | "ended" | "unknown";
const BILLING: readonly PlanBilling[] = [
  "one_time", "running", "paused", "paused_by_refund_or_dispute", "ended", "unknown",
];

/** status: pending | requires_action | succeeded | failed | canceled */
export interface PaymentRefund { amountCents: number; status: string }

export interface ClientPayment {
  chargeId: string;
  amountCents: number;
  refundedCents: number;
  /** What is left to refund: in-flight refunds and dispute withdrawals already taken off. */
  refundableCents: number;
  currency: string;
  paidAt: string;
  refunds: PaymentRefund[];
}

export interface PlanActions { refund: boolean; pause: boolean; resume: boolean; cancel: boolean; restart: boolean }

export interface ClientPlan {
  purchaseId: string;
  packageName: string;
  billingType: "one_time" | "recurring";
  status: string;
  amountCents: number;
  currency: string;
  currentPeriodEnd: string | null;
  accessExpiresAt: string | null;
  cancelAtPeriodEnd: boolean;
  billing: PlanBilling;
  actions: PlanActions;
  payments: ClientPayment[];
}

type Obj = Record<string, unknown>;

function reader(what: string) {
  const fail = (field: string): never => {
    throw new MoneyPayloadError(what, field);
  };
  const obj = (v: unknown, f: string): Obj =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : fail(f);
  const cents = (v: unknown, f: string): number =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : fail(f);
  const str = (v: unknown, f: string): string =>
    typeof v === "string" && v.length > 0 ? v : fail(f);
  const dateOrNull = (v: unknown, f: string): string | null =>
    v === null || v === undefined
      ? null
      : Number.isFinite(Date.parse(str(v, f)))
        ? (v as string)
        : fail(f);
  const bool = (v: unknown, f: string): boolean =>
    typeof v === "boolean" ? v : fail(f);
  const list = (v: unknown, f: string): unknown[] =>
    Array.isArray(v) ? v : fail(f);
  const currency = (v: unknown, f: string): string =>
    typeof v === "string" && /^[A-Za-z]{3}$/.test(v) ? v.toLowerCase() : fail(f);
  return { fail, obj, cents, str, dateOrNull, bool, list, currency };
}

/** One plan of the list or of an action reply; throws on any drifted field. */
export function toPlan(raw: unknown, at = "plan"): ClientPlan {
  const r = reader("coach client payments");
  const p = r.obj(raw, at);
  const a = r.obj(p.actions, `${at}.actions`);
  const billing = BILLING.find((b) => b === p.billing) ?? r.fail(`${at}.billing`);
  const type = p.billing_type;
  const billingType =
    type === "recurring" || type === "one_time" ? type : r.fail(`${at}.billing_type`);
  return {
    purchaseId: r.str(p.purchase_id, `${at}.purchase_id`),
    packageName: r.str(p.package_name, `${at}.package_name`),
    billingType,
    status: r.str(p.status, `${at}.status`),
    amountCents: r.cents(p.amount_cents, `${at}.amount_cents`),
    currency: r.currency(p.currency, `${at}.currency`),
    currentPeriodEnd: r.dateOrNull(p.current_period_end, `${at}.current_period_end`),
    accessExpiresAt: r.dateOrNull(p.access_expires_at, `${at}.access_expires_at`),
    cancelAtPeriodEnd: r.bool(p.cancel_at_period_end, `${at}.cancel_at_period_end`),
    billing,
    actions: {
      refund: r.bool(a.refund, `${at}.actions.refund`),
      pause: r.bool(a.pause, `${at}.actions.pause`),
      resume: r.bool(a.resume, `${at}.actions.resume`),
      cancel: r.bool(a.cancel, `${at}.actions.cancel`),
      restart: r.bool(a.restart, `${at}.actions.restart`),
    },
    payments: r.list(p.payments, `${at}.payments`).map((raw2, i) => {
      const f = `${at}.payments[${i}]`;
      const pay = r.obj(raw2, f);
      return {
        chargeId: r.str(pay.charge_id, `${f}.charge_id`),
        amountCents: r.cents(pay.amount_cents, `${f}.amount_cents`),
        refundedCents: r.cents(pay.refunded_cents, `${f}.refunded_cents`),
        refundableCents: r.cents(pay.refundable_cents, `${f}.refundable_cents`),
        currency: r.currency(pay.currency, `${f}.currency`),
        paidAt: r.dateOrNull(pay.paid_at, `${f}.paid_at`) ?? r.fail(`${f}.paid_at`),
        refunds: r.list(pay.refunds, `${f}.refunds`).map((raw3, j) => {
          const rf = r.obj(raw3, `${f}.refunds[${j}]`);
          return {
            amountCents: r.cents(rf.amount_cents, `${f}.refunds[${j}].amount_cents`),
            status: r.str(rf.status, `${f}.refunds[${j}].status`),
          };
        }),
      };
    }),
  };
}

const base = (clientId: string) =>
  `/v1/coach/clients/${encodeURIComponent(clientId)}/payments`;
const action = (clientId: string, purchaseId: string, verb: string) =>
  `${base(clientId)}/${encodeURIComponent(purchaseId)}/${verb}`;

export const coachClientPaymentsApi = {
  async list(clientId: string): Promise<ClientPlan[]> {
    const res = await api.get<unknown>(base(clientId));
    const r = reader("coach client payments");
    const body = r.obj(res.data, "body");
    return r.list(body.plans, "plans").map((p, i) => toPlan(p, `plans[${i}]`));
  },

  /** Refund `amountCents` of one payment; replies with the refund status and the plan. */
  async refund(
    clientId: string,
    purchaseId: string,
    input: { chargeId: string; amountCents: number; idempotencyKey: string },
  ): Promise<{ status: string; amountCents: number; plan: ClientPlan }> {
    const res = await api.post<unknown>(action(clientId, purchaseId, "refund"), {
      idempotency_key: input.idempotencyKey,
      charge_id: input.chargeId,
      amount_cents: input.amountCents,
    });
    const r = reader("coach refund");
    const body = r.obj(res.data, "body");
    const refund = r.obj(body.refund, "refund");
    return {
      status: r.str(refund.status, "refund.status"),
      amountCents: r.cents(refund.amount_cents, "refund.amount_cents"),
      plan: toPlan(body.plan),
    };
  },

  /** pause | resume | cancel; `message` is the server's outcome sentence (cancel only). */
  async change(
    clientId: string,
    purchaseId: string,
    verb: "pause" | "resume" | "cancel",
    idempotencyKey: string,
  ): Promise<{ plan: ClientPlan; message: string | null }> {
    const res = await api.post<unknown>(action(clientId, purchaseId, verb), {
      idempotency_key: idempotencyKey,
    });
    const body = reader(`coach ${verb}`).obj(res.data, "body");
    const message = typeof body.message === "string" && body.message ? body.message : null;
    return { plan: toPlan(body.plan), message };
  },
};
