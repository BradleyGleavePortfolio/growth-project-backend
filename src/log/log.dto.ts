import {
  IsString,
  IsOptional,
  IsNumber,
  IsIn,
  IsDateString,
  Min,
  Max,
  MaxLength,
} from 'class-validator';

// SECURITY: allow-list DTOs for food-log writes. Previously both endpoints
// accepted `@Body() body: any`; the update path spread the body into
// prisma.loggedFoodEntry.update, which would let a client overwrite `user_id`
// (reassigning an entry to another account) or set arbitrary dates. See audit
// C4/H10. ValidationPipe (whitelist + forbidNonWhitelisted) strips unknown fields.
export class LogFoodDto {
  @IsDateString()
  date!: string;

  @IsIn(['breakfast', 'lunch', 'dinner', 'snack'])
  meal_type!: 'breakfast' | 'lunch' | 'dinner' | 'snack';

  @IsString()
  @MaxLength(128)
  food_item_id!: string;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  // Tightened from 100 → 50. Mobile is contracted to pre-scale to
  // `nutrient_basis` (PER_100G / PER_SERVING) before sending; legitimate
  // values cluster well under 10 (e.g. 6 oz of chicken = 1.7008x). 50 caps
  // an obvious-mistake or buggy client. The wider bound let an attacker
  // submit a multiplier of 100 against a 700 kcal/100g item and contaminate
  // every coach dashboard / PTM signal / AI client-insight payload that
  // reads from LoggedFoodEntry. See QA P0-F1.
  @Max(50)
  quantity_multiplier?: number;

  // Trainerize-grade floor: persist what the user actually typed (e.g. 6 + "oz")
  // alongside the canonical quantity_multiplier so coach views read like
  // "6 oz chicken" instead of "1.7008x chicken". Both are optional and
  // pre-existing rows have nulls.
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100000)
  original_quantity?: number;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  original_unit?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class UpdateLogEntryDto {
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  // Tightened from 100 → 50. Mobile is contracted to pre-scale to
  // `nutrient_basis` (PER_100G / PER_SERVING) before sending; legitimate
  // values cluster well under 10 (e.g. 6 oz of chicken = 1.7008x). 50 caps
  // an obvious-mistake or buggy client. The wider bound let an attacker
  // submit a multiplier of 100 against a 700 kcal/100g item and contaminate
  // every coach dashboard / PTM signal / AI client-insight payload that
  // reads from LoggedFoodEntry. See QA P0-F1.
  @Max(50)
  quantity_multiplier?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @IsOptional()
  @IsIn(['breakfast', 'lunch', 'dinner', 'snack'])
  meal_type?: 'breakfast' | 'lunch' | 'dinner' | 'snack';
}
