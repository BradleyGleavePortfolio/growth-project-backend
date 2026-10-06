/**
 * Roman voice-policy constants — the operator-locked source of truth for every
 * Roman-voiced surface's copy and avatar crop (locked 2026-06-10).
 *
 * This module is the UNION of two waves that landed independently:
 *
 *   1. Roman Phase 2 (merged to main as e273c2e4) — the seven in-app
 *      notification surfaces (dunning Day 0/1/3/7, Day-10 lockout, paywall,
 *      billing-update, the ED.3 first-payment confirmation, the empty
 *      notification list, the onboarding welcome). These have a LEGACY variant
 *      (byte-for-byte what each surface returned before P2, pinned by a
 *      snapshot contract test) and a ROMAN_V2 variant (the locked Option-3
 *      brand voice), selected at call time by `FEATURE_ROMAN_COPY_V2`.
 *
 *   2. v1-6 coach community (this branch) — the five coach-community
 *      empty-state surfaces. These are greenfield (no pre-Roman predecessor),
 *      so each surface's LEGACY string is identical to its ROMAN_V2 string;
 *      `voice_variant` reports which map a payload was sourced from for
 *      analytics, not a copy difference.
 *
 * The two surface sets are UNIONED, never merged-away: `SurfaceKey` /
 * `SURFACE_KEYS` carry all fifteen entries, and every copy/crop map below
 * covers all of them. `COACH_COMMUNITY_SURFACE_KEYS` is the v1-6 subset the
 * coach empty-states controller/DTO iterate (so the coach response requires
 * ONLY the five coach surfaces, never the ten P2 notification surfaces).
 *
 * `VoicePolicyService.copyFor(surfaceKey, env)` composes a single surface
 * (flag-aware, per P2) and `allCopy(subset)` composes a set in one pass (used
 * by the coach empty-states controller over the coach subset).
 *
 * Copy rules (ROMAN_VOICE_POLICY §3/§4, enforced by the lint contract test):
 * calm authority, no exclamation points, no emoji, no "Sorry/Apologies"
 * openers, none of the soft-error filler words, second person, one next step,
 * optional `— Roman` sign-off on multi-line copy, never `— The TGP Team`.
 *
 * Token placeholders ({firstName}, {amount}, {cardLast4}, {lockoutDate}) follow
 * ROMAN_VOICE_POLICY §10b and are substituted by the consuming builder; this
 * module ships only the templates.
 */

/**
 * Approved avatar crops (the ROMAN_VOICE_POLICY §4 matrix subset the consuming
 * UIs render). Array form is exported so a Zod schema can `z.enum(AVATAR_CROPS)`
 * off the same source of truth.
 */
export const AVATAR_CROPS = ['monogram', 'smile', 'neutral'] as const;
export type AvatarCrop = (typeof AVATAR_CROPS)[number];

/**
 * Which copy map a payload was composed from (analytics signal / flag result).
 * Array form is exported for the same `z.enum(VOICE_VARIANTS)` reuse.
 */
export const VOICE_VARIANTS = ['legacy', 'roman_v2'] as const;
export type VoiceVariant = (typeof VOICE_VARIANTS)[number];

/**
 * Closed union of EVERY Roman-voiced surface — the union of the Phase 2
 * notification surfaces and the v1-6 coach-community empty-state surfaces.
 * (The coach lab surface was removed from v1-6 — it shipped no backend write —
 * so there is no `coach_community_lab_empty` key.)
 */
export type SurfaceKey =
  // ── Roman Phase 2 in-app notification surfaces ──────────────────────────
  | 'dunning_day0'
  | 'dunning_day1'
  | 'dunning_day3'
  | 'dunning_day7'
  | 'lockout_day10'
  | 'paywall'
  | 'billing_update'
  | 'first_payment_ed3'
  | 'empty_notifications'
  | 'onboarding_welcome'
  // ── v1-6 coach-community empty-state surfaces ───────────────────────────
  | 'coach_community_home_empty'
  | 'coach_community_inbox_empty'
  | 'coach_community_cohorts_empty'
  | 'coach_community_cohort_members_empty'
  | 'coach_community_moderation_empty';

/**
 * The composed payload returned to the UI for a single surface. NEVER a bare
 * string — `text` and `avatar_crop` always travel together so no downstream
 * channel can emit Roman's voice without his face.
 */
export interface RomanCopyPayload {
  /** The user-facing copy string (legacy or roman_v2 depending on the flag). */
  text: string;
  /** Which RomanAvatar crop the consuming UI should render. Always present. */
  avatar_crop: AvatarCrop;
  /** Surface key for telemetry. */
  surface_key: SurfaceKey;
  /** The variant resolved for this call (flag-aware for P2; analytics for v1-6). */
  voice_variant: VoiceVariant;
}

/** Every surface key, frozen, for exhaustive iteration in tests and the service. */
export const SURFACE_KEYS: readonly SurfaceKey[] = [
  // Phase 2
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
  // v1-6 coach community
  'coach_community_home_empty',
  'coach_community_inbox_empty',
  'coach_community_cohorts_empty',
  'coach_community_cohort_members_empty',
  'coach_community_moderation_empty',
] as const;

