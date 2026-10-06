/**
 * Log lines, stored error columns and returned errors carry ids and
 * server-owned codes, never personal data (C-611-17, agent 117; B-700-1,
 * B-700-2, C-700-2, C-700-3, agent 118, B-PRIVFU2-118; AGENT_RULES G12).
 *
 * Code in this service never interpolates an email address, a person's name
 * or free text (message bodies, notes, request payloads) into a log line; it
 * logs the row id, user id or template key instead.
 *
 * Text the service does not write itself (an email provider's error body,
 * an exception message, a Supabase Auth or Prisma error message) can echo
 * an address, a display name or a message body back, for example
 * `Invalid recipient Pat Quill <pat@example.com>` or
 * `Email address "pat@example.com" is invalid`. No pattern can tell a name
 * from any other word, so that text never reaches a log line, an error
 * column or an API result. `describeFailure` keeps only what the code or the
 * provider's fixed vocabulary owns: the error class, an HTTP status, and a
 * code from a finite list. Anything outside the list becomes `other`.
 *
 * test/privacy/no-pii-in-logs.spec.ts enforces this over every log call
 * under src/ (see src/observability/README.md for the legacy baseline).
 */

/** Email providers whose HTTP failures are described by `ProviderFailure`. */
export type FailureProvider = 'resend' | 'sendgrid' | 'postmark';

// Resend error `name` values (resend.com/docs/api-reference/errors, read
// 2026-10-04, plus the older names the API still returns).
const RESEND_ERROR_NAMES: ReadonlySet<string> = new Set([
  'application_error',
  'concurrent_idempotent_requests',
  'daily_quota_exceeded',
  'email_above_quota',
  'internal_server_error',
  'invalid_access',
  'invalid_api_key',
  'invalid_attachment',
  'invalid_from_address',
  'invalid_idempotency_key',
  'invalid_idempotent_request',
  'invalid_parameter',
  'invalid_permission',
  'invalid_region',
  'method_not_allowed',
  'missing_api_key',
  'missing_required_field',
  'missing_required_parameter',
  'monthly_quota_exceeded',
  'not_found',
  'rate_limit_exceeded',
  'resource_locked',
  'restricted_api_key',
  'security_error',
  'service_unavailable',
  'suspended_api_key',
  'validation_error',
]);

// Codes the service itself assigns to a provider failure.
const SERVER_PROVIDER_CODES: ReadonlySet<string> = new Set([
  'empty',
  'unparsed',
  'missing_id',
  'other',
]);

// Supabase Auth `ErrorCode` (@supabase/auth-js lib/error-codes.d.ts).
const SUPABASE_AUTH_CODES = [
  'unexpected_failure', 'validation_failed', 'bad_json', 'email_exists', 'phone_exists',
  'bad_jwt', 'not_admin', 'no_authorization', 'user_not_found', 'session_not_found',
  'session_expired', 'refresh_token_not_found', 'refresh_token_already_used',
  'flow_state_not_found', 'flow_state_expired', 'signup_disabled', 'user_banned',
  'provider_email_needs_verification', 'invite_not_found', 'bad_oauth_state',
  'bad_oauth_callback', 'oauth_provider_not_supported', 'unexpected_audience',
  'single_identity_not_deletable', 'email_conflict_identity_not_deletable',
  'identity_already_exists', 'email_provider_disabled', 'phone_provider_disabled',
  'too_many_enrolled_mfa_factors', 'mfa_factor_name_conflict', 'mfa_factor_not_found',
  'mfa_ip_address_mismatch', 'mfa_challenge_expired', 'mfa_verification_failed',
  'mfa_verification_rejected', 'insufficient_aal', 'captcha_failed', 'saml_provider_disabled',
  'manual_linking_disabled', 'sms_send_failed', 'email_not_confirmed', 'phone_not_confirmed',
  'reauth_nonce_missing', 'saml_relay_state_not_found', 'saml_relay_state_expired',
  'saml_idp_not_found', 'saml_assertion_no_user_id', 'saml_assertion_no_email',
  'user_already_exists', 'sso_provider_not_found', 'saml_metadata_fetch_failed',
  'saml_idp_already_exists', 'sso_domain_already_exists', 'saml_entity_id_mismatch',
  'conflict', 'provider_disabled', 'user_sso_managed', 'reauthentication_needed',
  'same_password', 'reauthentication_not_valid', 'otp_expired', 'otp_disabled',
  'identity_not_found', 'weak_password', 'over_request_rate_limit',
  'over_email_send_rate_limit', 'over_sms_send_rate_limit', 'bad_code_verifier',
  'anonymous_provider_disabled', 'hook_timeout', 'hook_timeout_after_retry',
  'hook_payload_over_size_limit', 'hook_payload_invalid_content_type', 'request_timeout',
  'mfa_phone_enroll_not_enabled', 'mfa_phone_verify_not_enabled',
  'mfa_totp_enroll_not_enabled', 'mfa_totp_verify_not_enabled',
  'mfa_webauthn_enroll_not_enabled', 'mfa_webauthn_verify_not_enabled',
  'mfa_verified_factor_exists', 'invalid_credentials', 'email_address_not_authorized',
  'email_address_invalid',
] as const;

