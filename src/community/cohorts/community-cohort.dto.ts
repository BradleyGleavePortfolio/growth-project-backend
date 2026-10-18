import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { z } from 'zod';

// Trim incoming strings before validation so a whitespace-only name fails the
// MinLength(2) check rather than slipping through as "non-empty".
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

// Cohort lifecycle states a coach may set via the API (Prisma enum
// CommunityCohortStatus): PATCH moves draft↔active. C6-BVIS: DELETE is the one
// way to archive, since the rule closes a space on the archived_at it sets.
export const COHORT_WRITE_STATUSES = ['draft', 'active'] as const;
export type CohortWriteStatus = (typeof COHORT_WRITE_STATUSES)[number];

// C6-B1: the Prisma enums CommunitySpaceKind and CommunityPostingPolicy. A new
// announcement space takes the coach's messages only; any other starts open.
export const SPACE_KINDS = ['chat', 'announcement', 'section'] as const;
export const POSTING_POLICIES = ['all', 'coach'] as const;
// C6-BVIS: the Prisma enum CommunitySpaceVisibility, who a space opens to. A package
// space opens to the coach's clients with a live purchase of one of its package_ids.
export const SPACE_VISIBILITIES = ['public', 'clients', 'package', 'members'] as const;
export type SpaceVisibility = (typeof SPACE_VISIBILITIES)[number];

/** Who a space opens to; the same two fields on create and update. */
class SpaceAccessFields {
  @IsOptional()
  @IsIn(SPACE_VISIBILITIES)
  visibility?: SpaceVisibility;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  package_ids?: string[];
}

/** POST /community/workspaces/:workspaceId/cohorts — create a cohort. */
export class CreateCohortDto extends SpaceAccessFields {
  @Transform(trim)
  @IsString()
  @MinLength(2, { message: 'name must be at least 2 characters' })
  @MaxLength(120, { message: 'name must be 120 characters or fewer' })
  name!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000, { message: 'description must be 2000 characters or fewer' })
  description?: string;

  @IsOptional()
  @IsInt({ message: 'capacity must be an integer' })
  @Min(1, { message: 'capacity must be at least 1' })
  @Max(100_000, { message: 'capacity must be 100000 or fewer' })
  capacity?: number;

  @IsOptional()
  @IsISO8601({}, { message: 'starts_at must be an ISO 8601 timestamp' })
  starts_at?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'ends_at must be an ISO 8601 timestamp' })
  ends_at?: string;

  @IsOptional()
  @IsIn(SPACE_KINDS)
  kind?: (typeof SPACE_KINDS)[number];
}

/** PATCH /community/cohorts/:cohortId — update a cohort (all fields optional). */
export class UpdateCohortDto extends SpaceAccessFields {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2, { message: 'name must be at least 2 characters' })
  @MaxLength(120, { message: 'name must be 120 characters or fewer' })
  name?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000, { message: 'description must be 2000 characters or fewer' })
  description?: string;

  @IsOptional()
  @IsInt({ message: 'capacity must be an integer' })
  @Min(1, { message: 'capacity must be at least 1' })
  @Max(100_000, { message: 'capacity must be 100000 or fewer' })
  capacity?: number;

  @IsOptional()
  @IsISO8601({}, { message: 'starts_at must be an ISO 8601 timestamp' })
  starts_at?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'ends_at must be an ISO 8601 timestamp' })
  ends_at?: string;

  @IsOptional()
  @IsIn(COHORT_WRITE_STATUSES, { message: 'unsupported cohort status' })
  status?: CohortWriteStatus;

  @IsOptional()
  @IsIn(POSTING_POLICIES)
  posting_policy?: (typeof POSTING_POLICIES)[number];
}

// ── Response schema (Zod, matching the v1-2 .parse() convention) ───────────

export const CommunityCohortAdminSchema = z
  .object({
    id: z.guid(),
    workspace_id: z.guid(),
    name: z.string(),
    description: z.string().nullable(),
    status: z.enum(['draft', 'active', 'archived']),
    capacity: z.number().int().nullable(),
    starts_at: z.string().datetime().nullable(),
    ends_at: z.string().datetime().nullable(),
    sort_order: z.number().int(),
    kind: z.enum(SPACE_KINDS),
    posting_policy: z.enum(POSTING_POLICIES),
    visibility: z.enum(SPACE_VISIBILITIES),
    package_ids: z.array(z.string()),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    archived_at: z.string().datetime().nullable(),
  })
  .strict();

export type CommunityCohortAdminView = z.infer<
  typeof CommunityCohortAdminSchema
>;

export const CommunityCohortAdminResponseSchema = z
  .object({ cohort: CommunityCohortAdminSchema })
  .strict();

export type CommunityCohortAdminResponse = z.infer<
  typeof CommunityCohortAdminResponseSchema
>;
