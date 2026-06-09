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
    'Good day, {firstName}.\n\nYour payment of {amount} has not yet cleared. I attempted it again today, and it was declined. The card on file ends {cardLast4}.\n\nUpdate your payment method and I will see the rest sorted. Nothing else is required of you.\n\n— Roman, on behalf of {coachName}',
  dryRoman:
    "Good day, {firstName}.\n\nYour payment of {amount} remains unpersuaded. I tried once more today; the card ending {cardLast4} held firm.\n\nA fresh card usually settles the argument. I'll handle the rest.\n\n— Roman, on behalf of {coachName}",
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
    'Good day, {firstName}.\n\nYour payment of {amount} has now failed three times. If it remains unsettled, you will lose access to your programme. Update your card and I will restore everything at once.\n\n— Roman, on behalf of {coachName}',
  dryRoman:
    "Good day, {firstName}.\n\nThree attempts, three refusals. Your access is genuinely at risk now. Update the card and I'll put it all back the moment it clears.\n\n— Roman, on behalf of {coachName}",
};

export const DAY3_BLOCKER: BlockerCopy = {
  straight: {
    headline: 'You are going to lose access.',
    body: 'Your payment of {amount} has not cleared after three attempts, {firstName}. Update your card now and you will keep everything. If it stays unpaid, your access will be locked.',
    primaryCta: 'Update Payment',
    secondaryCta: 'Not now',
  },
  dryRoman: {
    headline: 'You are going to lose access.',
    body: "I have asked your card three times, {firstName}, and three times it's said no. Update it now and we'll forget this ever happened. Leave it, and the door locks.",
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
    'Good day, {firstName}.\n\nThis is the final notice. Your payment of {amount} remains unpaid after four attempts. In three days your access will be locked on {lockoutDate}. Update your card now and I will restore everything immediately.\n\n— Roman, on behalf of {coachName}',
  dryRoman:
    "Good day, {firstName}.\n\nThe final notice, and I do not send many. {amount} is still outstanding after four attempts. On {lockoutDate} the door locks. A working card stops it, and I'll have you back in at once.\n\n— Roman, on behalf of {coachName}",
};

export const DAY7_BLOCKER: BlockerCopy = {
  straight: {
    headline: 'Last chance before lockout.',
    body: 'Your payment of {amount} has failed four times, {firstName}. On {lockoutDate} your access will be locked. Update your card now to keep everything.',
    primaryCta: 'Update Payment',
    secondaryCta: 'Not now',
  },
  dryRoman: {
    headline: 'Last chance before lockout.',
    body: "Four attempts, {firstName}, and the card hasn't budged. On {lockoutDate} the door locks for good. One working card is all it takes, and I'll let you straight back in.",
    primaryCta: 'Update Payment',
    secondaryCta: 'Not now',
  },
};

// ── §C.5 Day 7 — coach notifications (all three channels) ────────────────────
export const COACH_INAPP: RomanVariantPair = {
  straight:
    "{clientName}'s payment failed — they will be locked out in 3 days.",
  dryRoman:
    "{clientName}'s payment has failed four times. They lock out in 3 days unless the card cooperates.",
};

export const COACH_PUSH: RomanVariantPair = {
  straight: '{clientName} payment failed — locks out in 3 days. Open to review.',
  dryRoman:
    "{clientName}'s card has run out of excuses. Lockout in 3 days. Tap to review.",
};

export const COACH_EMAIL: RomanVariantPair = {
  straight:
    'Good day, {coachName}.\n\nOne of your clients, {clientName}, has a payment that will not clear. I have attempted it four times and it remains unpaid. Unless it is settled, their access will be locked on {lockoutDate}.\n\nRetry history:\n• Day 0 — {amount} — declined ({reason})\n• Day 1 — {amount} — declined ({reason})\n• Day 3 — {amount} — declined ({reason})\n• Day 7 — {amount} — declined ({reason})\n\nYou may wish to reach out to them directly. The full record is here: {dunningDetailDeeplink}\n\n— Roman',
  dryRoman:
    "Good day, {coachName}.\n\n{clientName}'s card and I have had four conversations this week, none of them productive. {amount} is still outstanding, and their access locks on {lockoutDate}.\n\nRetry history:\n• Day 0 — {amount} — declined ({reason})\n• Day 1 — {amount} — declined ({reason})\n• Day 3 — {amount} — declined ({reason})\n• Day 7 — {amount} — declined ({reason})\n\nA word from you may carry more weight than mine has. The record is here: {dunningDetailDeeplink}\n\n— Roman",
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

// ── §C.8 Late-reversal copy (reversal_count ≥ 1) ─────────────────────────────
export const LR_DAY3_PUSH: RomanVariantPair = {
  straight:
    '{firstName}, your last payment update failed. You will be locked out in 3 days unless it is settled. Update your card to keep your access.',
  dryRoman:
    '{firstName}, the payment we thought was settled has come undone. Three days to a lockout. A fresh card sets it right.',
};

export const LR_DAY3_BLOCKER: BlockerCopy = {
  straight: {
    headline: 'Your last payment update failed.',
    body: 'The payment that restored your access has been reversed, {firstName}. You will be locked out in 3 days unless your card is updated. Update it now to keep everything.',
    primaryCta: 'Update Payment',
    secondaryCta: 'Not now',
  },
  dryRoman: {
    headline: 'Your last payment update failed.',
    body: "We have been here before, {firstName} — the payment came undone again. Three days until lockout. Update the card and I'll consider the matter closed, this time for good.",
    primaryCta: 'Update Payment',
    secondaryCta: 'Not now',
  },
};

export const LR_DAY7_ESCALATION: RomanVariantPair = {
  straight:
    'Good day, {firstName}. This is the second time a settled payment has come undone. Your access will be locked on {lockoutDate} unless {amount} clears. Update your card now and I will restore everything at once. — Roman, on behalf of {coachName}',
  dryRoman:
    "Good day, {firstName}. Twice now a payment has slipped through after I thought it settled. On {lockoutDate} the door locks. A working card ends the cycle, and I'll let you back in immediately. — Roman, on behalf of {coachName}",
};

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
  lateReversal: 'last payment update failed',
} as const;
