import {
  IsString,
  IsOptional,
  IsInt,
  IsBoolean,
  IsIn,
  Min,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class CreatePackageDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  // Clinic C01 — 0 = a FREE package (claimed via POST /v1/packages/:id/claim-free,
  // never sent to Stripe). Any positive amount must be ≥ 50 cents (Stripe floor).
  @ValidateIf((o: CreatePackageDto) => o.amount_cents !== 0)
  @IsInt()
  @Min(50, { message: 'amount_cents must be 0 (free) or at least 50' })
  amount_cents!: number;

  @IsString()
  @IsIn(['usd', 'gbp', 'eur', 'aud', 'cad'])
  currency!: string;

  @IsString()
  @IsIn(['one_time', 'recurring'])
  billing_type!: string;

  @IsOptional()
  @IsString()
  @IsIn(['week', 'month', 'year'])
  billing_interval?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  billing_interval_count?: number;

  // PR-6 B6 — duration_periods exposed on write. null/omitted =
  // unlimited (lifetime entitlement); positive int = N periods of
  // entitlement (weeks for one-time programs, billing periods for
  // recurring). The webhook already consumes the column to compute
  // access_expires_at; this exposure just lets the editor set it.
  @IsOptional()
  @IsInt()
  @Min(1)
  duration_periods?: number;

  // PR-6 decision #1 — optional second (recurring) price. Setting
  // these fields turns the package into a one-time + recurring combo:
  // the PRIMARY price (amount_cents/billing_type) mints one Stripe
  // Price; this second config mints an additional recurring Stripe
  // Price. Leave these null/omitted for single-price packages.
  @IsOptional()
  @IsInt()
  @Min(50)
  recurring_amount_cents?: number;

  @IsOptional()
  @IsString()
  @IsIn(['week', 'month', 'year'])
  recurring_interval?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  recurring_interval_count?: number;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class UpdatePackageDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  // Clinic C01 — 0 = free (see CreatePackageDto). Note PackagesService.update
  // still applies its pricing-lock rules to any price change.
  @IsOptional()
  @ValidateIf((o: UpdatePackageDto) => o.amount_cents !== undefined && o.amount_cents !== 0)
  @IsInt()
  @Min(50, { message: 'amount_cents must be 0 (free) or at least 50' })
  amount_cents?: number;

  @IsOptional()
  @IsString()
  @IsIn(['usd', 'gbp', 'eur', 'aud', 'cad'])
  currency?: string;

  @IsOptional()
  @IsString()
  @IsIn(['one_time', 'recurring'])
  billing_type?: string;

  @IsOptional()
  @IsString()
  @IsIn(['week', 'month', 'year'])
  billing_interval?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  billing_interval_count?: number;

  // PR-6 B6 — duration_periods exposed on write. Pass `null` to
  // clear (unlimited). Validator allows int ≥ 1; the service treats
  // an explicit null in the input as "make this unlimited".
  @IsOptional()
  @IsInt()
  @Min(1)
  duration_periods?: number | null;

  // PR-6 decision #1 — optional second (recurring) price. Pass null
  // on any field to clear / drop the combo back to single-price.
  @IsOptional()
  @IsInt()
  @Min(50)
  recurring_amount_cents?: number | null;

  @IsOptional()
  @IsString()
  @IsIn(['week', 'month', 'year'])
  recurring_interval?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  recurring_interval_count?: number | null;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
