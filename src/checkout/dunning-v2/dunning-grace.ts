/**
 * B-690-5 (Sol): the Stripe subscription statuses of a failed renewal that
 * Smart Dunning v2 keeps entitled on Days 0-9 while the cycle is active and
 * unlocked. Stripe reports `unpaid` instead of `past_due` when the account's
 * "if all retries fail" setting marks the subscription unpaid; both are the
 * same delinquent period, and Day 10 still locks through DunningLockoutGuard.
 */
export const DUNNING_V2_GRACE_STATUSES: readonly string[] = ['past_due', 'unpaid'];

/** Thrown to fail a webhook delivery so Stripe redelivers it (a closed code, never provider text). */
export class DunningWebhookRetryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'DunningWebhookRetryError';
  }
}
