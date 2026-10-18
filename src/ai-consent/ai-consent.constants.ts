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
import { ROMAN_CRISIS_TOLD_SENTENCE } from '../roman/roman.feature';

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
// client-ai-v5 (memory scope) is defined below; v4 stays the copy GET offers.

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

/**
 * client-ai-v4 under its own names. The unversioned CLIENT_AI_CONSENT_* names
 * above stay the v4 copy: it is the base copy GET offers to everyone without
 * a v5 grant, because the 10-07 app build pins client-ai-v4 (it POSTs v4 from
 * the consultation, and Settings > Privacy treats any other `current_version`
 * as "update the app").
 */
export const CLIENT_AI_CONSENT_V4_VERSION = CLIENT_AI_CONSENT_VERSION;
export const CLIENT_AI_CONSENT_V4_PARAGRAPH = CLIENT_AI_CONSENT_PARAGRAPH;
export const CLIENT_AI_CONSENT_V4_COPY_SHA256 = CLIENT_AI_CONSENT_COPY_SHA256;

/**
 * client-ai-v5 (Roman v1.1, owner decision D1 approved 2026-10-06 12:01):
 * adds Roman's notes and summaries (kept when a chat is deleted, erased with
 * the account) and learning the coach's methods, and drops the v4 promise
 * "never your coach's private notes". Same box label. A v5 grant is the only
 * grant with the 'memory' scope; v4 stays a full 'base' grant (day-1 Roman
 * and coach AI drafts) and is never re-prompted.
 */
export const CLIENT_AI_CONSENT_V5_VERSION = 'client-ai-v5';

/** Owner-approved v5 paragraph (A-ROMAN11-124 section 6, D1). Exact text. */
export const CLIENT_AI_CONSENT_V5_PARAGRAPH =
  'Roman, the assistant in this app, is powered by Anthropic, a third-party AI provider. ' +
  'If you allow it, your information is sent to Anthropic so Roman can answer your questions ' +
  'and your coach can use AI drafts about your training. ' +
  'Roman may keep notes and summaries about your training, preferences and circumstances to ' +
  'personalise his replies. ' +
  'Deleting a chat removes its messages but not these notes; deleting your account removes them. ' +
  "Roman may also learn your coach's methods, including from your coach's private session notes, " +
  'and information about your training may help with that without identifying you. ' +
  "Roman never quotes those notes or shows you another client's information. " +
  'Your coach never sees your conversations with Roman or his notes about you. ' +
  'Your conversations with Roman are kept until you delete them or delete your account.';

export const CLIENT_AI_CONSENT_V5_PARAGRAPH_SHA256 = sha256Hex(CLIENT_AI_CONSENT_V5_PARAGRAPH);
/** sha256 of the v5 `paragraph + "\n\n" + box_label` (UTF-8). */
export const CLIENT_AI_CONSENT_V5_COPY_SHA256 = sha256Hex(
  CLIENT_AI_CONSENT_V5_PARAGRAPH + CLIENT_AI_CONSENT_COPY_SEPARATOR + CLIENT_AI_CONSENT_BOX_LABEL,
);

/**
 * The safety-reply exception (owner 57c, Option 1, 2026-10-12), the same
 * sentence as the privacy page: a coach sees the one message that prompted an
 * urgent medical or eating-disorder safety reply.
 */
export const CLIENT_AI_CONSENT_SAFETY_EXCEPTION =
  'One exception: if Roman sends you an urgent medical safety reply or an eating-disorder safety ' +
  'reply, your coach sees the message that prompted it, so they can check in with you.';

/**
 * client-ai-v6 / client-ai-v7 (owner 57c): the coached v4 / v5 paragraphs with
 * the exception added right after the sentence that says the coach does not
 * see Roman chats (the end of v4; before v5's last sentence). Same box label,
 * same scopes (v6 'base', v7 'memory'). GET offers them to a client with a
 * coach who has no live grant; a live v4 / v5 grant keeps reading its own copies.
 */
export const CLIENT_AI_CONSENT_V6_VERSION = 'client-ai-v6';
export const CLIENT_AI_CONSENT_V7_VERSION = 'client-ai-v7';

