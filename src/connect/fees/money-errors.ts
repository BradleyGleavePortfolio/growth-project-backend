import { isChargeLockBusy, isChargeLockLost } from './charge-lock';

// S-FEE round 4 — retryable money-path failures. Each one means "nothing was
// moved on the basis of uncertain state": the caller must fail the delivery
// (non-2xx, so Stripe redelivers) or leave the work for the sweeper, and must
// never turn the failure into a recovery or fall back to older data.

export const MONEY_RETRY_CODES = {
  reversalUncertain: 'SFEE_REVERSAL_UNCERTAIN',
  disputeUnavailable: 'SFEE_DISPUTE_STATE_UNAVAILABLE',
  refundUnavailable: 'SFEE_REFUND_STATE_UNAVAILABLE',
  noticeUnrecorded: 'SFEE_NOTICE_UNRECORDED',
} as const;

/**
 * A transfer reversal was sent to Stripe and its outcome is unknown (timeout,
 * network, 5xx, 429, idempotency conflict) and the Stripe transfer's reversal
 * list does not show it yet. The operation stays `pending` with its
 * idempotency key; the next attempt re-drives the same key, so Stripe applies
 * it at most once. No recovery is opened for its amount.
 */
export class ReversalUncertainError extends Error {
  readonly code = MONEY_RETRY_CODES.reversalUncertain;

  constructor(
    readonly transferRowId: string,
    readonly operationKey: string,
    cause: string,
  ) {
    super(
      `${MONEY_RETRY_CODES.reversalUncertain} transfer=${transferRowId} op=${operationKey}: the reversal outcome is unknown (${cause}); ` +
        'it is retried with the same idempotency key and nothing else moves on this transfer until it resolves.',
    );
    this.name = 'ReversalUncertainError';
  }
}

/**
 * The dispute's canonical state could not be read from Stripe (request
 * failed or the response had no balance_transactions). The event's own
 * position may be stale (a late `created` after a `won`), so money never
 * moves on it; the settlement is flagged for the sweeper and the delivery
 * fails so Stripe redelivers.
 */
export class DisputeStateUnavailableError extends Error {
  readonly code = MONEY_RETRY_CODES.disputeUnavailable;

  constructor(
    readonly disputeId: string,
    readonly chargeId: string,
    cause: string,
  ) {
    super(
      `${MONEY_RETRY_CODES.disputeUnavailable} dispute=${disputeId} charge=${chargeId}: the dispute's current state could not be read from Stripe (${cause}); ` +
        'no money moved, the delivery is retried and the sweeper re-reads it.',
    );
    this.name = 'DisputeStateUnavailableError';
  }
}

// Round 11 (B-683-1): a converted charge's refunds were unreadable in the settlement
// currency (`reason`: a closed `kind=` diagnostic). Nothing moves; delivery and sweeper retry.
export class RefundStateUnavailableError extends Error {
  readonly code = MONEY_RETRY_CODES.refundUnavailable;
  constructor(chargeId: string, reason: string) {
    super(`${MONEY_RETRY_CODES.refundUnavailable} charge=${chargeId} ${reason}`);
    this.name = 'RefundStateUnavailableError';
  }
}

// Round 16 (Sol B-683-7): the money is converged, but neither the payee notice nor its retry
// flag could be written. The delivery fails so Stripe redelivers; the replay records the notice.
export class NoticeUnrecordedError extends Error {
  readonly code = MONEY_RETRY_CODES.noticeUnrecorded;
  constructor(chargeId: string) {
    super(`${MONEY_RETRY_CODES.noticeUnrecorded} charge=${chargeId}`);
    this.name = 'NoticeUnrecordedError';
  }
}

export function isReversalUncertain(err: unknown): err is ReversalUncertainError {
  return err instanceof ReversalUncertainError;
}

/** True for every failure that must be retried rather than swallowed. */
export function isRetryableMoneyError(err: unknown): boolean {
  return (
    isChargeLockBusy(err) ||
    isChargeLockLost(err) ||
    err instanceof ReversalUncertainError ||
    err instanceof DisputeStateUnavailableError ||
    err instanceof RefundStateUnavailableError ||
    err instanceof NoticeUnrecordedError
  );
}
