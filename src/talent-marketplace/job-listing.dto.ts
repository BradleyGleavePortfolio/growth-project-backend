import {
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

// Compensation type mirrors the Prisma CoachCompensationType enum. Declared
// as a local string union (not imported from @prisma/client) so the DTO
// compiles before `prisma generate` runs in CI — the same idiom
// SubscriptionGuard uses for CoachTierValue.
export type CompensationTypeValue =
  | 'commission'
  | 'rev_share'
  | 'flat'
  | 'hybrid';

const COMPENSATION_TYPES: CompensationTypeValue[] = [
  'commission',
  'rev_share',
  'flat',
  'hybrid',
];

// compensation_terms is persisted as JSONB. Its required keys depend on
// compensation_type; the shape is validated server-side in JobListingService
// (validateCompensationTerms). We accept a free-form object here and narrow
// in the service so a bad shape yields a structured 400 rather than leaking
// an arbitrary blob into the column.
export class CreateJobListingDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  title!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(8_000)
  description!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  specialty?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  location?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  modality?: string | null;

  @IsEnum(COMPENSATION_TYPES)
  compensation_type!: CompensationTypeValue;

  @IsObject()
  compensation_terms!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(8_000)
  expectations?: string | null;
}

// Edit is a partial of create's mutable fields. Every field optional; the
// service applies only the keys present. compensation_type + terms are
// co-validated when either is supplied.
export class UpdateJobListingDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  title?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(8_000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  specialty?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  location?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  modality?: string | null;

  @IsOptional()
  @IsEnum(COMPENSATION_TYPES)
  compensation_type?: CompensationTypeValue;

  @IsOptional()
  @IsObject()
  compensation_terms?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(8_000)
  expectations?: string | null;
}
