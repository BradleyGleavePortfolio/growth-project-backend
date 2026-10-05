/**
 * B3 Smart Dunning v2 — Roman-voice copy (Option 3 LOCKED).
 *
 * Every string below is verbatim from the canonical spec
 * `strategy/B3_SMART_DUNNING_V2_GAPS_SPEC.md` §C (commit d194405b), authored
 * against `ROMAN_VOICE_POLICY.md` §3 (commit ffc8624e). Do NOT paraphrase,
 * reorder, or invent copy here — the spec §C is the single source of truth and
 * the auditor diffs these strings against it.
 *
 * Roman-voice rules applied (ROMAN_VOICE_POLICY §3, enforced by tests):
 *   - No emoji, no all-caps shouting, no second-person plural ("y'all").
 *   - Straight variant uses NO contractions ("you will", not "you'll");
 *     contractions are permitted ONLY in the dry-joke variant.
 *   - Dunning is a money-failure surface: avatar is `neutral` throughout,
 *     never `smile` (§4). No weak apologies ("I'm so sorry").
 *   - The dry quip is at the SITUATION's expense, never the client's.
 *   - Quip rate is operator-locked: client 0.125 (~1-in-8), coach 0.083
 *     (~1-in-12); never two quips in a row (enforced by the rotation layer).
 *
 * Tokens (ROMAN_VOICE_POLICY §10b): {firstName} {coachName} {clientName}
 * {amount} {cardLast4} {lockoutDate} {reason} {dunningDetailDeeplink}.
 */

/** Operator-locked Roman PostHog flags (ROMAN_VOICE_POLICY §5). Frozen. */
export const ROMAN_FLAGS = {
  roman_enabled: 'roman_enabled',
  roman_quip_rate_client: 0.125,
  roman_quip_rate_coach: 0.083,
} as const;

/** A copy item that ships a straight variant and a dry-Roman variant. */
export interface RomanVariantPair {
  straight: string;
  dryRoman: string;
}

/** In-app blocker copy has a headline + body + two CTA labels per variant. */
export interface BlockerVariant {
  headline: string;
  body: string;
  primaryCta: string;
  secondaryCta: string;
}

export interface BlockerCopy {
  straight: BlockerVariant;
  dryRoman: BlockerVariant;
}

// ── §C.1 Day 0 — push (card decline) ────────────────────────────────────────
export const DAY0_PUSH: RomanVariantPair = {
  straight:
    'A small matter, {firstName}: your payment did not go through. I will try again tomorrow. You need do nothing for now.',
  dryRoman:
    "A small matter, {firstName}: your card declined. I'll have another word with it tomorrow.",
};

// ── §C.2 Day 1 — push + email (retry) ───────────────────────────────────────
export const DAY1_PUSH: RomanVariantPair = {
  straight:
    '{firstName}, your payment is still outstanding. I attempted it again today without success. Updating your card will settle it.',
  dryRoman:
    '{firstName}, the payment and I are not yet on speaking terms. A fresh card would help our negotiations.',
};

export const DAY1_EMAIL: RomanVariantPair = {
  straight:
    'Good day, {firstName}.\n\nYour payment of {amount} has not yet cleared. The card on file ends {cardLast4}.\n\nA new card is charged the amount owed. Once that payment goes through, nothing else is required of you.\n\n— Roman, on behalf of {coachName}',
  dryRoman:
    "Good day, {firstName}.\n\nYour payment of {amount} remains unpersuaded. The card on file ends {cardLast4}.\n\nA fresh card is charged the amount owed, and once that clears, the argument is over.\n\n— Roman, on behalf of {coachName}",
};

// ── §C.3 Day 3 — push + email + in-app blocker ──────────────────────────────
export const DAY3_PUSH: RomanVariantPair = {
  straight:
    '{firstName}, your access is at risk. Three attempts have not cleared {amount}. Please update your card to keep things in order.',
  dryRoman:
    '{firstName}, your access is on thin ice. The card ending {cardLast4} and I have tried three times now.',
};

export const DAY3_EMAIL: RomanVariantPair = {
  straight:
    'Good day, {firstName}.\n\nYour payment of {amount} is still unpaid. If it remains unsettled, access to your programme pauses on {lockoutDate}. A new card is charged the amount owed, and once that payment goes through, everything stays as it is.\n\n— Roman, on behalf of {coachName}',
  dryRoman:
    "Good day, {firstName}.\n\n{amount} is still outstanding, and your access is genuinely at risk now: it pauses on {lockoutDate}. A new card is charged the amount owed, and the moment that clears, nothing changes.\n\n— Roman, on behalf of {coachName}",
};

