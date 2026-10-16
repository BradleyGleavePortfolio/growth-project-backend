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
 *
 * consult-consent-v5 / v6 (owner C-6 and C-6a Option 1, 2026-10-12): v3 / v4
 * with only paragraph 3's last sentence (the clinic sentence) removed. Shown
 * to a client with a coach.
 *
 * consult-consent-v5-coach-free / v6-coach-free (owner decision 62, Option 1,
 * 2026-10-12): v5 / v6 for a client with no coach, made only by removing every
 * coach sentence or clause, with no new words. One grammar join: paragraph
 * 3's "collect and use" becomes "collects and uses" once The Growth Project is
 * the only subject. Paragraph 4 + box 2 hash to the ledger's
 * client-ai-v4-coach-free / client-ai-v5-coach-free copy sha256.
 *
 * consult-consent-v7 / v8 (owner 57c, Option 1, 2026-10-12): v5 / v6 with the
 * safety-reply exception added to paragraph 4. Paragraph 4 + box 2 hash to the
 * ledger's client-ai-v6 / client-ai-v7 copy sha256. Shown to a client with a coach.
 *
 * consult-consent-v7-coach-free (owner 62y2, Option 1, 2026-10-12): the
 * coach-free screen without Roman: paragraph 4 and box 2 removed, and the
 * footer keeps only "Nothing is sent until you continue." (the rest named the
 * removed choice). A client with no coach makes no Roman choice here.
 *
 * consult-consent-v9 / v10 (CRISIS-APP-COPY, owner op 1, 2026-10-15): v7 / v8
 * with the approved crisis sentence right after the exception in paragraph 4.
 * Paragraph 4 + box 2 hash to the ledger's client-ai-v8 / client-ai-v9 copy
 * sha256. An app shows them only while GET /me/ai-consent?variant=crisis_alert
 * offers client-ai-v8 / v9 (FEATURE_ROMAN_CRISIS_ALERT on). The sentence comes
 * from roman.feature (no ledger import).
 *
 * v3 to v6 and the v5 / v6 coach-free versions stay accepted: installed app
 * builds still show and send them.
 *
 * consult-consent-v8-coach-free / v9-coach-free (W-CONSENT, FIX684,
 * 2026-10-15): what a client with no coach is shown since W-CONSENT put the
 * Roman choice back on that screen: v7-coach-free with "Before you join a
 * coach" and its lead after box 1, then v7 / v8's paragraph 4 and box 2
 * (memory off / on). Paragraph 4 + box 2 hash to the ledger's client-ai-v6 /
 * v7 copy sha256, the version box 2 grants. v7-coach-free stays accepted and
 * unchanged (#CRISIS-OLD-CONSENT op 1: older records stay as they are).
 */
import { createHash } from 'node:crypto';
import { ROMAN_CRISIS_TOLD_SENTENCE } from '../roman/roman.feature';

export const CONSULT_CONSENT_V3 = 'consult-consent-v3';
export const CONSULT_CONSENT_V4 = 'consult-consent-v4';
export const CONSULT_CONSENT_V5 = 'consult-consent-v5';
export const CONSULT_CONSENT_V6 = 'consult-consent-v6';
export const CONSULT_CONSENT_V5_COACH_FREE = 'consult-consent-v5-coach-free';
export const CONSULT_CONSENT_V6_COACH_FREE = 'consult-consent-v6-coach-free';
export const CONSULT_CONSENT_V7 = 'consult-consent-v7';
export const CONSULT_CONSENT_V8 = 'consult-consent-v8';
export const CONSULT_CONSENT_V7_COACH_FREE = 'consult-consent-v7-coach-free';
export const CONSULT_CONSENT_V9 = 'consult-consent-v9';
export const CONSULT_CONSENT_V10 = 'consult-consent-v10';

/** The displayed parts of one P0 screen version, in display order. */
export interface ConsultConsentCopy {
  title: string;
  /** Paragraphs 1-3, shown above box 1. */
  paragraphs: readonly string[];
  /** Box 1 (required): waiver + collection and use for coaching. */
  box1Label: string;
  /** Heading and lead after box 1, above paragraph 4 (no coach, W-CONSENT). Absent: none. */
  romanIntro?: readonly string[];
  /** Paragraph 4, shown above box 2 (Roman and AI, processed by Anthropic). Absent: no Roman choice. */
  aiParagraph?: string;
  /** Box 2 (optional, unticked by default). Never part of the P0 record. Absent with paragraph 4. */
  box2Label?: string;
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

/** consult-consent-v5: v3 without the clinic sentence (owner C-6a). */
export const CONSULT_CONSENT_COPY_V5: ConsultConsentCopy = {
  ...CONSULT_CONSENT_COPY_V3,
  paragraphs: [
    CONSULT_CONSENT_COPY_V3.paragraphs[0],
    CONSULT_CONSENT_COPY_V3.paragraphs[1],
    'To coach you, The Growth Project and your coach collect and use what you share here: your profile, this consultation including the screening questions, your targets, food and workout logs, check-ins, any health, sleep or wearable data you choose to connect, your messages with your coach, and posts you write in the community. We use it only to provide your training. We never sell it.',
  ],
};

/** consult-consent-v6: v4 without the clinic sentence (owner C-6a). */
export const CONSULT_CONSENT_COPY_V6: ConsultConsentCopy = {
  ...CONSULT_CONSENT_COPY_V5,
  aiParagraph: CONSULT_CONSENT_COPY_V4.aiParagraph,
};

/** consult-consent-v5-coach-free: v5 with every coach sentence or clause removed (owner 62). */
export const CONSULT_CONSENT_COPY_V5_COACH_FREE: ConsultConsentCopy = {
  ...CONSULT_CONSENT_COPY_V5,
  paragraphs: [
    CONSULT_CONSENT_COPY_V3.paragraphs[0],
    CONSULT_CONSENT_COPY_V3.paragraphs[1],
    'To coach you, The Growth Project collects and uses what you share here: your profile, this consultation including the screening questions, your targets, food and workout logs, check-ins, any health, sleep or wearable data you choose to connect, and posts you write in the community. We use it only to provide your training. We never sell it.',
  ],
  box1Label:
    'I agree to the training waiver, and to The Growth Project collecting and using my information to coach me.',
  aiParagraph:
    "Roman, the assistant in this app, is powered by Anthropic, a third-party AI provider. If you allow it, your information is sent to Anthropic so Roman can answer your questions. Only your own data is used, never another client's. Your conversations with Roman are kept until you delete them or delete your account.",
  box2Label: 'Optional: I allow Roman to use my information, processed by Anthropic.',
};

/** consult-consent-v6-coach-free: v6 with every coach sentence or clause removed (owner 62). */
export const CONSULT_CONSENT_COPY_V6_COACH_FREE: ConsultConsentCopy = {
  ...CONSULT_CONSENT_COPY_V5_COACH_FREE,
  aiParagraph:
    "Roman, the assistant in this app, is powered by Anthropic, a third-party AI provider. If you allow it, your information is sent to Anthropic so Roman can answer your questions. Roman may keep notes and summaries about your training, preferences and circumstances to personalise his replies. Deleting a chat removes its messages but not these notes; deleting your account removes them. Roman never shows you another client's information. Your conversations with Roman are kept until you delete them or delete your account.",
};

/** Owner 57c: the same sentence as the privacy page and the ledger's client-ai-v6 / v7. */
const SAFETY_EXCEPTION =
  'One exception: if Roman sends you an urgent medical safety reply or an eating-disorder safety reply, your coach sees the message that prompted it, so they can check in with you.';

/** consult-consent-v7: v5 with the exception after paragraph 4's last sentence (owner 57c). */
export const CONSULT_CONSENT_COPY_V7: ConsultConsentCopy = {
  ...CONSULT_CONSENT_COPY_V5,
  aiParagraph: `${CONSULT_CONSENT_COPY_V3.aiParagraph} ${SAFETY_EXCEPTION}`,
};

/** consult-consent-v8: v6 with the exception after "Your coach never sees ..." (owner 57c). */
export const CONSULT_CONSENT_COPY_V8: ConsultConsentCopy = {
  ...CONSULT_CONSENT_COPY_V6,
  aiParagraph:
    "Roman, the assistant in this app, is powered by Anthropic, a third-party AI provider. If you allow it, your information is sent to Anthropic so Roman can answer your questions and your coach can use AI drafts about your training. Roman may keep notes and summaries about your training, preferences and circumstances to personalise his replies. Deleting a chat removes its messages but not these notes; deleting your account removes them. Roman may also learn your coach's methods, including from your coach's private session notes, and information about your training may help with that without identifying you. Roman never quotes those notes or shows you another client's information. Your coach never sees your conversations with Roman or his notes about you. " +
    SAFETY_EXCEPTION +
    ' Your conversations with Roman are kept until you delete them or delete your account.',
};

/** consult-consent-v9 / v10: v7 / v8 with the crisis sentence after the exception (CRISIS-APP-COPY). */
const withCrisisSentence = (copy: ConsultConsentCopy): ConsultConsentCopy => ({
  ...copy,
  aiParagraph: (copy.aiParagraph ?? '').replace(
    SAFETY_EXCEPTION,
    `${SAFETY_EXCEPTION} ${ROMAN_CRISIS_TOLD_SENTENCE}`,
  ),
});
export const CONSULT_CONSENT_COPY_V9: ConsultConsentCopy = withCrisisSentence(CONSULT_CONSENT_COPY_V7);
export const CONSULT_CONSENT_COPY_V10: ConsultConsentCopy = withCrisisSentence(CONSULT_CONSENT_COPY_V8);

/** consult-consent-v7-coach-free: v5-coach-free without paragraph 4 and box 2 (owner 62y2). */
export const CONSULT_CONSENT_COPY_V7_COACH_FREE: ConsultConsentCopy = {
  title: CONSULT_CONSENT_COPY_V5_COACH_FREE.title,
  paragraphs: CONSULT_CONSENT_COPY_V5_COACH_FREE.paragraphs,
  box1Label: CONSULT_CONSENT_COPY_V5_COACH_FREE.box1Label,
  footer: 'Nothing is sent until you continue.',
};

/**
 * consult-consent-v8-coach-free / v9-coach-free (W-CONSENT, FIX684): v7-coach-free with the Roman
 * choice under "Before you join a coach", then v7 / v8's paragraph 4 and box 2 (memory off / on).
 */
export const CONSULT_CONSENT_V8_COACH_FREE = 'consult-consent-v8-coach-free';
export const CONSULT_CONSENT_V9_COACH_FREE = 'consult-consent-v9-coach-free';
const withRomanChoice = (coached: ConsultConsentCopy): ConsultConsentCopy => ({
  ...CONSULT_CONSENT_COPY_V7_COACH_FREE,
  romanIntro: [
    'Before you join a coach',
    'Roman works with a coach, so he is not available until you join one. If you allow this now, Roman is ready on the day you join and you will not be asked again.',
  ],
  aiParagraph: coached.aiParagraph,
  box2Label: coached.box2Label,
});
export const CONSULT_CONSENT_COPY_V8_COACH_FREE = withRomanChoice(CONSULT_CONSENT_COPY_V7);
export const CONSULT_CONSENT_COPY_V9_COACH_FREE = withRomanChoice(CONSULT_CONSENT_COPY_V8);
/** Their pins: screen text (aiSlice = v7 / v8 aiSlice = ledger client-ai-v6 / v7 copy sha256). */
export const CONSULT_CONSENT_V8_COACH_FREE_TEXT_SHA256 =
  '5369ee9c57412dd2233850a7cae2043a32645431ee3b3484a14c19b8c503c633';
export const CONSULT_CONSENT_V9_COACH_FREE_TEXT_SHA256 =
  '4a1e19730f3fab3b8a6a8119f5425cd3c0f6ed2f502d229d25dbb7fe5df35771';

/** Separator between displayed parts in every digest input. */
export const CONSULT_CONSENT_SEPARATOR = '\n\n';

/** Full screen text in display order (mobile `consentCopyText()`). */
export function consultConsentScreenText(copy: ConsultConsentCopy): string {
  return [
    copy.title,
    ...copy.paragraphs,
    copy.box1Label,
    ...(copy.romanIntro ?? []),
    ...(copy.aiParagraph === undefined ? [] : [copy.aiParagraph]),
    ...(copy.box2Label === undefined ? [] : [copy.box2Label]),
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
/** v5 / v6 pins: screen text (aiSlice = v3 / v4 aiSlice, unchanged). */
export const CONSULT_CONSENT_V5_TEXT_SHA256 =
  '926b4ec8abe6d003798b44d720f625aa69871f59b4963cc5ec39f8599c2255fa';
export const CONSULT_CONSENT_V6_TEXT_SHA256 =
  '6b15d88b6bf9b77f11c526f073936264c6253fbc54474a7cdd8c55b564f5e9ee';
/** Coach-free pins: screen text, and aiSlice = ledger client-ai-v4-coach-free / v5-coach-free copy sha256. */
export const CONSULT_CONSENT_V5_COACH_FREE_TEXT_SHA256 =
  'c56fc409ca188fdcd8a7f52209d72299e3bf19ea68bff0e01b35b1f3295826b5';
export const CONSULT_CONSENT_V5_COACH_FREE_AI_SLICE_SHA256 =
  '2a8c7973ba6047b58a0fdccb2604a796403d5b4773a6f6a73c98da3d84e68447';
export const CONSULT_CONSENT_V6_COACH_FREE_TEXT_SHA256 =
  'a1769134cf30a3208ef56a8906603d942fb2ca058db9c33c69f4ff14f223ee00';
export const CONSULT_CONSENT_V6_COACH_FREE_AI_SLICE_SHA256 =
  'c7cd7ebd3b47e3eb0e890a8efa932610c35716aa79ad4f139b6f0c0aad7128fe';
/** Owner 57c / 62y2 pins: screen text, and aiSlice = ledger client-ai-v6 / v7 copy sha256. */
export const CONSULT_CONSENT_V7_TEXT_SHA256 =
  '7711079209acecedfb50c31787787124af843f076154e9bfbd1e33550e861e09';
export const CONSULT_CONSENT_V7_AI_SLICE_SHA256 =
  '52066998fbccac128c78a68dc19c45c4e067d169c4b3e5aaaa0d7821a7a1ee38';
export const CONSULT_CONSENT_V8_TEXT_SHA256 =
  'b98e160e884aecdca059b90f7a88803ba84eeac79b692e83eba9f734f93274b2';
export const CONSULT_CONSENT_V8_AI_SLICE_SHA256 =
  '15c1b92f0c68e485d8e2c4d399c00eeb17a16291da8fae636260e085cada0842';
export const CONSULT_CONSENT_V7_COACH_FREE_TEXT_SHA256 =
  '82dddf635ee262e30e8a69e7a4a39be3e1255470d70b12e42a757f7578ee95a3';
/** CRISIS-APP-COPY pins: screen text, and aiSlice = ledger client-ai-v8 / v9 copy sha256. */
export const CONSULT_CONSENT_V9_TEXT_SHA256 =
  '1daf2cde65d223686b4bd60f786b85866f93714176dcc8781ff94b4c9f0e30bf';
export const CONSULT_CONSENT_V9_AI_SLICE_SHA256 =
  'af4cc4fa55aa72cab8e7c6cdcee881d6ba1f448df048088e47acd5e7d479e0ef';
export const CONSULT_CONSENT_V10_TEXT_SHA256 =
  '5f36acf2704699f1e7faa68d7c65b8b8ed1f1988d197774a61914b97f22ff512';
export const CONSULT_CONSENT_V10_AI_SLICE_SHA256 =
  '16074f18ce0e985e35ba7cfb3f12233cd993159585a35759c4580a730ed3c9dd';

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
  [CONSULT_CONSENT_V5]: {
    copy: CONSULT_CONSENT_COPY_V5,
    text_sha256: CONSULT_CONSENT_V5_TEXT_SHA256,
  },
  [CONSULT_CONSENT_V6]: {
    copy: CONSULT_CONSENT_COPY_V6,
    text_sha256: CONSULT_CONSENT_V6_TEXT_SHA256,
  },
  [CONSULT_CONSENT_V5_COACH_FREE]: {
    copy: CONSULT_CONSENT_COPY_V5_COACH_FREE,
    text_sha256: CONSULT_CONSENT_V5_COACH_FREE_TEXT_SHA256,
  },
  [CONSULT_CONSENT_V6_COACH_FREE]: {
    copy: CONSULT_CONSENT_COPY_V6_COACH_FREE,
    text_sha256: CONSULT_CONSENT_V6_COACH_FREE_TEXT_SHA256,
  },
  [CONSULT_CONSENT_V7]: {
    copy: CONSULT_CONSENT_COPY_V7,
    text_sha256: CONSULT_CONSENT_V7_TEXT_SHA256,
  },
  [CONSULT_CONSENT_V8]: {
    copy: CONSULT_CONSENT_COPY_V8,
    text_sha256: CONSULT_CONSENT_V8_TEXT_SHA256,
  },
  [CONSULT_CONSENT_V8_COACH_FREE]: {
    copy: CONSULT_CONSENT_COPY_V8_COACH_FREE,
    text_sha256: CONSULT_CONSENT_V8_COACH_FREE_TEXT_SHA256,
  },
  [CONSULT_CONSENT_V9_COACH_FREE]: {
    copy: CONSULT_CONSENT_COPY_V9_COACH_FREE,
    text_sha256: CONSULT_CONSENT_V9_COACH_FREE_TEXT_SHA256,
  },
  [CONSULT_CONSENT_V7_COACH_FREE]: {
    copy: CONSULT_CONSENT_COPY_V7_COACH_FREE,
    text_sha256: CONSULT_CONSENT_V7_COACH_FREE_TEXT_SHA256,
  },
  [CONSULT_CONSENT_V9]: {
    copy: CONSULT_CONSENT_COPY_V9,
    text_sha256: CONSULT_CONSENT_V9_TEXT_SHA256,
  },
  [CONSULT_CONSENT_V10]: {
    copy: CONSULT_CONSENT_COPY_V10,
    text_sha256: CONSULT_CONSENT_V10_TEXT_SHA256,
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
