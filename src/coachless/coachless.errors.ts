import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * A1-COACHLESS — stable machine codes for every coachless-Home failure.
 *
 * Every refusal is `{ code, message }` (the ErrorEnvelope convention). Mobile
 * maps `code` to specific copy (what happened + what to do next); `message`
 * is a plain fallback for logs and API consumers and never echoes the code
 * string, a coach id or an email.
 */
export const COACHLESS_ERROR = {
  /** Unknown code, malformed code, or a code whose owner is not a coach. */
  CODE_INVALID: 'code_invalid',
  /** A per-row code past its expires_at. */
  CODE_EXPIRED: 'code_expired',
  /** A per-row code the coach revoked. */
  CODE_REVOKED: 'code_revoked',
  /** A per-row code with every seat used. */
  CODE_EXHAUSTED: 'code_exhausted',
  /** A single-recipient code redeemed from a different email. */
  CODE_EMAIL_MISMATCH: 'code_email_mismatch',
  /** The coach cannot take new clients (subscription, or the owner paused the featured offer). */
  COACH_NOT_ACCEPTING: 'coach_not_accepting',
  /** The caller already has a different coach (no re-parenting by code). */
  ALREADY_ATTACHED: 'already_attached',
  /** Coach, sub-coach and owner accounts are never attached to a coach. */
  ROLE_CANNOT_REDEEM: 'role_cannot_redeem',
  /** The caller's account row no longer exists. */
  ACCOUNT_NOT_FOUND: 'account_not_found',
  /** Missing or non-UUID Idempotency-Key header. */
  IDEMPOTENCY_KEY_REQUIRED: 'idempotency_key_required',
  /** The same Idempotency-Key was sent with a different code. */
  IDEMPOTENCY_KEY_REUSED: 'idempotency_key_reused',
  /** A request with this Idempotency-Key is still running. */
  REDEMPTION_IN_PROGRESS: 'redemption_in_progress',
  /** Unexpected server failure; the response carries the request reference. */
  REDEMPTION_FAILED: 'redemption_failed',
  /** FEATURE_COACHLESS_HOME is off. */
  COACHLESS_DISABLED: 'coachless_disabled',
  /** Owner config: the code belongs to a coach other than the featured coach. */
  FEATURED_CODE_OTHER_COACH: 'featured_code_other_coach',
  /** Owner config: the featured coach id is not a coach account. */
  FEATURED_COACH_INVALID: 'featured_coach_invalid',
  /** Owner config: the package is not an active package of the featured coach. */
  FEATURED_PACKAGE_INVALID: 'featured_package_invalid',
  /** Owner config: the code does not resolve and creation was not requested. */
  FEATURED_CODE_UNKNOWN: 'featured_code_unknown',
} as const;

export type CoachlessErrorCode = (typeof COACHLESS_ERROR)[keyof typeof COACHLESS_ERROR];

/** Default human message per code (never shown verbatim by mobile; logs/API only). */
export const COACHLESS_ERROR_MESSAGE: Record<CoachlessErrorCode, string> = {
  code_invalid:
    'That code does not match a coach. Check the spelling or ask your coach to resend it.',
  code_expired: 'That code has expired. Ask your coach for a new one.',
  code_revoked: 'That code is no longer active. Ask your coach for a current code.',
  code_exhausted:
    'That code has been used the maximum number of times. Ask your coach for a new one.',
  code_email_mismatch:
    'That code was sent to a different email address. Sign in with that email or ask your coach for your own code.',
  coach_not_accepting:
    'This coach is not taking new clients right now. Try again later or use another coach code.',
  already_attached: 'Your account already has a coach. Contact support to change coaches.',
  role_cannot_redeem: 'Coach and owner accounts cannot join a coach with a client code.',
  account_not_found: 'Your account could not be found. Sign out and sign in again.',
  idempotency_key_required: 'Idempotency-Key header is required and must be a UUID.',
  idempotency_key_reused:
    'This Idempotency-Key was already used with a different code. Send a new key.',
  redemption_in_progress:
    'This code is still being applied. Wait a moment, then retry with the same key.',
  redemption_failed:
    'The code could not be applied because of a server problem. Retry, or contact support with the reference.',
  coachless_disabled: 'Not found.',
  featured_code_other_coach: 'That code belongs to a different coach.',
  featured_coach_invalid: 'The featured coach must be an existing coach account.',
  featured_package_invalid: 'The featured package must be an active package of the featured coach.',
  featured_code_unknown:
    'That code does not exist yet. Set create_code_if_missing to create it for the featured coach.',
};

export const COACHLESS_ERROR_STATUS: Record<CoachlessErrorCode, number> = {
  code_invalid: HttpStatus.NOT_FOUND,
  code_expired: HttpStatus.GONE,
  code_revoked: HttpStatus.GONE,
  code_exhausted: HttpStatus.GONE,
  code_email_mismatch: HttpStatus.FORBIDDEN,
  coach_not_accepting: HttpStatus.CONFLICT,
  already_attached: HttpStatus.CONFLICT,
  role_cannot_redeem: HttpStatus.FORBIDDEN,
  account_not_found: HttpStatus.NOT_FOUND,
  idempotency_key_required: HttpStatus.BAD_REQUEST,
  idempotency_key_reused: HttpStatus.UNPROCESSABLE_ENTITY,
  redemption_in_progress: HttpStatus.CONFLICT,
  redemption_failed: HttpStatus.INTERNAL_SERVER_ERROR,
  coachless_disabled: HttpStatus.NOT_FOUND,
  featured_code_other_coach: HttpStatus.CONFLICT,
  featured_coach_invalid: HttpStatus.BAD_REQUEST,
  featured_package_invalid: HttpStatus.BAD_REQUEST,
  featured_code_unknown: HttpStatus.BAD_REQUEST,
};

export interface CoachlessErrorBody {
  code: CoachlessErrorCode;
  message: string;
  request_id?: string;
}

export class CoachlessError extends HttpException {
  constructor(
    readonly coachlessCode: CoachlessErrorCode,
    extra: { request_id?: string } = {},
  ) {
    const body: CoachlessErrorBody = {
      code: coachlessCode,
      message: COACHLESS_ERROR_MESSAGE[coachlessCode],
      ...(extra.request_id ? { request_id: extra.request_id } : {}),
    };
    super(body, COACHLESS_ERROR_STATUS[coachlessCode]);
  }
}
