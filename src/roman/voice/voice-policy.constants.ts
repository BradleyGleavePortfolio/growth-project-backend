/**
 * Roman Phase 2 — centralized Voice Policy copy (single source of truth).
 *
 * This module is the ONLY place the seven Phase 2 in-app notification surfaces
 * read their copy from. Each surface has two variants:
 *
 *   - `LEGACY`   — the exact string the surface returned BEFORE this PR. For the
 *                  dunning Day 0/1/3/7 pushes and the Day-10 lockout screen
 *                  these are lifted byte-for-byte from
 *                  `src/checkout/dunning-v2/dunning-v2.copy.ts` (the `straight`
 *                  variant, which is the current in-app default). For the four
 *                  surfaces that previously had NO backend copy (paywall,
 *                  billing-update, empty notification list, onboarding welcome)
 *                  the LEGACY value is the plain, non-Roman string the consuming
 *                  client renders today. A snapshot contract test pins every
 *                  LEGACY string so the flag-OFF path can never drift.
 *
 *   - `ROMAN_V2` — the locked Roman Option-3 brand-voice variant
 *                  (`ROMAN_VOICE_POLICY.md` §3). Calm authority, short
 *                  sentences, second person, one next step, no exclamation
 *                  points, no emoji, no apologies, no "Oops". A lint test
 *                  enforces these invariants across every ROMAN_V2 string.
 *
 * `VoicePolicyService.copyFor(surfaceKey)` selects between the two maps based on
 * `FEATURE_ROMAN_COPY_V2` and returns a `RomanCopyPayload` carrying both the
 * `text` AND the `avatar_crop` — Roman's voice is never emitted without his
 * face (operator-locked face+voice contract, 2026-06-10).
 *
 * Token placeholders ({firstName}, {amount}, {cardLast4}, {lockoutDate}) follow
 * ROMAN_VOICE_POLICY §10b and are substituted by the consuming builder; this
 * module ships only the templates.
 */

/** Every Phase 2 surface this PR owns. Seven logical surfaces, ten entries. */
export type SurfaceKey =
  | 'dunning_day0'
  | 'dunning_day1'
  | 'dunning_day3'
  | 'dunning_day7'
  | 'lockout_day10'
  | 'paywall'
  | 'billing_update'
  | 'first_payment_ed3'
  | 'empty_notifications'
  | 'onboarding_welcome';

/** The RomanAvatar crop the consuming UI renders alongside the copy. */
export type AvatarCrop = 'monogram' | 'smile' | 'neutral';

/** The active copy variant for a given `copyFor()` call (flag-aware). */
export type VoiceVariant = 'legacy' | 'roman_v2';

/**
 * The object `VoicePolicyService.copyFor()` returns. NEVER a bare string —
 * `text` and `avatar_crop` always travel together so no downstream channel can
 * emit Roman's voice without his face.
 */
export interface RomanCopyPayload {
  /** The user-facing copy string (legacy or Roman_v2 depending on the flag). */
  text: string;
  /** Which RomanAvatar crop the consuming UI should render. Always present. */
  avatar_crop: AvatarCrop;
  /** Surface key for telemetry. */
  surface_key: SurfaceKey;
  /** True variant resolved for this call (flag-aware). */
  voice_variant: VoiceVariant;
}

/** All surface keys, frozen, for exhaustive iteration in tests and the service. */
export const SURFACE_KEYS: readonly SurfaceKey[] = [
  'dunning_day0',
  'dunning_day1',
  'dunning_day3',
  'dunning_day7',
  'lockout_day10',
  'paywall',
  'billing_update',
  'first_payment_ed3',
  'empty_notifications',
  'onboarding_welcome',
] as const;

/**
 * Money-failure / money-decision surfaces. Per ROMAN_VOICE_POLICY §4 these
 * NEVER render the `smile` crop — Roman delivers money news calmly, never
 * celebrating. The money-surface guard test asserts every key here resolves to
 * `neutral` in BOTH variants.
 */
export const MONEY_SURFACES: readonly SurfaceKey[] = [
  'dunning_day0',
  'dunning_day1',
  'dunning_day3',
  'dunning_day7',
  'lockout_day10',
  'paywall',
  'billing_update',
] as const;

/**
 * Avatar crop per surface (locked, identical in both variants). The consuming
 * UI decides whether to render Roman at all based on `voice_variant`; the crop
 * hint is always emitted.
 */
