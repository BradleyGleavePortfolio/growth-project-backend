import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';

// TM-3 public browse page controls. Defaults mirror the community pagination
// idiom (clamp 1..50, default 20) so the database is never asked for an
// unbounded set by a hand-crafted request or an older client.
export const PUBLIC_LISTING_DEFAULT_LIMIT = 20;
export const PUBLIC_LISTING_MAX_LIMIT = 50;

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

// Query params arrive as strings; coerce `limit` to a number before @IsInt so
// `?limit=20` is accepted while `abc`/`1.5`/`0` are still rejected. A missing
// value stays undefined so the `?? DEFAULT` applies in the service.
const toIntLimit = ({ value }: { value: unknown }): unknown => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) return value;
    return Number(trimmed);
  }
  return value;
};

// Faceted filter + keyset cursor for GET /listings. All facets are optional
// free-text equality filters; `cursor` is the opaque next_cursor echoed back.
export class BrowseListingsQueryDto {
  @IsOptional()
  @Transform(toIntLimit)
  @IsInt({ message: 'limit must be an integer' })
  @Min(1, { message: 'limit must be at least 1' })
  @Max(PUBLIC_LISTING_MAX_LIMIT, {
    message: `limit must be ${PUBLIC_LISTING_MAX_LIMIT} or fewer`,
  })
  limit?: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  specialty?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(160)
  location?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  modality?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(40)
  compensation_type?: string;
}

/**
 * ── PUBLIC PAYLOAD CONTRACT (binding — mobile TM-M2 + web TM-W2 consume this) ──
 *
 * PII OMISSION: this is an explicit allow-list. The browse + detail payloads are
 * built by copying ONLY the fields below off the JobListing entity — the raw
 * entity is NEVER spread. hirer_id, idempotency_key, internal hirer contact, and
 * any applicant data MUST NOT appear here. Adding a field is a deliberate act:
 * confirm it is non-PII and safe for an unauthenticated audience.
 *
 * LUXURY DOCTRINE (Miller ≤5 visible elements, Hick's smart default, one primary
 * "Apply" tap, 3-taps-to-apply): the browse list returns the COMPACT card shape
 * (PublicListingCardDto) — title, specialty, location, a one-line comp summary,
 * and the cta_listing_id the Apply flow targets — so the mobile card stays
 * cognitively light. The detail payload (PublicListingDetailDto) carries the
 * full public blob plus the SAME single primary affordance: cta_listing_id is
 * the one obvious Apply target. One primary path, no competing CTAs.
 */
export interface PublicListingCardDto {
  id: string;
  title: string;
  specialty: string | null;
  location: string | null;
  modality: string | null;
  compensation_summary: string;
  published_at: string | null;
  // The single primary action affordance: the listing id the Apply flow targets.
  cta_listing_id: string;
}

export interface PublicListingDetailDto extends PublicListingCardDto {
  description: string;
  compensation_type: string;
  compensation_terms: Record<string, unknown>;
  expectations: string | null;
  created_at: string;
}

export interface BrowseListingsResponse {
  items: PublicListingCardDto[];
  next_cursor: string | null;
}
