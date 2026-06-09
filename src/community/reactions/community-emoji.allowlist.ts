/**
 * Canonical community reaction emoji allowlist.
 *
 * v1-1 proved (test/community/rls/community-v1-emoji-roundtrip.spec.ts) that the
 * `community_responses.response_kind` column roundtrips these exact graphemes
 * byte-for-byte, including the adversarial cases — the ZWJ "family" cluster and
 * the variation-selector heart. v1-1 left the set only in that test; v1-3 is the
 * first surface that WRITES reactions over HTTP, so this is the first runtime
 * home for the allowlist (a new definition, not a redefinition of a runtime
 * source — there was none). The roundtrip set is reproduced here verbatim and
 * extended with the common reaction emoji the product surface needs.
 *
 * Every value is ≤ 32 UTF-8 bytes so it fits the VARCHAR(32) response_kind
 * column. The DTO @IsIn(...) gate rejects anything outside this list with 400,
 * so the column can never receive an unbounded or non-emoji string.
 */

// The v1-1 roundtrip set (verbatim) plus the everyday reaction emoji.
export const COMMUNITY_REACTION_EMOJI: readonly string[] = [
  '👍', // thumbs up — v1-1 roundtrip
  '🔥', // fire — v1-1 roundtrip
  '👨‍👩‍👧‍👦', // ZWJ family cluster — v1-1 roundtrip (adversarial)
  '❤️', // heart with VS16 — v1-1 roundtrip (adversarial)
  '🎉', // celebrate
  '💪', // strength
  '👏', // clap
  '😂', // laugh
  '😮', // wow
  '😢', // sad
];

export type CommunityReactionEmoji = (typeof COMMUNITY_REACTION_EMOJI)[number];

/** True when `value` is an allowlisted reaction emoji. */
export function isAllowedReactionEmoji(value: string): boolean {
  return COMMUNITY_REACTION_EMOJI.includes(value);
}