export const AVATAR_CROP_BY_SURFACE: Readonly<Record<SurfaceKey, AvatarCrop>> = {
  dunning_day0: 'neutral',
  dunning_day1: 'neutral',
  dunning_day3: 'neutral',
  dunning_day7: 'neutral',
  lockout_day10: 'neutral',
  paywall: 'neutral',
  billing_update: 'neutral',
  first_payment_ed3: 'smile',
  empty_notifications: 'neutral',
  onboarding_welcome: 'smile',
} as const;

/**
 * LEGACY copy — byte-for-byte what each surface returned before this PR.
 *
 * dunning_day0/1/3/7 and lockout_day10 are the `straight` variants lifted
 * verbatim from `src/checkout/dunning-v2/dunning-v2.copy.ts`. The four
 * previously-string-less surfaces carry the plain non-Roman copy the client
 * renders today. The snapshot contract test pins all ten.
 */
export const LEGACY: Readonly<Record<SurfaceKey, string>> = {
  // ── lifted verbatim from dunning-v2.copy.ts (DAY0_PUSH.straight) ──────────
  dunning_day0:
    'A small matter, {firstName}: your payment did not go through. I will try again tomorrow. You need do nothing for now.',
  // DAY1_PUSH.straight
  dunning_day1:
    '{firstName}, your payment is still outstanding. I attempted it again today without success. Updating your card will settle it.',
  // DAY3_PUSH.straight
  dunning_day3:
    '{firstName}, your access is at risk. Three attempts have not cleared {amount}. Please update your card to keep things in order.',
  // DAY7_PUSH.straight
  dunning_day7:
    '{firstName}, this is the last reminder. Your payment of {amount} is still outstanding. Without it, your access will be locked in three days.',
  // LOCKOUT_SCREEN.straight
  lockout_day10:
    'The household ledger remains unsettled, {firstName}. Your payment of {amount} did not clear after several attempts. Access will resume the moment billing is current. Update your card to restore everything at once; I will be here when it is done.',
  // ── previously-string-less surfaces: plain non-Roman client copy ──────────
  paywall:
    'This content requires an active subscription. Choose a plan to continue.',
  billing_update:
    'Your payment method needs attention. Please update your card to avoid an interruption to your access.',
  first_payment_ed3:
    'Your payment was successful. Your subscription is now active.',
  empty_notifications: 'You have no notifications.',
  onboarding_welcome:
    'Welcome to The Growth Project. Your account is ready and your coach has been notified.',
} as const;

/**
 * ROMAN_V2 copy — the locked Roman Option-3 brand-voice variant per surface.
 *
 * Voice rules (ROMAN_VOICE_POLICY §3, enforced by the lint test):
 *   - Calm authority. No exclamation points anywhere.
 *   - Direct, never apologetic. No "Sorry" / "Apologies" openers.
 *   - Short sentences, second person, present tense.
 *   - One next step per message.
 *   - No emoji, no "Oops" / "Whoops" / "Uh oh".
 *   - Sometimes signs off "— Roman"; never "— The TGP Team".
 *
 * Token placeholders are preserved so the consuming builder substitutes them.
 */
export const ROMAN_V2: Readonly<Record<SurfaceKey, string>> = {
  dunning_day0:
    "Your last charge didn't go through, {firstName}. I tried once. I'll try again tomorrow. Take a look at your card on file when you have a moment.\n— Roman",
  dunning_day1:
    "Still outstanding, {firstName}. I tried again today, and the card on file held firm. Update it and I'll settle the rest.\n— Roman",
  dunning_day3:
    "Three tries now, {firstName}, and {amount} still hasn't cleared. Your access is at risk. Update your card today and you keep everything.\n— Roman",
  dunning_day7:
    "Day seven, {firstName}. The charge still hasn't cleared. If we don't connect soon, your access pauses. Easier to fix today.\n— Roman",
  lockout_day10:
    "Your access is paused, {firstName}. The ledger stayed unsettled despite my best efforts. Update your card to come back. I have your coach's seat warm.\n— Roman",
  paywall:
    "What's behind this needs a subscription. Pick a plan, and your coach picks up where you left off.\n— Roman",
  billing_update:
    "Your card needs attention, {firstName}. Update it now and your access carries on without a gap.\n— Roman",
  first_payment_ed3:
    "First charge cleared. Welcome, {firstName}. Your coach has been notified. They'll be in your inbox shortly.\n— Roman",
  empty_notifications:
    "Nothing in here. When something needs your attention, I'll bring it to you.\n— Roman",
  onboarding_welcome:
    "You're in, {firstName}. I'm Roman. I sit between you and your coach, and I make sure nothing gets dropped. Your coach has been pinged. Take a look around while I let them know.\n— Roman",
} as const;
