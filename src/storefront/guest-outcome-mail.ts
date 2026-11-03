// FR-1199 (LS-1199 B1 and B2, LO-1199 C3) — the one email each ending of a
// guest checkout owes its buyer, made durable without a new column:
//   welcome            the row converted (new or existing buyer)
//   trial-refused      a second web trial with the same coach (PF-W7)
//   trial-not-started  every other ending of a web trial (TW-F1)
// Each try is one EmailSendLog row keyed checkout + outcome + try number
// (the unique key is the claim, so two senders never send the same try).
// A 'sent' or 'logged' try means done. Only the ending itself opens try 1;
// the reconcile pass and the reconciliation cron only carry on an
// outcome already on record, at most OUTCOME_MAIL_TRIES tries in all. None
// of them reruns conversion, a charge or entitlement.

export type GuestOutcome = 'welcome' | 'trial-refused' | 'trial-not-started';

export const OUTCOME_MAIL_TRIES = 5;
// A try still 'sending' after this is a crashed sender (sends abort at 8 s).
export const OUTCOME_MAIL_SENDING_MS = 2 * 60_000;
// The cron's wait after try n failed (n = 1..4): about 2.6 hours in all.
export const OUTCOME_MAIL_GAP_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000];
export const OUTCOME_MAIL_TEMPLATES = [
  'guest-welcome-new',
  'guest-welcome-existing',
  'guest-trial-refused',
  'guest-trial-not-started',
];

export function outcomeMailKey(checkoutId: string, outcome: GuestOutcome, attempt: number): string {
  return `guest-outcome:${checkoutId}:${outcome}:${attempt}`;
}

// FR-1199R2B (LS-1199R2 B2) — the Resend Idempotency-Key of an outcome: one
// per checkout and outcome, the same on every try. Resend keeps it 24 h and
// keeps only a request it accepted, so a try whose answer was lost is never
// sent twice; a 409 invalid_idempotent_request (same key, other body) means
// an earlier try was accepted.
export function outcomeMailRequestKey(checkoutId: string, outcome: GuestOutcome): string {
  return `guest-outcome:${checkoutId}:${outcome}`;
}

// FR-1199R2B (LS-1199R2 B4) — every send record key one checkout can have:
// each outcome, each try.
export function outcomeMailKeys(checkoutId: string): string[] {
  const outcomes: GuestOutcome[] = ['welcome', 'trial-refused', 'trial-not-started'];
  return outcomes.flatMap((outcome) =>
    Array.from({ length: OUTCOME_MAIL_TRIES }, (_, i) => outcomeMailKey(checkoutId, outcome, i + 1)),
  );
}

export function outcomeMailCheckoutId(key: string): string | null {
  const parts = key.split(':');
  return parts.length === 4 && parts[0] === 'guest-outcome' ? parts[1] : null;
}

/** The outcome a row's stored state owes its buyer (null = none). */
export function guestOutcome(row: {
  status: string;
  last_error: string | null;
  trial: boolean;
}): GuestOutcome | null {
  if (row.status === 'converted') return 'welcome';
  if (!row.trial) return null;
  if (row.status === 'conversion_failed_terminal' && row.last_error === 'trial_already_used') {
    return 'trial-refused';
  }
  if (row.status === 'conversion_failed_terminal' || row.status === 'failed') {
    return 'trial-not-started';
  }
  return null;
}

export interface OutcomeTry {
  status: string;
  created_at: Date;
}

/** The next try number to claim, or null (done, in flight, used up, not opened, or too soon). */
export function nextOutcomeTry(
  tries: OutcomeTry[],
  now: number,
  opts: { opening: boolean; paced: boolean },
): number | null {
  if (tries.some((t) => t.status === 'sent' || t.status === 'logged')) return null;
  if (tries.some((t) => t.status === 'sending' && now - t.created_at.getTime() < OUTCOME_MAIL_SENDING_MS)) {
    return null;
  }
  if (tries.length === 0) return opts.opening ? 1 : null;
  if (tries.length >= OUTCOME_MAIL_TRIES) return null;
  if (opts.paced) {
    const last = Math.max(...tries.map((t) => t.created_at.getTime()));
    if (now - last < OUTCOME_MAIL_GAP_MS[tries.length - 1]) return null;
  }
  return tries.length + 1;
}
