// B-RECUR-BE fix round 1 (B-654-1) — the card a native trial saves.
//
// A trial subscription asks for a card through its SetupIntent
// (PaymentSheet setup mode). Stripe documents saving the subscription's
// default card "when a payment succeeds"; a trial's $0 invoice has no
// payment, and once the SetupIntent succeeds the subscription's
// `pending_setup_intent` is null. So the card is never assumed to become
// the default: the server reads the SetupIntent itself (its id is the
// prefix of the stored `seti_<id>_secret_...` client secret) and sets
// `default_payment_method` on the subscription, idempotently. Three callers
// share this: the `setup_intent.succeeded` webhook (primary), the plan read
// while the app shows "Confirming your plan", and the checkout paths that
// would otherwise reuse or retire the attempt.
import type { StripeConnectApiService, StripeSubscriptionCheckoutObject } from '../connect/stripe-connect-api.service';

const SETUP_SECRET_RE = /^(seti_[A-Za-z0-9]+)_secret_/;

/** The SetupIntent id behind a `seti_..._secret_...` client secret, else null. */
export function setupIntentIdOf(secret: string | null | undefined): string | null {
  if (typeof secret !== 'string') return null;
  const m = SETUP_SECRET_RE.exec(secret);
  return m ? m[1] : null;
}

export interface TrialSetupState {
  /** Stripe SetupIntent status (requires_payment_method, succeeded, ...). */
  status: string;
  /** The saved card's PaymentMethod id once succeeded. */
  payment_method: string | null;
}

/**
 * The trial's SetupIntent state. Uses the expanded `pending_setup_intent`
 * while Stripe still returns it, otherwise reads the SetupIntent by id (from
 * the stored client secret). null when there is no SetupIntent to read.
 * Throws on a Stripe error; callers decide whether that blocks.
 */
export async function readTrialSetup(
  stripe: Pick<StripeConnectApiService, 'retrieveSetupIntent'>,
  storedSecret: string | null | undefined,
  sub?: Pick<StripeSubscriptionCheckoutObject, 'pending_setup_intent'> | null,
): Promise<TrialSetupState | null> {
  const pending = sub?.pending_setup_intent;
  if (pending && typeof pending === 'object' && typeof pending.status === 'string') {
    return {
      status: pending.status,
      payment_method: typeof pending.payment_method === 'string' ? pending.payment_method : null,
    };
  }
  const id =
    setupIntentIdOf(storedSecret) ??
    (typeof pending === 'string' ? pending : pending && typeof pending.id === 'string' ? pending.id : null);
  if (!id) return null;
  const si = await stripe.retrieveSetupIntent(id);
  return {
    status: typeof si.status === 'string' ? si.status : 'unknown',
    payment_method: typeof si.payment_method === 'string' ? si.payment_method : null,
  };
}

/** True when the trial's card is saved (the SetupIntent succeeded). */
export function trialCardSaved(state: TrialSetupState | null): state is TrialSetupState & {
  payment_method: string;
} {
  return !!state && state.status === 'succeeded' && typeof state.payment_method === 'string';
}

/**
 * Set the saved card as the subscription's default. Idempotent: the same
 * (subscription, card) always sends the same Stripe Idempotency-Key, so the
 * webhook, the plan read and the checkout paths collapse onto one write.
 * Stripe answers with customer.subscription.updated carrying the default,
 * which is the event that grants the trial.
 */
export async function attachTrialCard(
  stripe: Pick<StripeConnectApiService, 'setSubscriptionDefaultPaymentMethod'>,
  subscriptionId: string,
  paymentMethodId: string,
): Promise<void> {
  await stripe.setSubscriptionDefaultPaymentMethod({
    subscriptionId,
    paymentMethodId,
    idempotencyKey: `tgp-trial-card-${subscriptionId}-${paymentMethodId}`,
  });
}