export const CLIENT_AI_CONSENT_V6_PARAGRAPH =
  CLIENT_AI_CONSENT_PARAGRAPH + ' ' + CLIENT_AI_CONSENT_SAFETY_EXCEPTION;

const V5_LAST_SENTENCE =
  'Your conversations with Roman are kept until you delete them or delete your account.';
export const CLIENT_AI_CONSENT_V7_PARAGRAPH =
  CLIENT_AI_CONSENT_V5_PARAGRAPH.slice(0, -V5_LAST_SENTENCE.length) +
  CLIENT_AI_CONSENT_SAFETY_EXCEPTION +
  ' ' +
  V5_LAST_SENTENCE;

export const CLIENT_AI_CONSENT_V6_PARAGRAPH_SHA256 = sha256Hex(CLIENT_AI_CONSENT_V6_PARAGRAPH);
export const CLIENT_AI_CONSENT_V7_PARAGRAPH_SHA256 = sha256Hex(CLIENT_AI_CONSENT_V7_PARAGRAPH);
export const CLIENT_AI_CONSENT_V6_COPY_SHA256 = sha256Hex(
  CLIENT_AI_CONSENT_V6_PARAGRAPH + CLIENT_AI_CONSENT_COPY_SEPARATOR + CLIENT_AI_CONSENT_BOX_LABEL,
);
export const CLIENT_AI_CONSENT_V7_COPY_SHA256 = sha256Hex(
  CLIENT_AI_CONSENT_V7_PARAGRAPH + CLIENT_AI_CONSENT_COPY_SEPARATOR + CLIENT_AI_CONSENT_BOX_LABEL,
);

/**
 * client-ai-v8 / client-ai-v9 (CRISIS-APP-COPY, owner op 1, 2026-10-15): the
 * v6 / v7 paragraphs with the approved crisis sentence right after the
 * exception sentence, nothing else changed. Same box label, same scopes (v8
 * 'base', v9 'memory'). GET ?variant=crisis_alert offers them only while
 * FEATURE_ROMAN_CRISIS_ALERT is on; v4 to v7 keep their text and digests.
 */
export const CLIENT_AI_CONSENT_V8_VERSION = 'client-ai-v8';
export const CLIENT_AI_CONSENT_V9_VERSION = 'client-ai-v9';

export const CLIENT_AI_CONSENT_V8_PARAGRAPH =
  CLIENT_AI_CONSENT_V6_PARAGRAPH + ' ' + ROMAN_CRISIS_TOLD_SENTENCE;
export const CLIENT_AI_CONSENT_V9_PARAGRAPH =
  CLIENT_AI_CONSENT_V5_PARAGRAPH.slice(0, -V5_LAST_SENTENCE.length) +
  CLIENT_AI_CONSENT_SAFETY_EXCEPTION +
  ' ' +
  ROMAN_CRISIS_TOLD_SENTENCE +
  ' ' +
  V5_LAST_SENTENCE;

export const CLIENT_AI_CONSENT_V8_PARAGRAPH_SHA256 = sha256Hex(CLIENT_AI_CONSENT_V8_PARAGRAPH);
export const CLIENT_AI_CONSENT_V9_PARAGRAPH_SHA256 = sha256Hex(CLIENT_AI_CONSENT_V9_PARAGRAPH);
export const CLIENT_AI_CONSENT_V8_COPY_SHA256 = sha256Hex(
  CLIENT_AI_CONSENT_V8_PARAGRAPH + CLIENT_AI_CONSENT_COPY_SEPARATOR + CLIENT_AI_CONSENT_BOX_LABEL,
);
export const CLIENT_AI_CONSENT_V9_COPY_SHA256 = sha256Hex(
  CLIENT_AI_CONSENT_V9_PARAGRAPH + CLIENT_AI_CONSENT_COPY_SEPARATOR + CLIENT_AI_CONSENT_BOX_LABEL,
);

/**
 * Coach-free copies (owner decision 62, Option 1, 2026-10-12): what a client
 * with no coach sees. The v4 and v5 paragraphs and the box label with every
 * coach sentence or clause removed and no new words. Each gives the same scope
 * as the copy it comes from (v4 coach-free 'base', v5 coach-free 'memory').
 * Onboarding P0 consult-consent-v5-coach-free / v6-coach-free carry them.
 */
