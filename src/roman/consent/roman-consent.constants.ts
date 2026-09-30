/**
 * R2 — AI processing consent constants (PLAN_roman_intelligence §6.2).
 */

/** Env var naming the consent copy version the server currently requires. */
export const ROMAN_CONSENT_CURRENT_VERSION_ENV = 'ROMAN_CONSENT_CURRENT_VERSION';
/** Default when the env var is unset: the §6.1 sheet copy. */
export const ROMAN_CONSENT_DEFAULT_VERSION = 'roman-ai-v1';

/** The processor + purpose keys stored on the consent row. */
export const ROMAN_CONSENT_PROCESSOR = 'anthropic';
export const ROMAN_CONSENT_PURPOSE = 'roman_chat';

/**
 * Structured 403 code (ENGINEERING_RULES §3: no raw codes). The mobile app
 * shows the consent sheet when it sees this code, then retries the send.
 */
export const ROMAN_ERROR_CONSENT_REQUIRED = 'ROMAN_CONSENT_REQUIRED';

/** AuditLog actions written on every consent transition. */
export const ROMAN_AUDIT_AI_CONSENT_GRANTED = 'ai_consent.granted';
export const ROMAN_AUDIT_AI_CONSENT_REVOKED = 'ai_consent.revoked';

/** Resolve the required consent version from the environment. */
export function romanConsentCurrentVersion(env: NodeJS.ProcessEnv = process.env): string {
  const v = (env[ROMAN_CONSENT_CURRENT_VERSION_ENV] ?? '').trim();
  return v || ROMAN_CONSENT_DEFAULT_VERSION;
}
