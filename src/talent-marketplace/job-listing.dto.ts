import {
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

// Mirrors the Prisma CoachCompensationType enum as a local union so the DTO
// compiles before `prisma generate` runs (same idiom as CoachTierValue).
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

// compensation_terms is JSONB whose required keys depend on compensation_type;
// the shape is narrowed server-side in JobListingService.validateCompensationTerms
// so a bad shape yields a structured 400 rather than an arbitrary blob.
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

// Partial of create's mutable fields; the service applies only keys present.
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