export const CLIENT_AI_CONSENT_V4_COACH_FREE_VERSION = 'client-ai-v4-coach-free';
export const CLIENT_AI_CONSENT_V5_COACH_FREE_VERSION = 'client-ai-v5-coach-free';

export const CLIENT_AI_CONSENT_V4_COACH_FREE_PARAGRAPH =
  'Roman, the assistant in this app, is powered by Anthropic, a third-party AI provider. ' +
  'If you allow it, your information is sent to Anthropic so Roman can answer your questions. ' +
  "Only your own data is used, never another client's. " +
  'Your conversations with Roman are kept until you delete them or delete your account.';

export const CLIENT_AI_CONSENT_V5_COACH_FREE_PARAGRAPH =
  'Roman, the assistant in this app, is powered by Anthropic, a third-party AI provider. ' +
  'If you allow it, your information is sent to Anthropic so Roman can answer your questions. ' +
  'Roman may keep notes and summaries about your training, preferences and circumstances to ' +
  'personalise his replies. ' +
  'Deleting a chat removes its messages but not these notes; deleting your account removes them. ' +
  "Roman never shows you another client's information. " +
  'Your conversations with Roman are kept until you delete them or delete your account.';

export const CLIENT_AI_CONSENT_COACH_FREE_BOX_LABEL =
  'Optional: I allow Roman to use my information, processed by Anthropic.';

export const CLIENT_AI_CONSENT_COACH_FREE_BOX_LABEL_SHA256 = sha256Hex(
  CLIENT_AI_CONSENT_COACH_FREE_BOX_LABEL,
);
export const CLIENT_AI_CONSENT_V4_COACH_FREE_PARAGRAPH_SHA256 = sha256Hex(
  CLIENT_AI_CONSENT_V4_COACH_FREE_PARAGRAPH,
);
export const CLIENT_AI_CONSENT_V5_COACH_FREE_PARAGRAPH_SHA256 = sha256Hex(
  CLIENT_AI_CONSENT_V5_COACH_FREE_PARAGRAPH,
);
export const CLIENT_AI_CONSENT_V4_COACH_FREE_COPY_SHA256 = sha256Hex(
  CLIENT_AI_CONSENT_V4_COACH_FREE_PARAGRAPH +
    CLIENT_AI_CONSENT_COPY_SEPARATOR +
    CLIENT_AI_CONSENT_COACH_FREE_BOX_LABEL,
);
export const CLIENT_AI_CONSENT_V5_COACH_FREE_COPY_SHA256 = sha256Hex(
  CLIENT_AI_CONSENT_V5_COACH_FREE_PARAGRAPH +
    CLIENT_AI_CONSENT_COPY_SEPARATOR +
    CLIENT_AI_CONSENT_COACH_FREE_BOX_LABEL,
);

/** True for the coach-free copy versions (own names only). */
export function isCoachFreeClientAiVersion(version: unknown): boolean {
  return (
    version === CLIENT_AI_CONSENT_V4_COACH_FREE_VERSION ||
    version === CLIENT_AI_CONSENT_V5_COACH_FREE_VERSION
  );
}

/**
 * Who the AI output is for (ai-egress AiConsentAudience). A coach-free grant
 * (owner 62) covers 'client' only: its text names Roman answering the
 * client, not coach AI drafts or coach-method learning.
 */
export type ClientAiConsentAudience = 'coach' | 'client';

/**
 * What a live grant covers. 'base': day-1 Roman and the coach's AI drafts
 * (every existing AI path). 'memory': base plus Roman v1.1 notes, summaries
 * and coach-method learning (FEATURE_ROMAN_MEMORY / FEATURE_ROMAN_PLAYBOOK).
 */
export type ClientAiConsentScope = 'base' | 'memory';

export interface AcceptedClientAiConsent {
  readonly copy_sha256: string;
  readonly scope: ClientAiConsentScope;
}

/**
 * Every copy version a grant may name, with the exact copy sha256 it must
 * carry and the scope it gives. Anything else (v3 and older, unknown names,
 * a known name with another sha256) is not consent.
 */
