// TM-7 — Admin moderation DTOs (owner-only listing review).
// Responses are explicit allow-list shapes — no raw entity is ever spread.

import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

// Canonical JobListing status enum members (mirrors prisma `JobListingStatus`).
// Used both to validate the queue filter and to narrow it into Prisma's
// `where.status` without a raw cast.
export const LISTING_STATUS = ['draft', 'published', 'closed'] as const;
export type ListingStatus = (typeof LISTING_STATUS)[number];

// Keyset (created_at, id) tuple cursor query, optionally filtered by status.
// Status values are the canonical DB enum members for each queue so the filter
// maps directly onto the indexed column (no invented states).
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

  // Listing queue: draft | published | closed. Validated against the canonical
  // enum here (@IsIn), so an unknown value is rejected with a 400 at the
  // validation layer before it ever reaches Prisma.
  @IsOptional()
  @IsIn(LISTING_STATUS)
  status?: ListingStatus;
}

// A single review decision. Idempotent via the TM-4 ledger (Idempotency-Key
// header). `approved` advances the row; `rejected` closes/declines it.
export class ReviewDecisionDto {
  @IsIn(['approved', 'rejected'])
  decision!: 'approved' | 'rejected';

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  note?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  idempotency_key?: string;
}

// ── Response allow-list DTOs ────────────────────────────────────────────────

export interface ListingReviewCardDto {
  id: string;
  title: string;
  specialty: string | null;
  status: string;
  created_at: string;
}

export interface ReviewQueueResponse<T> {
  items: T[];
  next_cursor: string | null;
}

export interface ReviewDecisionResult {
  id: string;
  status: string;
  decision: 'approved' | 'rejected';
  // The reviewer's optional note, the acting owner, and the decision instant —
  // persisted to the idempotency ledger and round-tripped on replay so the
  // first-decision and replay responses share the exact same shape.
  note: string | null;
  decided_by: string;
  decided_at: string;
  replayed: boolean;
}
