// src/notifications/push-delivery.types.ts
//
// Typed contract for NotificationsService.pushToUser. Callers that need
// delivery semantics (e.g. CoachBriefScheduler writing a "this brief was
// delivered today" marker) MUST consult the return value's `delivered`
// flag rather than relying on "the promise resolved".
//
// Rationale: pre-fix-round-5 pushToUser swallowed every error inside a
// catch block and resolved `void`, so the scheduler treated transport
// failures as success. The new contract makes the outcome explicit:
//   - delivered=true  -- the Expo SDK accepted the message AND no
//                       ticket-level error was returned synchronously.
//   - delivered=false -- anything else, with a stable code describing
//                       why so observability can distinguish abort,
//                       no-token, invalid-token, transport-failure,
//                       and ticket-error without parsing message text.
//
// The aborted / timeout case is reported as `delivered: false` with
// code 'aborted' so the scheduler can deliberately NOT mark success.

export type PushDeliveryCode =
  | 'delivered'
  | 'no-token'
  | 'invalid-token'
  | 'aborted'
  | 'transport-error'
  | 'ticket-error';

export interface PushDeliveryResult {
  delivered: boolean;
  code: PushDeliveryCode;
  // Optional human-readable detail for logs only. MUST be scrubbed before
  // any client-facing payload -- contains provider error text.
  detail?: string;
}

// Typed domain error replacing the raw `new Error('pushToUser aborted')`
// that violated the R17 / Hard Rule "no raw new Error" ban. Carrying a
// stable `code` lets observability and callers branch on the abort path
// without parsing message text.
export class PushAbortedError extends Error {
  readonly code = 'PUSH_ABORTED' as const;
  constructor(detail?: string) {
    super(detail ? `push aborted: ${detail}` : 'push aborted');
    this.name = 'PushAbortedError';
  }
}
