import { IsString, IsOptional, IsInt, IsBoolean, IsIn, Min, MaxLength, IsNumber } from 'class-validator';
import { Transform } from 'class-transformer';

export class CreatePackageDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsInt()
  @Min(50) // 50 cents minimum
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

  @IsOptional()
  @IsInt()
  @Min(50)
  amount_cents?: number;

  @IsOptional()
  @IsString()
  @IsIn(['usd', 'gbp', 'eur', 'aud', 'cad'])
  currency?: string;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
