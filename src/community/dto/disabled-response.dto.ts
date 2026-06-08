import { z } from 'zod';

// Body returned with HTTP 503 by the kill switch for the gated endpoints
// (/workspaces/*, /cohorts/*). The always-on endpoints (/me, /today) instead
// return their normal envelope with feature_flag_state: 'disabled'.
export const CommunityDisabledResponseSchema = z
  .object({
    disabled: z.literal(true),
    retry_after: z.null(),
    error: z.literal('community.disabled'),
  })
  .strict();

export type CommunityDisabledResponse = z.infer<
  typeof CommunityDisabledResponseSchema
>;

export const COMMUNITY_DISABLED_BODY: CommunityDisabledResponse = {
  disabled: true,
  retry_after: null,
  error: 'community.disabled',
};
