// TM-7b — Admin applicant-review DTOs (owner-only). The decision input shape and
// the queue/result envelopes are shared with the listing half, so they are
// re-exported from admin-moderation.dto rather than redefined. The queue QUERY
// is NOT shared: applications carry a different status enum, so a dedicated
// query DTO pins `@IsIn(APPLICATION_STATUS)` here instead of the listing enum.
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export {
  ReviewDecisionDto,
} from './admin-moderation.dto';
export type {
  ReviewQueueResponse,
  ReviewDecisionResult,
} from './admin-moderation.dto';

// Canonical ApplicationStatus enum members (mirrors prisma `ApplicationStatus`:
// submitted | screening | shortlisted | offered | placed | rejected |
// withdrawn). Used both to validate the queue filter and to narrow it onto
// Prisma's `where.status` without a raw cast — no invented states.
export const APPLICATION_STATUS = [
  'submitted',
  'screening',
  'shortlisted',
  'offered',
  'placed',
  'rejected',
  'withdrawn',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUS)[number];

// Keyset (created_at, id) tuple cursor query, optionally filtered by status.
// Structurally identical to the listing queue query, but the status filter is
// validated against the APPLICATION enum so the value narrows directly onto the
// indexed Application.status column. @IsIn stays for OpenAPI + class-validator
// metadata; the controller's ParseApplicationStatusPipe is the authoritative
// parse that yields the stable coded 400.
export class ReviewQueueQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @IsIn(APPLICATION_STATUS)
  status?: ApplicationStatus;
}

// Allow-list card for the application review queue — no raw entity is spread.
export interface ApplicationReviewCardDto {
  id: string;
  listing_id: string;
  status: string;
  fit_score: number | null;
  created_at: string;
}
