// TM-9b — Specialty-alert DTOs. Request is an allow-list of saved specialties;
// the response carries public-listing fields only (no hirer/applicant PII).

import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

// POST /me/alerts/preferences — the specialties the applicant wants surfaced.
// The applicant's own `specialties` column IS the saved preference, so this is
// the only field; a coarse `location` filter was dropped (it was validated but
// never wired into matching — Lens A P2-2).
export class AlertPreferencesDto {
  // null and [] both clear the saved specialties (the service routes both
  // through normalizeSpecialties → []); omitting the field returns the current
  // set without writing. @IsOptional() skips validation for null/undefined,
  // while @IsArray() still rejects a non-null non-array (e.g. number/string).
  @ApiPropertyOptional({
    type: [String],
    nullable: true,
    maxItems: 20,
    description:
      'Specialties to surface as alerts. A provided list replaces the saved set (full replace, not a merge); use [] or null to clear. Omit the field to read the current set without writing.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  specialties?: string[] | null;
}

// A specialty-matched listing alert. No hirer PII — public listing fields only.
// published_at is non-null: the alert query filters `published_at: { not: null }`
// (P1-2), and the feed's keyset cursor sorts on it, so a matched card always
// carries a real timestamp.
export interface ListingAlertDto {
  listing_id: string;
  title: string;
  specialty: string | null;
  location: string | null;
  published_at: string;
}

// GET /me/alerts query — an opaque keyset cursor for the next page (omit for
// page 1). Capped to keep a hand-crafted blob bounded; a malformed value
// degrades to page 1 in the service rather than erroring.
export class AlertsQueryDto {
  @ApiPropertyOptional({
    type: String,
    description:
      'Opaque keyset cursor from a prior response next_cursor; omit for the first page.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}

// GET /me/alerts response envelope. The feed is keyset-paginated on
// (published_at, id), newest-first, in pages of ALERT_LISTING_LIMIT (20).
// next_cursor is an opaque base64url blob, or null when the last page is
// reached (P1-1, P2-2, P2-4).
export interface AlertsListResponseDto {
  items: ListingAlertDto[];
  next_cursor: string | null;
}
