import { z } from 'zod';

export const CommunityTodayResponseSchema = z
  .object({
    feature_flag_state: z.enum(['enabled', 'disabled']),
    cohort: z
      .object({
        id: z.string().uuid(),
        name: z.string(),
        member_count: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    event: z
      .object({
        id: z.string().uuid(),
        title: z.string(),
        starts_at: z.string().datetime(),
        live_url: z.string().nullable(),
      })
      .strict()
      .nullable(),
    pinned_post: z
      .object({
        id: z.string().uuid(),
        title: z.string(),
        author_user_id: z.string().uuid(),
      })
      .strict()
      .nullable(),
    challenge: z
      .object({
        id: z.string().uuid(),
        title: z.string(),
        ends_at: z.string().datetime(),
      })
      .strict()
      .nullable(),
    empty_reason: z
      .enum(['no_membership', 'no_today_content'])
      .nullable(),
  })
  .strict();

export type CommunityTodayResponse = z.infer<
  typeof CommunityTodayResponseSchema
>;
