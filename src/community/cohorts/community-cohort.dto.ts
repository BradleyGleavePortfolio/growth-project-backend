import {
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

// Cohort lifecycle states a coach may set via the API. Mirrors the Prisma enum
// CommunityCohortStatus (draft | active | archived); `archived` is also driven
// by the DELETE route (soft archive), but PATCH may move draft↔active.
export const COHORT_WRITE_STATUSES = ['draft', 'active', 'archived'] as const;
export type CohortWriteStatus = (typeof COHORT_WRITE_STATUSES)[number];

/** POST /community/workspaces/:workspaceId/cohorts — create a cohort. */
export class CreateCohortDto {
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
}

/** PATCH /community/cohorts/:cohortId — update a cohort (all fields optional). */
export class UpdateCohortDto {
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
}

// ── Response schema (Zod, matching the v1-2 .parse() convention) ───────────

export const CommunityCohortAdminSchema = z
  .object({
    id: z.string().uuid(),
    workspace_id: z.string().uuid(),
    name: z.string(),
    description: z.string().nullable(),
    status: z.enum(['draft', 'active', 'archived']),
    capacity: z.number().int().nullable(),
    starts_at: z.string().datetime().nullable(),
    ends_at: z.string().datetime().nullable(),
    sort_order: z.number().int(),
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
