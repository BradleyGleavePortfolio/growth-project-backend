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
 * The flag map. Keyed by the stable flag identifiers above; every value is a
 * server-evaluated boolean. Modelled as `z.record(string, boolean)` (per the
 * brief contract) rather than a fixed-key object so the mobile client tolerates
 * the server adding flags without a breaking schema change — the controller
 * always populates exactly FEATURE_FLAG_KEYS.
 */
export const FeatureFlagsResponseSchema = z
  .object({
    flags: z.record(z.string(), z.boolean()),
    evaluated_at: z.string().datetime(),
  })
  .strict();

export type FeatureFlagsResponseDto = z.infer<typeof FeatureFlagsResponseSchema>;
