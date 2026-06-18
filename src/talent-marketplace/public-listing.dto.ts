import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';

// Page controls clamp 1..50 (default 20) so an unbounded set is never queried.
export const PUBLIC_LISTING_DEFAULT_LIMIT = 20;
export const PUBLIC_LISTING_MAX_LIMIT = 50;

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

// Coerce the string `limit` query param to a number before @IsInt: `?limit=20`
// is accepted, `abc`/`1.5`/`0` are rejected, missing stays undefined (-> default).
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

// PUBLIC PAYLOAD CONTRACT (binding — mobile TM-M2 + web TM-W2 consume this).
// Explicit allow-list: payloads copy ONLY the fields below off JobListing — the
// raw entity is NEVER spread, so hirer_id / idempotency_key / applicant data
// cannot leak. Adding a field is deliberate: confirm it is non-PII first.
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
