import { z } from 'zod';
import {
  CommunityMemberRoleSchema,
  CommunityNotifyLevelSchema,
} from './community-me.dto';
import { POSTING_POLICIES, SPACE_KINDS, SPACE_VISIBILITIES } from '../cohorts/community-cohort.dto';

export const CommunityCohortParamsSchema = z
  .object({
    cohortId: z.guid(),
  })
  .strict();

export type CommunityCohortParams = z.infer<typeof CommunityCohortParamsSchema>;

/** SC-PURPOSE-BE: a space's purpose as members read it. The coach writes it (trimmed, up to
 *  2,000 characters); none, or a cleared one (""), reads as null. */
export function spacePurpose(stored: string | null | undefined): string | null {
  return stored && stored.trim() !== '' ? stored : null;
}

// SC-PURPOSE-BE: string or null on both space reads; optional only until getCohorts and
// getCohort fill it.
const SpacePurposeSchema = z.string().nullable().optional();

const CommunityCohortSummarySchema = z
  .object({
    id: z.guid(),
    workspace_id: z.guid(),
    name: z.string(),
    is_default: z.boolean(),
    kind: z.enum(SPACE_KINDS),
    posting_policy: z.enum(POSTING_POLICIES),
    visibility: z.enum(SPACE_VISIBILITIES),
    description: SpacePurposeSchema,
    member_count: z.number().int().nonnegative(),
    my_role: CommunityMemberRoleSchema,
    unread_count: z.number().int().min(0).max(99).optional(), // SC-BE2: on GET /community/cohorts rows; 99 = 99+
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
    kind: z.enum(SPACE_KINDS),
    posting_policy: z.enum(POSTING_POLICIES),
    visibility: z.enum(SPACE_VISIBILITIES),
    description: SpacePurposeSchema,
    package_ids: z.array(z.string()).nullable(), // C6-ACCESS: the coach's view only; null to a member
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