/**
 * The v1-6 coach-community subset of `SURFACE_KEYS`. The coach empty-states
 * controller composes and the DTO validates ONLY these five surfaces — the
 * coach response must never be forced to carry the ten P2 notification
 * surfaces (and vice-versa). Kept as a typed subset so a future coach surface
 * is added in exactly one place.
 */
export const COACH_COMMUNITY_SURFACE_KEYS = [
  'coach_community_home_empty',
  'coach_community_inbox_empty',
  'coach_community_cohorts_empty',
  'coach_community_cohort_members_empty',
  'coach_community_moderation_empty',
] as const;

export type CoachCommunitySurfaceKey =
  (typeof COACH_COMMUNITY_SURFACE_KEYS)[number];

/**
 * Money-failure / money-decision surfaces. Per ROMAN_VOICE_POLICY §4 these
 * NEVER render the `smile` crop — Roman delivers money news calmly, never
 * celebrating. The money-surface guard test asserts every key here resolves to
 * `neutral` in BOTH variants. (Coach-community surfaces are not money
 * surfaces; the cleared-moderation surface is intentionally celebratory.)
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
 * hint is always emitted. Moderation-cleared is the one celebratory coach
 * surface (`smile`); every other coach surface is `neutral`.
 */
export const AVATAR_CROP_BY_SURFACE: Readonly<Record<SurfaceKey, AvatarCrop>> = {
  // Phase 2
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
  // v1-6 coach community
  coach_community_home_empty: 'neutral',
  coach_community_inbox_empty: 'neutral',
  coach_community_cohorts_empty: 'neutral',
  coach_community_cohort_members_empty: 'neutral',
  coach_community_moderation_empty: 'smile',
} as const;

/**
 * LEGACY copy.
 *
 * Phase 2: byte-for-byte what each surface returned before P2 (dunning Day
 * 0/1/3/7 and lockout_day10 lifted verbatim from
 * `src/checkout/dunning-v2/dunning-v2.copy.ts` `straight` variant; the four
 * previously-string-less surfaces carry the plain non-Roman client copy). The
 * snapshot contract test pins all ten.
 *
 * v1-6 coach community: identical to ROMAN_V2 for these greenfield surfaces
 * (no pre-Roman predecessor exists). Kept as a distinct entry so the policy can
 * diverge later without a code change at the call sites.
 */
export const LEGACY: Readonly<Record<SurfaceKey, string>> = {
  // ── Phase 2: lifted verbatim from dunning-v2.copy.ts (DAY0_PUSH.straight) ─
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
  // ── Phase 2: previously-string-less surfaces: plain non-Roman client copy ─
  paywall:
    'This content requires an active subscription. Choose a plan to continue.',
  billing_update:
    'Your payment method needs attention. Please update your card to avoid an interruption to your access.',
  first_payment_ed3:
    'Your payment was successful. Your subscription is now active.',
  empty_notifications: 'You have no notifications.',
  onboarding_welcome:
    'Welcome to The Growth Project. Your account is ready and your coach has been notified.',
  // ── v1-6 coach community: greenfield, identical to ROMAN_V2 ───────────────
  coach_community_home_empty:
    'Quiet morning. When your cohorts need you, I will bring it here. — Roman',
  coach_community_inbox_empty:
    'The inbox is clear. When something needs you, it will be here.',
  coach_community_cohorts_empty:
    'No cohorts yet. The first one you build is the one your clients remember.',
  coach_community_cohort_members_empty:
    'This cohort is waiting. Invite the first client when you are ready. — Roman',
  coach_community_moderation_empty:
    'Nothing flagged. The room is running itself.',
} as const;

/**
 * ROMAN_V2 copy — the locked Roman Option-3 brand-voice variant per surface.
 *
 * Voice rules (ROMAN_VOICE_POLICY §3, enforced by the lint test):
 *   - Calm authority. No exclamation points anywhere.
 *   - Direct, never apologetic. No "Sorry" / "Apologies" openers.
 *   - Short sentences, second person, present tense.
 *   - One next step per message.
 *   - No emoji; none of the soft-error filler words (see lint contract).
 *   - Sometimes signs off "— Roman"; never "— The TGP Team".
 *
 * Token placeholders are preserved so the consuming builder substitutes them.
 */
export const ROMAN_V2: Readonly<Record<SurfaceKey, string>> = {
  // ── Phase 2 ───────────────────────────────────────────────────────────────
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
  // ── v1-6 coach community ──────────────────────────────────────────────────
  coach_community_home_empty:
    'Quiet morning. When your cohorts need you, I will bring it here. — Roman',
  coach_community_inbox_empty:
    'The inbox is clear. When something needs you, it will be here.',
  coach_community_cohorts_empty:
    'No cohorts yet. The first one you build is the one your clients remember.',
  coach_community_cohort_members_empty:
    'This cohort is waiting. Invite the first client when you are ready. — Roman',
  coach_community_moderation_empty:
    'Nothing flagged. The room is running itself.',
} as const;
