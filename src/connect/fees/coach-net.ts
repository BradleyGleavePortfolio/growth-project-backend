// S-FEE — the ONE definition of a coach's reported net, shared by
// GET /v1/coach/payments/earnings (summary) and GET /coach/connect/metrics
// (net_30d) so both surfaces always show the same number.
//
//   net = posted ledger slices (net of reversals) - recoveries owed
//
// Ledger slices are already NET of Stripe's actual processing fee and TGP's
// 2% (they are what was transferred), and refunds / disputes reduce them via
// reversed_cents. A PayeeRecovery is what a reversal could not take back (the
// non-returned processing fee on a full refund, a dispute fee, or a reversal
// Stripe refused); it is netted out of the coach's next payouts, so it is
// subtracted here. Refund totals must NOT be subtracted again (that double
// counts what reversed_cents already removed).
export function coachNetCents(postedCents: number, recoveriesCents: number): number {
  return postedCents - recoveriesCents;
}

// Recoveries that still count against the payee: open (owed) and collected
// (already paid back by netting). Released recoveries were cancelled by a won
// dispute.
export const COUNTED_RECOVERY_STATUSES = ['open', 'collected'] as const;
