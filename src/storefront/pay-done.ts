import { timingSafeEqual } from 'crypto';
import type { PrismaService } from '../prisma.service';
import type { StripeConnectApiService } from '../connect/stripe-connect-api.service';
import { SHARE_TOKEN_REGEX } from '../share-link/share-link.service';
import { payKeyTag, type PayDoneView } from './pay-done.html';
import { payPageUrl } from './storefront-links';

// GC-2 — read-only: which state /p/:token/done shows. Stripe's query alone is
// never trusted: the PaymentIntent must belong to a guest checkout of this
// token's package, the client secret Stripe appended must equal the intent's
// own, and the state comes from Stripe's copy of the intent. Nothing is
// created, claimed, converted or charged here; the webhook and the lost-webhook
// reconciler stay the only writers. No sale-readiness gates: a buyer who paid
// still sees the result if the coach stops selling the package afterwards.
// FR-1155: a paid payment later refunded or disputed never says "Payment
// received" (B1); an expired checkout nobody paid for opens nothing (B3); a
// failed or cancelled return lets the pay page start a fresh attempt (B2).
// FR-1155R3 (agent 174): that money state comes from this payment's own charge
// and its dispute row, never from a status kept for access (see moneyState).

const PI_ID = /^pi_[A-Za-z0-9]{8,64}$/;
const LANDING_PAGE_ID = /^[a-z0-9]{20,40}$/i;
/** Not paid for: the claim refuses these once expires_at passes (guest-checkout.service.ts). */
const UNCLAIMED = new Set(['pending', 'failed']);
/** Stripe dispute outcomes that leave the money with the coach (won, a closed inquiry, prevented). */
const DISPUTE_KEPT = new Set(['won', 'warning_closed', 'prevented']);
/** Stripe dispute outcomes that sent the money back to the buyer. */
const DISPUTE_RETURNED = new Set(['lost', 'charge_refunded']);
/** Confirming: checks again every 3 s, 5 times (~15 s), then says what to do. */
export const PAY_DONE_REFRESH_SECONDS = 3;
export const PAY_DONE_MAX_CHECKS = 5;

export interface PayDoneQuery {
  payment_intent?: unknown;
  payment_intent_client_secret?: unknown;
  redirect_status?: unknown;
  lp?: unknown;
  n?: unknown;
}

export interface PayDoneDeps {
  db: Pick<PrismaService, 'guestCheckout' | 'user' | 'chargeDispute'>;
  stripe: Pick<StripeConnectApiService, 'retrievePaymentIntent' | 'retrieveCharge'>;
  storefrontBase: string | undefined;
}

