/**
 * TRIAL-FU-BE F1 (LO-1193 C1) and FR-1201 (LS-1201 B1) — the one zone every
 * trial-end, first-charge and next-charge date a storefront page prints is
 * in: the pay page, the return page (/done) and the hosted-checkout
 * thank-you page. Owner: "189-S2 - v1.1 (all my clients at launch will be
 * PDT)": 189-S2 swaps the zone here, in one place. Never the server's zone
 * (UTC): a buyer whose charge falls after 5 pm PDT (4 pm PST) was told a day
 * late.
 */
export const BUYER_TIME_ZONE = 'America/Los_Angeles';

const STYLES: Record<'short' | 'medium' | 'long', Intl.DateTimeFormatOptions> = {
  short: { month: 'short', day: 'numeric' },
  medium: { month: 'short', day: 'numeric', year: 'numeric' },
  long: { month: 'long', day: 'numeric', year: 'numeric' },
};

/**
 * A charge or trial-end instant as the buyer's calendar day:
 * short 'Nov 6', medium 'Nov 6, 2026', long 'November 6, 2026'.
 */
export function buyerChargeDay(at: string | Date, style: 'short' | 'medium' | 'long'): string {
  return new Intl.DateTimeFormat('en-US', { ...STYLES[style], timeZone: BUYER_TIME_ZONE }).format(new Date(at));
}
