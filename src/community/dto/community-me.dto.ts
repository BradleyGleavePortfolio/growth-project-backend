import { z } from 'zod';

export const CommunityNotifyLevelSchema = z.enum(['live', 'digest', 'quiet']);
export type CommunityNotifyLevel = z.infer<typeof CommunityNotifyLevelSchema>;

// Membership role surfaced in the API. Gap G14: every UI-bound string says
// `client`, never `student` — the schema enum value `student` stays internal.
// The schema enum is `coach | assistant | student`; the API collapses
// `assistant` into `coach` and adds `owner` for the platform owner.
export const CommunityMemberRoleSchema = z.enum(['client', 'coach', 'owner']);
export type CommunityMemberRole = z.infer<typeof CommunityMemberRoleSchema>;

export const CommunityMeMembershipSchema = z
  .object({
    id: z.guid(),
    role: CommunityMemberRoleSchema,
    notify_level: CommunityNotifyLevelSchema,
    dm_enabled_effective: z.boolean(),
    last_read_message_at: z.string().datetime().nullable(),
    joined_at: z.string().datetime(),
  })
  .strict();

export const CommunityMeResponseSchema = z
  .object({
    feature_flag_state: z.enum(['enabled', 'disabled']),
    workspace_id: z.guid().nullable(),
    membership: CommunityMeMembershipSchema.nullable(),
    unread: z
      .object({
        cohort_messages: z.number().int().nonnegative(),
        dm_messages: z.number().int().nonnegative(),
        mentions: z.number().int().nonnegative(),
      })
      .strict(),
    flags: z
      .object({
        community_api: z.boolean(),
        community_dm: z.boolean(),
        community_realtime: z.boolean(),
        community_push: z.boolean(),
        community_telemetry: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type CommunityMeResponse = z.infer<typeof CommunityMeResponseSchema>;