export interface PayDoneResult {
  view: PayDoneView;
  /** Relative URL for the Refresh header while the payment is still confirming. */
  refresh: string | null;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function readPayDone(
  deps: PayDoneDeps,
  token: string,
  q: PayDoneQuery,
): Promise<PayDoneResult> {
  const none: PayDoneResult = { view: { kind: 'unknown' }, refresh: null };
  const piId = str(q.payment_intent);
  const secret = str(q.payment_intent_client_secret);
  if (!SHARE_TOKEN_REGEX.test(token) || !PI_ID.test(piId) || !secret.startsWith(`${piId}_secret_`)) {
    return none;
  }
  const row = await deps.db.guestCheckout.findUnique({
    where: { stripe_payment_intent_id: piId },
    select: {
      guest_email: true,
      created_at: true,
      status: true,
      expires_at: true,
      idempotency_key: true,
      package: { select: { share_token: true, name: true, coach: { select: { name: true } } } },
    },
  });
  if (!row || row.package.share_token !== token) return none;
  // B3 — the link of an expired checkout nobody paid for: the same 404, before Stripe.
  if (UNCLAIMED.has(row.status) && !(row.expires_at.getTime() > Date.now())) return none;

  let pi: Awaited<ReturnType<PayDoneDeps['stripe']['retrievePaymentIntent']>>;
  try {
    pi = await deps.stripe.retrievePaymentIntent(piId);
  } catch {
    return { view: { kind: 'unavailable' }, refresh: null };
  }
  if (pi.id !== piId || typeof pi.client_secret !== 'string' || !sameSecret(pi.client_secret, secret)) {
    return none;
  }

  const lp = str(q.lp);
  const landing = LANDING_PAGE_ID.test(lp) ? lp : undefined;
  const payUrl = payPageUrl(deps.storefrontBase, token, { lp: landing });
  const status = str(pi.status);

  if (status === 'succeeded') {
    const money = await moneyState(deps, pi.latest_charge);
    if (money === 'unreadable') return { view: { kind: 'unavailable' }, refresh: null };
    if (money === 'refunded') return { view: { kind: 'refunded' }, refresh: null };
    if (money) return { view: { kind: 'disputed', open: money === 'disputed_open' }, refresh: null };
    // Existing buyer: an account with this email from before this checkout.
    // A new buyer's account is made by the conversion, after the row.
    const user = await deps.db.user.findFirst({
      where: { email: { equals: row.guest_email, mode: 'insensitive' } },
      select: { created_at: true },
    });
    return {
      view: {
        kind: 'paid',
        buyer: user && user.created_at < row.created_at ? 'existing' : 'new',
        email: row.guest_email,
        coach: row.package.coach.name.trim() || 'Your Coach',
        packageName: row.package.name,
        amountCents: typeof pi.amount === 'number' ? pi.amount : null,
      },
      refresh: null,
    };
  }
  if (status === 'processing' || status === 'requires_capture') {
    const n = Number.parseInt(str(q.n), 10);
    const done = Number.isFinite(n) && n >= 0 ? Math.min(n, PAY_DONE_MAX_CHECKS) : 0;
    const again = done < PAY_DONE_MAX_CHECKS;
    const at = (k: number) =>
      `/p/${encodeURIComponent(token)}/done?${new URLSearchParams({
        payment_intent: piId,
        payment_intent_client_secret: secret,
        ...(landing ? { lp: landing } : {}),
        n: String(k),
      }).toString()}`;
    return {
      view: { kind: 'confirming', email: row.guest_email, again, checkUrl: at(0) },
      refresh: again ? at(done + 1) : null,
    };
  }
  // B2 — this attempt's key is spent: the page drops it from the pay page's tab
  // storage (only if it is still this attempt's key), so Try again starts afresh.
  const spent = { token, tag: payKeyTag(row.idempotency_key) };
  if (status === 'canceled') return { view: { kind: 'cancelled', payUrl, spent }, refresh: null };
  // requires_payment_method / requires_confirmation / requires_action: not paid.
  const err = pi.last_payment_error as { message?: unknown } | null | undefined;
  const reason = typeof err?.message === 'string' && err.message.trim() ? err.message.trim().slice(0, 300) : null;
  return { view: { kind: 'failed', reason, payUrl, spent }, refresh: null };
}

// B1 / FR-1155R3 (agent 174) — Stripe's intent stays succeeded after a refund
// or a dispute, and the purchase and guest row statuses are kept for access: a
// won dispute on a paused plan stays 'disputed', a coach restart keeps 'active'
// through a lost one, a renewal's refund or dispute moves the whole purchase,
// and an unconverted guest's row is never told a dispute closed. So the money
// state is this payment's: Stripe's copy of the intent's latest charge (fully
// refunded? disputed?) and the ChargeDispute row of that charge, which the
// dispute writers keep for a converted buyer (refund-dispute-handler.service.ts
// upsertDispute / onDisputeClosed). A partial refund and a won dispute leave it
// paid; a lost one sent the money back. With no dispute row, or a closed row
// whose outcome is not known, the page says a dispute was opened, never that
// the bank is still reviewing it.
async function moneyState(
  deps: PayDoneDeps,
  latestCharge: unknown,
): Promise<'refunded' | 'disputed_open' | 'disputed' | 'unreadable' | null> {
  const chargeId = typeof latestCharge === 'string' ? latestCharge : str((latestCharge as { id?: unknown } | null)?.id);
  if (!chargeId) return 'unreadable';
  const [charge, dispute] = await Promise.all([
    deps.stripe.retrieveCharge(chargeId).catch(() => null),
    deps.db.chargeDispute.findFirst({
      where: { stripe_charge_id: chargeId },
      orderBy: { created_at: 'desc' },
      select: { status: true, closed_at: true },
    }),
  ]);
  if (!charge) return 'unreadable';
  if (charge.refunded === true) return 'refunded';
  if (dispute) {
    if (DISPUTE_RETURNED.has(dispute.status)) return 'refunded';
    if (DISPUTE_KEPT.has(dispute.status)) return null;
    return dispute.closed_at ? 'disputed' : 'disputed_open';
  }
  return charge.disputed === true ? 'disputed' : null;
}