export const DAY3_BLOCKER: BlockerCopy = {
  straight: {
    headline: 'You are going to lose access.',
    body: 'Your payment of {amount} has not cleared, {firstName}. A new card is charged the amount owed; once that goes through, you keep everything.',
    primaryCta: 'Update Payment',
    secondaryCta: 'Not now',
  },
  dryRoman: {
    headline: 'You are going to lose access.',
    body: "Your card has said no, {firstName}. A new one is charged the amount owed; once that clears, this is behind you. Leave it, and the door locks.",
    primaryCta: 'Update Payment',
    secondaryCta: 'Not now',
  },
};

// ── §C.4 Day 7 — push + email (last chance) + escalated blocker ──────────────
export const DAY7_PUSH: RomanVariantPair = {
  straight:
    '{firstName}, this is the last reminder. Your payment of {amount} is still outstanding. Without it, your access will be locked in three days.',
  dryRoman:
    '{firstName}, last call. The card ending {cardLast4} has had every chance. Three days until the lights go out.',
};

export const DAY7_EMAIL: RomanVariantPair = {
  straight:
    'Good day, {firstName}.\n\nThis is the final notice. Your payment of {amount} remains unpaid. Your access will be locked on {lockoutDate}. A new card is charged the amount owed, and once that payment goes through, your access stays on.\n\n— Roman, on behalf of {coachName}',
  dryRoman:
    "Good day, {firstName}.\n\nThe final notice, and I do not send many. {amount} is still outstanding. On {lockoutDate} the door locks. A working card is charged the amount owed, and once that clears, the door stays open.\n\n— Roman, on behalf of {coachName}",
};

export const DAY7_BLOCKER: BlockerCopy = {
  straight: {
    headline: 'Last chance before lockout.',
    body: 'Your payment of {amount} is still unpaid, {firstName}. Access locks on {lockoutDate}. A new card is charged; once that clears, you keep everything.',
    primaryCta: 'Update Payment',
    secondaryCta: 'Not now',
  },
  dryRoman: {
    headline: 'Last chance before lockout.',
    body: "The card hasn't budged, {firstName}. On {lockoutDate} the door locks. A working card is charged; once that clears, the door stays open.",
    primaryCta: 'Update Payment',
    secondaryCta: 'Not now',
  },
};

// ── §C.5 Day 7 — coach notifications (all three channels) ────────────────────
export const COACH_INAPP: RomanVariantPair = {
  straight:
    "{clientName}'s payment failed — they will be locked out in 3 days.",
  dryRoman:
    "{clientName}'s payment still refuses to clear. They lock out in 3 days unless the card cooperates.",
};

export const COACH_PUSH: RomanVariantPair = {
  straight: '{clientName} payment failed — locks out in 3 days. Open to review.',
  dryRoman:
    "{clientName}'s card has run out of excuses. Lockout in 3 days. Tap to review.",
};

export const COACH_EMAIL: RomanVariantPair = {
  straight:
    'Good day, {coachName}.\n\nOne of your clients, {clientName}, has a payment of {amount} that has not cleared. Unless it is settled, their access will be locked on {lockoutDate}.\n\nRetry history:\n• Day 0 — {amount} — declined\n• Charge attempts on this invoice so far: {attempts}\n\nYou may wish to reach out to them directly. The full record is in the app: open Clients, then {clientName}.\n\n— Roman',
  dryRoman:
    "Good day, {coachName}.\n\n{clientName}'s card and the payment have not made peace. {amount} is still outstanding, and their access locks on {lockoutDate}.\n\nRetry history:\n• Day 0 — {amount} — declined\n• Charge attempts on this invoice so far: {attempts}\n\nA word from you may carry more weight. The record is in the app: open Clients, then {clientName}.\n\n— Roman",
};

