// GC-3 (#GC-TRIAL op 1) — a web trial's sentinel row keeps the trial's
// SetupIntent id in stripe_payment_intent_id (no column added): the card is
// saved and nothing is charged that day, so there is no PaymentIntent. Every
// path that reads that column tells the two apart by this prefix: the guest
// paths (guest-checkout.service.ts) and the money check
// (connect/fees/reconciliation.service.ts, FIX-1225R3). Its own file so the
// money check reads it without loading the guest checkout service.
export function isGuestTrialIntent(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith('seti_');
}
