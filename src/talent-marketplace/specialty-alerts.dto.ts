// TM-9b — Specialty-alert DTOs. Request is an allow-list of saved specialties;
// the response carries public-listing fields only (no hirer/applicant PII).

import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

// POST /me/alerts/preferences — the specialties the applicant wants surfaced.
// The applicant's own `specialties` column IS the saved preference, so this is
// the only field; a coarse `location` filter was dropped (it was validated but
// never wired into matching — Lens A P2-2).
export class AlertPreferencesDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  specialties?: string[];
}

// A specialty-matched listing alert. No hirer PII — public listing fields only.
export interface ListingAlertDto {
  listing_id: string;
  title: string;
  specialty: string | null;
  location: string | null;
  published_at: string | null;
}