export const CLIENT_AI_CONSENT_ACCEPTED: Readonly<Record<string, AcceptedClientAiConsent>> =
  Object.freeze({
    [CLIENT_AI_CONSENT_V4_VERSION]: Object.freeze({
      copy_sha256: CLIENT_AI_CONSENT_V4_COPY_SHA256,
      scope: 'base' as const,
    }),
    [CLIENT_AI_CONSENT_V5_VERSION]: Object.freeze({
      copy_sha256: CLIENT_AI_CONSENT_V5_COPY_SHA256,
      scope: 'memory' as const,
    }),
    [CLIENT_AI_CONSENT_V6_VERSION]: Object.freeze({
      copy_sha256: CLIENT_AI_CONSENT_V6_COPY_SHA256,
      scope: 'base' as const,
    }),
    [CLIENT_AI_CONSENT_V7_VERSION]: Object.freeze({
      copy_sha256: CLIENT_AI_CONSENT_V7_COPY_SHA256,
      scope: 'memory' as const,
    }),
    [CLIENT_AI_CONSENT_V8_VERSION]: Object.freeze({
      copy_sha256: CLIENT_AI_CONSENT_V8_COPY_SHA256,
      scope: 'base' as const,
    }),
    [CLIENT_AI_CONSENT_V9_VERSION]: Object.freeze({
      copy_sha256: CLIENT_AI_CONSENT_V9_COPY_SHA256,
      scope: 'memory' as const,
    }),
    [CLIENT_AI_CONSENT_V4_COACH_FREE_VERSION]: Object.freeze({
      copy_sha256: CLIENT_AI_CONSENT_V4_COACH_FREE_COPY_SHA256,
      scope: 'base' as const,
    }),
    [CLIENT_AI_CONSENT_V5_COACH_FREE_VERSION]: Object.freeze({
      copy_sha256: CLIENT_AI_CONSENT_V5_COACH_FREE_COPY_SHA256,
      scope: 'memory' as const,
    }),
  });

/** The accepted entry for `version` (own keys only), or null. */
export function acceptedClientAiConsent(version: unknown): AcceptedClientAiConsent | null {
  return typeof version === 'string' &&
    Object.prototype.hasOwnProperty.call(CLIENT_AI_CONSENT_ACCEPTED, version)
    ? CLIENT_AI_CONSENT_ACCEPTED[version]
    : null;
}

/**
 * COACH-AI-CONSENT (owner ruling "#COACH-AI-CONSENT - op 2", text approved 2026-10-16): a coach's
 * own grant, its own purpose in this ledger. CAC-1 is the title and sign-up box label, CAC-2 the
 * paragraph; digest as for the client copies. The app shows CAC-3 and CAC-4.
 */
export const COACH_AI_CONSENT_VERSION = 'coach-ai-v1';
export const COACH_AI_CONSENT_PURPOSE = 'coach_ai_processing';
/** CAC-1. Exact text. */
export const COACH_AI_CONSENT_TITLE = 'Turn on Roman';
/** CAC-2. Exact text. */
export const COACH_AI_CONSENT_PARAGRAPH =
  'Roman runs on Anthropic, an outside AI company. ' +
  'Anything you type to Roman, and your coaching notes, go to Anthropic. ' +
  "A client's data is never sent unless that client allowed AI.";
export const COACH_AI_CONSENT_TITLE_SHA256 = sha256Hex(COACH_AI_CONSENT_TITLE);
export const COACH_AI_CONSENT_PARAGRAPH_SHA256 = sha256Hex(COACH_AI_CONSENT_PARAGRAPH);
export const COACH_AI_CONSENT_COPY_SHA256 = sha256Hex(
  COACH_AI_CONSENT_PARAGRAPH + CLIENT_AI_CONSENT_COPY_SEPARATOR + COACH_AI_CONSENT_TITLE,
);

/** Ledger row actions (CHECK in the migrations). 'decline' (20270502004300): a coach's "Not now". */
export const AI_CONSENT_ACTION_GRANT = 'grant';
export const AI_CONSENT_ACTION_WITHDRAW = 'withdraw';
export const AI_CONSENT_ACTION_DECLINE = 'decline';
export type AiConsentAction =
  | typeof AI_CONSENT_ACTION_GRANT
  | typeof AI_CONSENT_ACTION_WITHDRAW
  | typeof AI_CONSENT_ACTION_DECLINE;

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