// jose error codes (jose/dist/webapi/util/errors.js, v6).
const JOSE_CODES = [
  'ERR_JOSE_ALG_NOT_ALLOWED', 'ERR_JOSE_GENERIC', 'ERR_JOSE_NOT_SUPPORTED',
  'ERR_JWE_DECRYPTION_FAILED', 'ERR_JWE_INVALID', 'ERR_JWKS_INVALID',
  'ERR_JWKS_MULTIPLE_MATCHING_KEYS', 'ERR_JWKS_NO_MATCHING_KEY', 'ERR_JWKS_TIMEOUT',
  'ERR_JWK_INVALID', 'ERR_JWS_INVALID', 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWT_CLAIM_VALIDATION_FAILED', 'ERR_JWT_EXPIRED', 'ERR_JWT_INVALID',
] as const;

// Node system and undici (fetch) network codes.
const NETWORK_CODES = [
  'ABORT_ERR', 'EAI_AGAIN', 'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH',
  'ENETUNREACH', 'ENOTFOUND', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_ABORTED', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CLOSED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
] as const;

const KNOWN_CODES: ReadonlySet<string> = new Set<string>([
  ...SUPABASE_AUTH_CODES,
  ...JOSE_CODES,
  ...NETWORK_CODES,
]);

// Prisma engine codes are a letter and four digits (P2002, P1001): no room
// for a name or an address.
const PRISMA_CODE = /^P\d{4}$/;

// JWT claim names jose reports on a claim failure.
const JWT_CLAIMS: ReadonlySet<string> = new Set([
  'aud', 'azp', 'exp', 'iat', 'iss', 'jti', 'nbf', 'nonce', 'sub', 'typ', 'unspecified',
]);

function providerCodeIsKnown(code: string): boolean {
  return RESEND_ERROR_NAMES.has(code) || SERVER_PROVIDER_CODES.has(code) || /^postmark_\d{1,5}$/.test(code);
}

/**
 * A provider HTTP call that failed. The message is built from server-owned
 * parts only (provider, HTTP status, a code from the finite list), so even a
 * caller that logs `err.message` cannot leak the provider's body.
 */
export class ProviderFailure extends Error {
  readonly provider: FailureProvider;
  readonly status: number | null;
  readonly code: string;

  constructor(provider: FailureProvider, status: number | null, code: string) {
    const safeStatus = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
    const safeCode = providerCodeIsKnown(code) ? code : 'other';
    super(`provider=${provider} status=${safeStatus ?? 'none'} code=${safeCode}`);
    this.name = 'ProviderFailure';
    this.provider = provider;
    this.status = safeStatus;
    this.code = safeCode;
  }
}

/**
 * The provider's own error code from a failure body, from a finite list.
 * Resend: `{ name }`; Postmark: `{ ErrorCode }` (a number); SendGrid has no
 * code in its body. The body text itself is never returned.
 */
export function providerErrorCode(provider: FailureProvider, body: unknown): string {
  if (typeof body !== 'string' || body.trim().length === 0) return 'empty';
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return 'unparsed';
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unparsed';
  const record = parsed as Record<string, unknown>;
  if (provider === 'resend') {
    return typeof record.name === 'string' && RESEND_ERROR_NAMES.has(record.name) ? record.name : 'other';
  }
  if (provider === 'postmark') {
    const n = record.ErrorCode;
    return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 99999 ? `postmark_${n}` : 'other';
  }
  return 'other';
}

function className(err: object): string {
  const ctor = (err as { constructor?: unknown }).constructor;
  const name = typeof ctor === 'function' ? ctor.name : '';
  // A class name is written in code, never built from data; the shape check
  // is a second fence.
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : 'other';
}

function httpStatus(record: Record<string, unknown>): number | null {
  for (const v of [record.status, record.statusCode]) {
    if (typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599) return v;
  }
  return null;
}

function knownCode(v: unknown, extra: ReadonlySet<string> | undefined): string | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  return KNOWN_CODES.has(v) || PRISMA_CODE.test(v) || extra?.has(v) === true ? v : 'other';
}

/**
 * A server-owned description of any thrown value or returned error object:
 * `error=<class>[ status=<http status>][ code=<known code>][ claim=<jwt claim>]`.
 * Never the message, the stack or any field the failure carries as text.
 * `extraCodes` is a module's own finite list of error codes (for example
 * `COACH_BRIEF_CLAUDE_EMPTY`); any other code becomes `other`. Never throws.
 */
export function describeFailure(err: unknown, extraCodes?: ReadonlySet<string>): string {
  try {
    if (err instanceof ProviderFailure) return err.message;
    if (err === null || err === undefined) return 'error=none';
    if (typeof err !== 'object') return 'error=non_error';
    const record = err as Record<string, unknown>;
    const parts = [`error=${className(err)}`];
    const status = httpStatus(record);
    if (status !== null) parts.push(`status=${status}`);
    const cause = record.cause;
    const code =
      knownCode(record.code, extraCodes) ??
      (cause !== null && typeof cause === 'object'
        ? knownCode((cause as Record<string, unknown>).code, extraCodes)
        : null);
    if (code !== null) parts.push(`code=${code}`);
    if (typeof record.claim === 'string' && JWT_CLAIMS.has(record.claim)) parts.push(`claim=${record.claim}`);
    return parts.join(' ');
  } catch {
    return 'error=other';
  }
}
