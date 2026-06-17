import { z } from 'zod';

/**
 * D5 = B+γ — server-evaluated feature flags for the mobile client.
 *
 * `GET /me/feature-flags` returns a map of flag-key → boolean, evaluated
 * SERVER-SIDE for the authenticated caller, plus the evaluation timestamp.
 * The server is the source of truth: the mobile app reads these values at
 * boot and on foreground rather than carrying its own Expo-env copies (which
 * was the F2 defect the PR #251 audit raised — local flags drift from the
 * server gate). Unblocks the mobile `useFeatureFlags()` hook.
 *
 * The response envelope is `.strict()` so any unexpected key from a future
 * server change is caught by the `.parse()` at the controller return site
 * rather than silently shipping to clients.
 */

/**
 * The flag keys exposed to the mobile client. Stable snake_case identifiers —
 * the mobile hook reads `flags.community_search`, etc. Each key is driven by an
 * existing server-side env gate (see FeatureFlagsService.FLAG_SOURCES):
 *
 *   community_search                 ← FEATURE_COMMUNITY_SEARCH
 *   coach_community_wearable_prompts ← FEATURE_COMMUNITY_WEARABLE_PROMPTS (coach/owner only)
 *   community_classroom              ← FEATURE_COMMUNITY_CLASSROOM_POSTS
 *   community_events                 ← FEATURE_COMMUNITY_EVENTS
 *
 * All flags additionally require the community master gate
 * (FEATURE_COMMUNITY_API, via resolveCommunityFlag) — a flag cannot read
 * `true` for a caller who cannot reach community at all.
 */
export const FEATURE_FLAG_KEYS = [
  'community_search',
  'coach_community_wearable_prompts',
  'community_classroom',
  'community_events',
] as const;

export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[number];

/**
 * The flag map. A fixed-key object built from FEATURE_FLAG_KEYS so the contract
 * is enforced server-side: the response must contain EXACTLY those keys, each a
 * boolean. `.strict()` rejects any extra key and the required shape rejects a
 * missing one — so a future refactor that drops or renames a flag fails the
 * controller's `.parse()` instead of silently shipping a partial map.
 */
const FlagsShape = Object.fromEntries(
  FEATURE_FLAG_KEYS.map((key) => [key, z.boolean()]),
) as Record<FeatureFlagKey, z.ZodBoolean>;

export const FeatureFlagsResponseSchema = z
  .object({
    flags: z.object(FlagsShape).strict(),
    evaluated_at: z.iso.datetime(),
  })
  .strict();

export type FeatureFlagsResponseDto = z.infer<typeof FeatureFlagsResponseSchema>;