// ── §C.6 Day 10 — lockout screen ────────────────────────────────────────────
// Leads with the canonical "household ledger" stem. Dignified, never
// condescending (ROMAN_VOICE_POLICY §3.5).
export const LOCKOUT_SCREEN: RomanVariantPair = {
  straight:
    'The household ledger remains unsettled, {firstName}. Your payment of {amount} did not clear after several attempts. Access will resume the moment billing is current. Update your card to restore everything at once; I will be here when it is done.',
  dryRoman:
    "The door is locked, {firstName}. The ledger never did balance — {amount} stayed outstanding despite my best efforts. Set it right with a fresh card and I'll have you back inside straight away.",
};

export const LOCKOUT_SCREEN_ERROR: RomanVariantPair = {
  straight:
    'That card was declined as well. Try another, or contact support and I will see what can be arranged.',
  dryRoman:
    "That one declined too. We're nothing if not persistent. Try another card, or contact support.",
};

// ── §C.7 Recovery — expired link page ───────────────────────────────────────
export const EXPIRED_LINK: RomanVariantPair = {
  straight:
    'This link has expired, {firstName}. No harm done. Request a fresh one below and I will send it within the minute.',
  dryRoman:
    "This link has expired, {firstName}. Links, like milk, do not keep. Request a new one and I'll have it to you within the minute.",
};

// ── §C.8 Dispute (late-reversal) cycle copy ─────────────────────────────────
// R-DISPUTE-PAUSE (owner 10-04): a dispute ends access and pauses billing at
// once; only the coach restarts it. One variant (no quip); no amount.
// B-687-8: owner ruling 6 (10-05) pauses on an inquiry too, and an inquiry
// moves no money, so no line claims a reversal: the bank opened a dispute or
// inquiry (true for both). C-687-9: {coachName} never starts a sentence (its
// fallback is lower case).
const same = (text: string): RomanVariantPair => ({ straight: text, dryRoman: text });
export const LR_DAY3_PUSH: RomanVariantPair = same(
  '{firstName}, the bank opened a dispute or inquiry about a recent payment. Access has ended and billing is paused. Restarting it is up to {coachName}.',
);

const LR_BLOCKER: BlockerVariant = {
  headline: 'The bank opened a dispute or inquiry about a payment.',
  body: 'The bank opened a dispute or inquiry about a recent payment. Access has ended and billing is paused. Restarting it is up to {coachName}.',
  primaryCta: 'See details',
  secondaryCta: 'Not now',
};
export const LR_DAY3_BLOCKER: BlockerCopy = { straight: LR_BLOCKER, dryRoman: LR_BLOCKER };

export const LR_DAY7_ESCALATION: RomanVariantPair = same(
  'Good day, {firstName}.\n\nThe bank opened a dispute or inquiry about a recent payment for your plan with {coachName}. Access has ended and billing for the plan is paused.\n\nRestarting it is up to {coachName}. The dispute or inquiry closing does not restart it on its own.\n\n— Roman, on behalf of {coachName}',
);

export const LR_COACH_INAPP: RomanVariantPair = same(
  "{clientName}'s bank opened a dispute or inquiry about a recent payment. Their access has ended and billing for the plan is paused. Restarting is your decision.",
);
export const LR_COACH_PUSH: RomanVariantPair = same(
  '{clientName}: the bank opened a dispute or inquiry about a payment. Access has ended and billing is paused. Restarting is your decision.',
);
export const LR_COACH_EMAIL: RomanVariantPair = same(
  'Good day, {coachName}.\n\nThe bank of one of your clients, {clientName}, opened a dispute or inquiry about a recent payment. Their access has ended and billing for the plan is paused. It stays that way when the dispute or inquiry closes, whatever the outcome.\n\nRestarting access and billing is your decision. The full record is in the app: open Clients, then {clientName}.\n\n— Roman',
);

// Late-reversal Day-10 lockout copy is IDENTICAL to the regular lockout
// (§C.8 final line → §C.6). Re-export so callers do not branch.
export const LR_LOCKOUT_SCREEN = LOCKOUT_SCREEN;

/**
 * The canonical Roman stems the auditor greps for (R66 gate 5 / copy
 * assertions). Each maps to the day/surface that must contain it.
 */
export const ROMAN_STEMS = {
  day0: 'A small matter',
  day1: 'not yet on speaking terms',
  day3: 'going to lose access',
  day7: 'last chance before lockout',
  coach: 'locked out in 3 days',
  day10: 'household ledger',
  expired: 'Links, like milk',
  lateReversal: 'dispute or inquiry',
} as const;
