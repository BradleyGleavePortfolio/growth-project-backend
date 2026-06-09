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

/**
 * Stable NAMED reaction-kind discriminator for each allowlisted emoji glyph.
 *
 * Realtime broadcast payloads must carry this opaque NAME (e.g. 'like',
 * 'fire'), NEVER the raw emoji glyph: the broadcast channel is treated as
 * untrusted and the no-PII/no-user-content doctrine forbids emoji strings on
 * the wire (see community-realtime.types.ts ReactionChangedPayloadSchema and
 * test/community/realtime/no-pii-in-broadcast.spec.ts). The glyph stays in the
 * DB `response_kind` column and in the authenticated REST refetch only.
 *
 * Keys are the exact allowlisted graphemes; the map is exhaustive over
 * COMMUNITY_REACTION_EMOJI.
 */
export const COMMUNITY_REACTION_KIND_BY_EMOJI: Readonly<
  Record<string, string>
> = {
  '\u{1F44D}': 'like', // 👍 thumbs up
  '\u{1F525}': 'fire', // 🔥 fire
  '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}': 'family', // 👨‍👩‍👧‍👦
  '\u2764\uFE0F': 'love', // ❤️ heart (VS16)
  '\u{1F389}': 'celebrate', // 🎉
  '\u{1F4AA}': 'strength', // 💪
  '\u{1F44F}': 'clap', // 👏
  '\u{1F602}': 'laugh', // 😂
  '\u{1F62E}': 'wow', // 😮
  '\u{1F622}': 'sad', // 😢
} as const;

/**
 * Resolve the opaque named reaction kind for an emoji glyph. Falls back to
 * 'other' for any value not in the map (the DTO @IsIn gate already rejects
 * non-allowlisted emoji with a 400, so 'other' is a defensive belt-and-braces
 * value that still never echoes the raw glyph onto the wire).
 */
export function reactionKindForEmoji(emoji: string): string {
  return COMMUNITY_REACTION_KIND_BY_EMOJI[emoji] ?? 'other';
}
