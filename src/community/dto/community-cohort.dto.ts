import { z } from 'zod';
import {
  CommunityMemberRoleSchema,
  CommunityNotifyLevelSchema,
} from './community-me.dto';

export const CommunityCohortParamsSchema = z
  .object({
    cohortId: z.guid(),
  })
  .strict();

export type CommunityCohortParams = z.infer<typeof CommunityCohortParamsSchema>;

const CommunityCohortSummarySchema = z
  .object({
    id: z.guid(),
    workspace_id: z.guid(),
    name: z.string(),
    is_default: z.boolean(),
    member_count: z.number().int().nonnegative(),
    my_role: CommunityMemberRoleSchema,
  })
  .strict();

export const CommunityCohortListResponseSchema = z
  .object({
    feature_flag_state: z.enum(['enabled', 'disabled']),
    cohorts: z.array(CommunityCohortSummarySchema),
  })
  .strict();

export type CommunityCohortListResponse = z.infer<
  typeof CommunityCohortListResponseSchema
>;

export const CommunityCohortResponseSchema = z
  .object({
    feature_flag_state: z.enum(['enabled', 'disabled']),
    id: z.guid(),
    workspace_id: z.guid(),
    name: z.string(),
    is_default: z.boolean(),
    member_count: z.number().int().nonnegative(),
    created_at: z.string().datetime(),
    my_membership: z
      .object({
        id: z.guid(),
        notify_level: CommunityNotifyLevelSchema,
        last_read_message_at: z.string().datetime().nullable(),
        joined_at: z.string().datetime(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type CommunityCohortResponse = z.infer<
  typeof CommunityCohortResponseSchema
>;
