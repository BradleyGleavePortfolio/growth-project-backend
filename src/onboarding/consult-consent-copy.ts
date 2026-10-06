/**
 * P0 consent copy ("Before we start"), server-side record of exactly what the
 * mobile app shows (D2 contract, two boxes on one screen).
 *
 * The server stores what was shown: a P0 acknowledgement counts only when its
 * `copy_version` is an accepted version AND its `text_sha256` equals the
 * sha256 of that version's full screen text below. The text is byte-identical
 * to mobile #310 `consentCopyText()` (src/lib/consultation/copy.ts): title,
 * paragraphs 1-3, box 1 label, paragraph 4, box 2 label, footer, joined with
 * "\n\n", UTF-8, straight apostrophes. Mobile pins the same digest as
 * `CONSENT_COPY_SHA256`; both sides recompute it from the text in a unit test,
 * so neither text can change without the version and the pin changing too.
 *
 * consult-consent-v3 (2026-10-01): paragraph 4's retention sentence follows
 * the owner's 20:32 decision (Roman chats are kept until the client deletes
 * them or their account; OR-110-1). It equals the client-ai-v4 box 2 server
 * copy of the AI consent ledger byte for byte (paragraph 4 + "\n\n" + box 2
 * label hashes to the ledger's client-ai-v4 copy sha256). This module never
 * imports the ledger (D2: onboarding does not depend on #601 / R2a); the
 * shared digest is pinned here instead.
 *
 * v3 only: no client ever recorded v2 outside tests (the intake table is not
 * deployed), so there is no compatibility window, the same rule as the
 * earlier v1 -> v2 move. A v2 (or older) P0 is `409 consent_missing`.
 *
 * consult-consent-v4 (Roman v1.1, owner D1 2026-10-06): the same screen with
 * paragraph 4 replaced by the client-ai-v5 paragraph (paragraph 4 + "\n\n" +
 * box 2 label hashes to the ledger's client-ai-v5 copy sha256). Accepted
 * next to v3: the 10-07 app build keeps sending v3, a later app sends v4.
 */
import { createHash } from 'node:crypto';

export const CONSULT_CONSENT_V3 = 'consult-consent-v3';
export const CONSULT_CONSENT_V4 = 'consult-consent-v4';

/** The displayed parts of one P0 screen version, in display order. */
export interface ConsultConsentCopy {
  title: string;
  /** Paragraphs 1-3, shown above box 1. */
  paragraphs: readonly string[];
  /** Box 1 (required): waiver + collection and use for coaching. */
  box1Label: string;
  /** Paragraph 4, shown above box 2 (Roman and AI, processed by Anthropic). */
  aiParagraph: string;
  /** Box 2 (optional, unticked by default). Never part of the P0 record. */
  box2Label: string;
  footer: string;
}

export const CONSULT_CONSENT_COPY_V3: ConsultConsentCopy = {
  title: 'Before we start',
  paragraphs: [
    'The Growth Project provides personal training and nutrition guidance only. We do not diagnose, treat, or give medical advice. Nothing in this app replaces the advice of a physician or other qualified health provider.',
    'Exercise carries some risk of injury. You choose how hard to work, you stop if something hurts, and you take part at your own risk.',
    'To coach you, The Growth Project and your coach collect and use what you share here: your profile, this consultation including the screening questions, your targets, food and workout logs, check-ins, any health, sleep or wearable data you choose to connect, your messages with your coach, and posts you write in the community. We use it only to provide your training. We never sell it. If you joined through a clinic, the clinic does not see it.',
  ],
  box1Label:
    'I agree to the training waiver, and to The Growth Project and my coach collecting and using my information to coach me.',
  aiParagraph:
    "Roman, the assistant in this app, is powered by Anthropic, a third-party AI provider. If you allow it, your information is sent to Anthropic so Roman can answer your questions and your coach can use AI drafts about your training. Only your own data is used, never another client's, and never your coach's private notes. Your conversations with Roman are private from your coach and are kept until you delete them or delete your account.",
  box2Label:
    "Optional: I allow Roman and my coach's AI tools to use my information, processed by Anthropic.",
  footer:
    "Nothing is sent until you continue. You can change the optional choice at any time in Settings > Privacy. Roman's guided tour works either way.",
};

