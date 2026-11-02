import type { ConnectAccount } from '@prisma/client';
import type { ConnectService } from './connect.service';

// Audit #3 P1-8 — connected-account readiness gate. The previous build
// only checked `charges_enabled`, but a Stripe Connect account can be
// charges-enabled with `disabled_reason` set or `payouts_enabled` /
// `details_submitted` false, meaning Stripe is collecting fees we
// cannot pay out and may already be deferring the coach's payouts.
// Purchases must only be accepted when the coach can actually be paid:
// every readiness axis must be true.
//
// HOLD-FU-BE (LS-1195 C1): the one readiness rule. The share link (public
// GET and guest checkout POST), both client checkout paths (Checkout
// Session and PaymentSheet), the native subscription start and the PF-7
// renewal hold all read this predicate, never `charges_enabled` alone.
export interface ReadinessAccount {
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  disabled_reason: string | null;
}

export function isConnectAccountReadyForCheckout(
  account: ReadinessAccount | null | undefined,
): boolean {
  if (!account) return false;
  if (!account.charges_enabled) return false;
  if (!account.payouts_enabled) return false;
  if (!account.details_submitted) return false;
  if (account.disabled_reason !== null && account.disabled_reason !== undefined) {
    return false;
  }
  return true;
}

// B-GUESTPAY-127 / B-CONNECT-126: account.updated for a coach's Express
// account does not reach the platform webhook, so a saved row that fails the
// predicate above is re-read from Stripe once through b#821's
// ConnectService.refreshNotReady (60 s per-account cooldown; deauthorized
// rows untouched; any failure returns the saved row) before the buyer is
// refused. A ready row makes no Stripe call.
export async function readinessRow(
  row: ConnectAccount,
  connect: ConnectService | undefined,
): Promise<ConnectAccount> {
  if (!connect || isConnectAccountReadyForCheckout(row)) return row;
  return connect.refreshNotReady(row);
}

/** A sale can start: every readiness axis true and the account not deauthorized. */
export function isConnectAccountReadyForSale(account: ConnectAccount): boolean {
  return isConnectAccountReadyForCheckout(account) && !account.deauthorized_at;
}
