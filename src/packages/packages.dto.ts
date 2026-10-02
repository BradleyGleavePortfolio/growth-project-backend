import { IsString, IsOptional, IsInt, IsBoolean, IsIn, Min, MaxLength } from 'class-validator';

export class CreatePackageDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  // Clinic C01 / S-FEE (B-629-1) — exactly 0 = a FREE package (one-time, no
  // recurring price; claimed via POST /v1/packages/:id/claim-free, never sent
  // to Stripe). The DTO only checks the shape (a whole, non-negative number of
  // cents); PackagesService owns the price rules so every refusal carries a
  // machine code: PACKAGE_PRICE_BELOW_MINIMUM (paid packages start at $19.99,
  // with minimum_cents), PACKAGE_FREE_MUST_BE_ONE_TIME, PACKAGE_INVALID.
  @IsInt({
    message:
      'amount_cents must be a whole number of cents, for example 1999 for $19.99, or 0 for free.',
  })
  @Min(0, { message: 'amount_cents must be 0 (free) or a positive number of cents.' })
  amount_cents!: number;

  // S-FEE round 4 (C-629-2): optional, like the service (which defaults to
  // 'usd'); the mobile editor did not send it and every create was a 400.
  @IsOptional()
  @IsString()
  @IsIn(['usd', 'gbp', 'eur', 'aud', 'cad'])
  currency?: string;

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
  // S-FEE — shape only; PackagesService refuses a recurring price under
  // $19.99 with PACKAGE_RECURRING_PRICE_BELOW_MINIMUM.
  @IsOptional()
  @IsInt({
    message: 'recurring_amount_cents must be a whole number of cents, for example 1999 for $19.99.',
  })
  @Min(0, { message: 'recurring_amount_cents must be a positive number of cents.' })
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

  // Clinic C01 / S-FEE — exactly 0 = free (see CreatePackageDto). Shape only;
  // PackagesService.update applies the price rules and the pricing lock.
  @IsOptional()
  @IsInt({
    message:
      'amount_cents must be a whole number of cents, for example 1999 for $19.99, or 0 for free.',
  })
  @Min(0, { message: 'amount_cents must be 0 (free) or a positive number of cents.' })
  amount_cents?: number;

  @IsOptional()
  @IsString()
  @IsIn(['usd', 'gbp', 'eur', 'aud', 'cad'])
  currency?: string;

  @IsOptional()
  @IsString()
  @IsIn(['one_time', 'recurring'])
  billing_type?: string;

  // S-FEE round 4 (B-629-4): pass null to clear the cadence (a one-time
  // package has none); switching billing_type to one_time clears it anyway.
  @IsOptional()
  @IsString()
  @IsIn(['week', 'month', 'year'])
  billing_interval?: string | null;

  // null resets the count to 1.
  @IsOptional()
  @IsInt()
  @Min(1)
  billing_interval_count?: number | null;

  // PR-6 B6 — duration_periods exposed on write. Pass `null` to
  // clear (unlimited). Validator allows int ≥ 1; the service treats
  // an explicit null in the input as "make this unlimited".
  @IsOptional()
  @IsInt()
  @Min(1)
  duration_periods?: number | null;

  // PR-6 decision #1 — optional second (recurring) price. Pass null
  // on any field to clear / drop the combo back to single-price.
  // S-FEE — shape only; the service refuses a recurring price under $19.99
  // with PACKAGE_RECURRING_PRICE_BELOW_MINIMUM.
  @IsOptional()
  @IsInt({
    message: 'recurring_amount_cents must be a whole number of cents, for example 1999 for $19.99.',
  })
  @Min(0, { message: 'recurring_amount_cents must be a positive number of cents.' })
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
