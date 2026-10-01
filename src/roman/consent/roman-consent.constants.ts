/**
 * R2 — AI processing consent constants (PLAN_roman_intelligence §6.2),
 * revised to the owner rulings of 2026-09-30 16:31 (#5, #6).
 *
 * ONE grant. The client accepts a single "I agree" box during onboarding
 * that covers (a) the personal-training waiver and (b) letting Roman and the
 * coach's AI tools see the client's in-app data, processed by the named
 * third-party AI provider (Anthropic). Apple 5.1.2(i) requires the text to
 * name the provider and the data, so the copy below is server-authoritative
 * and versioned; the mobile renders exactly this text and sends back the
 * version (and optionally the sha256) it displayed.
 */

/** Env var naming the consent copy version the server currently requires. */
export const ROMAN_CONSENT_CURRENT_VERSION_ENV = 'ROMAN_CONSENT_CURRENT_VERSION';
/** Default when the env var is unset: the combined onboarding copy below. */
export const ROMAN_CONSENT_DEFAULT_VERSION = 'client-ai-v2';

/** The processor + purpose keys stored on the consent row. */
export const ROMAN_CONSENT_PROCESSOR = 'anthropic';
/**
 * One purpose for the whole client-data AI boundary: Roman chat AND the
 * coach's AI drafts about this client (ruling #5: one box covers "letting
 * Roman/TGP see the client's in-app data"). Coach generation is gated on the
 * CLIENT holding this grant (Sol A2), never on the coach's own grant.
 */
export const ROMAN_CONSENT_PURPOSE = 'client_ai_processing';

/** Version of the personal-training waiver text accepted with the same box. */
export const PT_WAIVER_CURRENT_VERSION_ENV = 'PT_WAIVER_CURRENT_VERSION';
export const PT_WAIVER_DEFAULT_VERSION = 'pt-waiver-v1';

/**
 * The data categories the copy names (ruling #6 — Roman sees ALL of the
 * client's own data). Kept as a list so the copy and the context builder
 * can be checked against each other in tests.
 */
export const ROMAN_CONSENT_DATA_CATEGORIES: readonly string[] = [
  'your profile',
  'your consultation and safety-screen answers',
  'your food logs',
  'your workouts and workout history',
  'your check-ins',
  'your wearable, health and sleep data',
  'your messages with your coach',
  'the community posts you write',
];

/**
 * The exact combined copy (client-ai-v2). Plain words, no exclamation marks.
 * Names the third-party AI provider (Anthropic) and every data category.
 * A change to this text requires a version bump.
 */
export const ROMAN_CONSENT_COPY_V2 =
  'By ticking this box I agree to the personal-training waiver, and I agree that Roman (the AI assistant in this app) ' +
  'and my coach may use my in-app data to coach me. ' +
  'That data is sent to a third-party AI provider, Anthropic, to generate Roman\'s replies and my coach\'s AI drafts. ' +
  `It includes: ${ROMAN_CONSENT_DATA_CATEGORIES.join(', ')}. ` +
  'Only my own data is used, never another client\'s, and never my coach\'s private notes about me. ' +
  'My conversations with Roman are stored securely and kept private from my coach; ' +
  'TGP staff may access them only for support, safety and debugging. ' +
  'They are deleted automatically after 180 days, and I can delete any conversation at any time. ' +
  'Roman is a personal-training assistant, not a medical service. ' +
  'I can withdraw this agreement at any time in Settings; Roman and AI drafts then stop until I agree again.';

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

/** Resolve the required waiver version from the environment. */
export function ptWaiverCurrentVersion(env: NodeJS.ProcessEnv = process.env): string {
  const v = (env[PT_WAIVER_CURRENT_VERSION_ENV] ?? '').trim();
  return v || PT_WAIVER_DEFAULT_VERSION;
}