/** consult-consent-v4: v3 with the client-ai-v5 paragraph 4 (Roman notes, coach methods). */
export const CONSULT_CONSENT_COPY_V4: ConsultConsentCopy = {
  ...CONSULT_CONSENT_COPY_V3,
  aiParagraph:
    "Roman, the assistant in this app, is powered by Anthropic, a third-party AI provider. If you allow it, your information is sent to Anthropic so Roman can answer your questions and your coach can use AI drafts about your training. Roman may keep notes and summaries about your training, preferences and circumstances to personalise his replies. Deleting a chat removes its messages but not these notes; deleting your account removes them. Roman may also learn your coach's methods, including from your coach's private session notes, and information about your training may help with that without identifying you. Roman never quotes those notes or shows you another client's information. Your coach never sees your conversations with Roman or his notes about you. Your conversations with Roman are kept until you delete them or delete your account.",
};

/** Separator between displayed parts in every digest input. */
export const CONSULT_CONSENT_SEPARATOR = '\n\n';

/** Full screen text in display order (mobile `consentCopyText()`). */
export function consultConsentScreenText(copy: ConsultConsentCopy): string {
  return [
    copy.title,
    ...copy.paragraphs,
    copy.box1Label,
    copy.aiParagraph,
    copy.box2Label,
    copy.footer,
  ].join(CONSULT_CONSENT_SEPARATOR);
}

/** Paragraph 4 + box 2 label (mobile `aiConsentCopyText()`; ledger copy input). */
export function consultConsentAiSliceText(copy: ConsultConsentCopy): string {
  return [copy.aiParagraph, copy.box2Label].join(CONSULT_CONSENT_SEPARATOR);
}

export function sha256Utf8Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Pinned digests. A unit test recomputes both from the text above, so the
 * text cannot drift from the pins (or from mobile, which pins the same values).
 *   screen: mobile #310 CONSENT_COPY_SHA256
 *   aiSlice: mobile #310 AI_CONSENT_COPY_SHA256 = ledger client-ai-v4 copy sha256
 */
export const CONSULT_CONSENT_V3_TEXT_SHA256 =
  '79ceeb6b8316ee9e3f583fe678e2463584c6dda4c93b5c95746dfe5c52ef31c9';
export const CONSULT_CONSENT_V3_AI_SLICE_SHA256 =
  'fbf821401d4313c6a301a6cc08d3870bb117c293fbb970e321bf87f49abe34f4';
/** v4 pins: screen text, and aiSlice = ledger client-ai-v5 copy sha256. */
export const CONSULT_CONSENT_V4_TEXT_SHA256 =
  '74d0a48ad2b0a50f6f8e699fe6d131f0262f35ce1fff6248c9770d9267a5fb1a';
export const CONSULT_CONSENT_V4_AI_SLICE_SHA256 =
  '8c19fca94c2455094c47b1802bb6693aff47d24c7b6df3b256d0a0e8e90fe8ee';

/**
 * Every P0 copy version the server knows the exact text of, with the sha256
 * of its full screen text. Only these versions can ever count as consent:
 * an acknowledgement is verified against the text that was shown, so a
 * version without known text cannot be accepted (CONSULT_CONSENT_COPY_VERSIONS
 * may only choose among these).
 */
export const CONSULT_CONSENT_COPIES: Readonly<
  Record<string, { copy: ConsultConsentCopy; text_sha256: string }>
> = Object.freeze({
  [CONSULT_CONSENT_V3]: {
    copy: CONSULT_CONSENT_COPY_V3,
    text_sha256: CONSULT_CONSENT_V3_TEXT_SHA256,
  },
  [CONSULT_CONSENT_V4]: {
    copy: CONSULT_CONSENT_COPY_V4,
    text_sha256: CONSULT_CONSENT_V4_TEXT_SHA256,
  },
});

/** The pinned full-text sha256 of a known version, or null. */
export function consultConsentTextSha256(version: string): string | null {
  return Object.prototype.hasOwnProperty.call(CONSULT_CONSENT_COPIES, version)
    ? CONSULT_CONSENT_COPIES[version].text_sha256
    : null;
}

/**
 * Names in a CONSULT_CONSENT_COPY_VERSIONS value the server has no exact text
 * for. They can never be verified, so they are ignored (and logged once).
 */
export function unknownConsultConsentVersions(raw: string): string[] {
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0 && consultConsentTextSha256(v) === null);
}
