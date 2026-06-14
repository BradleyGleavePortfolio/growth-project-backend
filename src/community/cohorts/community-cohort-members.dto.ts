import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { z } from 'zod';

const trimLower = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

// API-facing membership roles a coach may assign. `co_coach` maps onto the
// Prisma enum CommunityMembershipRole.assistant (the schema has no `co_coach`
// member); `student` maps 1:1. The owning coach's own `coach` row is never
// created/removed through these routes — only students and co-coaches.
export const ASSIGNABLE_MEMBER_ROLES = ['student', 'co_coach'] as const;
export type AssignableMemberRole = (typeof ASSIGNABLE_MEMBER_ROLES)[number];

/** POST /community/cohorts/:cohortId/members — invite/assign a member. */
export class AssignMemberDto {
  @IsOptional()
  @IsUUID(undefined, { message: 'user_id must be a UUID' })
  user_id?: string;

  @IsOptional()
  @Transform(trimLower)
  @IsEmail({}, { message: 'email must be a valid address' })
  @MaxLength(320, { message: 'email must be 320 characters or fewer' })
  email?: string;

  @IsIn(ASSIGNABLE_MEMBER_ROLES, { message: 'unsupported member role' })
  role!: AssignableMemberRole;
}

/** Cursor pagination + role filter query for the roster listing. */
export class ListMembersQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cursor?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  limit?: string;

  @IsOptional()
  @IsIn(['student', 'co_coach', 'coach'], { message: 'unsupported role filter' })
  role?: 'student' | 'co_coach' | 'coach';
}

// ── Response schemas (Zod) ─────────────────────────────────────────────────

// A coach sees full member rows; a non-coach member sees only the sanitized
// roster (id + display name + role). Sensitive fields (status, joined_at,
// email, notify_level) are coach-only — see CohortMembersService.memberView.
export const CohortMemberSchema = z
  .object({
    id: z.guid(),
    user_id: z.guid(),
    display_name: z.string(),
    role: z.enum(['student', 'co_coach', 'coach']),
    // Coach-only fields: null/absent in the sanitized roster view.
    status: z.enum(['invited', 'active', 'muted', 'removed']).nullable(),
    email: z.string().nullable(),
    joined_at: z.string().datetime().nullable(),
  })
  .strict();

export type CohortMemberView = z.infer<typeof CohortMemberSchema>;

export const CohortMemberListResponseSchema = z
  .object({
    members: z.array(CohortMemberSchema),
    next_cursor: z.string().nullable(),
  })
  .strict();

export type CohortMemberListResponse = z.infer<
  typeof CohortMemberListResponseSchema
>;

export const CohortMemberResponseSchema = z
  .object({ member: CohortMemberSchema })
  .strict();

export type CohortMemberResponse = z.infer<typeof CohortMemberResponseSchema>;
