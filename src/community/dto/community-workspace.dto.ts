import { z } from 'zod';

// Path-param input schema. Server never trusts client query params for tenant
// scope (gap G14) — only the resource id in the path is accepted here.
export const CommunityWorkspaceParamsSchema = z
  .object({
    workspaceId: z.string().uuid(),
  })
  .strict();

export type CommunityWorkspaceParams = z.infer<
  typeof CommunityWorkspaceParamsSchema
>;

export const CommunityWorkspaceResponseSchema = z
  .object({
    feature_flag_state: z.enum(['enabled', 'disabled']),
    id: z.string().uuid(),
    name: z.string(),
    owner_coach_user_id: z.string().uuid(),
    dm_enabled_default: z.boolean(),
    created_at: z.string().datetime(),
    access: z.enum(['owner', 'member', 'forbidden']),
  })
  .strict();

export type CommunityWorkspaceResponse = z.infer<
  typeof CommunityWorkspaceResponseSchema
>;
