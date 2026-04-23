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
  @Max(100)
  quantity_multiplier?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class UpdateLogEntryDto {
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(100)
  quantity_multiplier?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @IsOptional()
  @IsIn(['breakfast', 'lunch', 'dinner', 'snack'])
  meal_type?: 'breakfast' | 'lunch' | 'dinner' | 'snack';
}
