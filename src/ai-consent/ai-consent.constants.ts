/**
 * R2a — AI processing consent ledger constants (D2 consent contract, box 2).
 *
 * Box 2 of the onboarding consent screen is OPTIONAL: "Roman and the coach's
 * AI drafts may use the client's information, processed by Anthropic". This
 * module records that choice; it does not enforce it (enforcement on every AI
 * path is #601 / R2b, which calls the read interface in
 * `ai-consent.reader.ts`).
 *
 * The copy below is server-authoritative and must match the D2 contract
 * (DRAFT v2) byte for byte, except the retention sentence, which follows the
 * owner's 2026-10-01 20:32 decision ("I want to keep past AI chats forever")
 * and operator ruling OR-110-1 (a client delete and account deletion still
 * erase them). The version is a code constant, not an env
 * override: the text and its version always ship together. Every recorded
 * decision stores the sha256 of the copy it refers to, and consent counts only
 * while the stored version AND sha256 equal the current ones, so an in-place
 * copy edit (allowed before launch while the ledger flag has never been on)
 * makes any earlier test grant ineffective instead of silently re-pointing it
 * at new text.
 */
import { createHash } from 'node:crypto';

/**
 * Copy version of the box-2 text. Bump with any change to the text below.
 *
 * client-ai-v4 (2026-10-01): the retention sentence. v3 said Roman chats are
 * "kept for 180 days"; no purge exists and the owner decided to keep them
 * until the client deletes them or their account, so v3 misstated retention.
 * Older grants follow the existing exact-match rule unchanged: a v3 (or older)
 * grant stays in the append-only history but no longer counts as consent
 * (GET shows state `needs_reconsent`, `hasClientAiConsent` is false, every AI
 * path refuses with ai_consent_required) until the client allows the v4 text;
 * a POST that still names v3 gets 409 CONSENT_VERSION_MISMATCH with the v4
 * version and sha256; a withdrawal of a v3 grant is recorded against v3.
 */
export const CLIENT_AI_CONSENT_VERSION = 'client-ai-v4';

/** Processor + purpose keys stored on every ledger row. */
export const CLIENT_AI_CONSENT_PROCESSOR = 'anthropic';
export const CLIENT_AI_CONSENT_PURPOSE = 'client_ai_processing';

/** D2 contract, "Paragraph 4" (shown above box 2), v4 retention sentence. Exact text. */
export const CLIENT_AI_CONSENT_PARAGRAPH =
  'Roman, the assistant in this app, is powered by Anthropic, a third-party AI provider. ' +
  'If you allow it, your information is sent to Anthropic so Roman can answer your questions ' +
  'and your coach can use AI drafts about your training. ' +
  "Only your own data is used, never another client's, and never your coach's private notes. " +
  'Your conversations with Roman are private from your coach and are kept until you delete ' +
  'them or delete your account.';

/** D2 contract, "Box 2 label (optional)". Exact text. */
export const CLIENT_AI_CONSENT_BOX_LABEL =
  "Optional: I allow Roman and my coach's AI tools to use my information, processed by Anthropic.";

/** Separator between paragraph and label in the combined digest input. */
export const CLIENT_AI_CONSENT_COPY_SEPARATOR = '\n\n';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** sha256 of the paragraph alone (UTF-8). */
export const CLIENT_AI_CONSENT_PARAGRAPH_SHA256 = sha256Hex(CLIENT_AI_CONSENT_PARAGRAPH);
/** sha256 of the box label alone (UTF-8). */
export const CLIENT_AI_CONSENT_BOX_LABEL_SHA256 = sha256Hex(CLIENT_AI_CONSENT_BOX_LABEL);
/**
 * sha256 of `paragraph + "\n\n" + box_label` (UTF-8). This is the value a
 * client may echo as `copy_sha256` on POST and the value stored on each row.
 */
export const CLIENT_AI_CONSENT_COPY_SHA256 = sha256Hex(
  CLIENT_AI_CONSENT_PARAGRAPH + CLIENT_AI_CONSENT_COPY_SEPARATOR + CLIENT_AI_CONSENT_BOX_LABEL,
);

/** Ledger row actions (CHECK constraint in the migration). */
export const AI_CONSENT_ACTION_GRANT = 'grant';
export const AI_CONSENT_ACTION_WITHDRAW = 'withdraw';
export type AiConsentAction = typeof AI_CONSENT_ACTION_GRANT | typeof AI_CONSENT_ACTION_WITHDRAW;

/** Structured error codes. */
export const AI_CONSENT_ERROR_VERSION_MISMATCH = 'CONSENT_VERSION_MISMATCH';
export const AI_CONSENT_ERROR_UNAVAILABLE = 'AI_CONSENT_UNAVAILABLE';
/** Concurrent writers kept colliding on the next seq (bounded retries exhausted). */
export const AI_CONSENT_ERROR_CONFLICT = 'AI_CONSENT_CONFLICT';

/**
 * Ledger master switch. DEFAULT OFF everywhere: ON only when the value is
 * exactly 'true' (case-insensitive). While OFF, every /me/ai-consent route
 * returns 503 AI_CONSENT_UNAVAILABLE and `hasClientAiConsent` returns false
 * for everyone (no withdrawal path means no consent is honoured).
 */
export const AI_CONSENT_LEDGER_FLAG_ENV = 'FEATURE_AI_CONSENT_LEDGER_ENABLED';

export function isAiConsentLedgerEnabled(): boolean {
  return (process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED ?? '').trim().toLowerCase() === 'true';
}

/** Upper bound for the batch read (callers chunk larger sets). */
export const AI_CONSENT_BATCH_MAX = 200;

/** Bounded retries when two writers race for the same next `seq`. */
export const AI_CONSENT_WRITE_ATTEMPTS = 3;
