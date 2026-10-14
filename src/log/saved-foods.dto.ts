import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsIn, IsNumber, IsOptional } from 'class-validator';
import { IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';

// FOODSAVED: the most a client keeps. Server-side caps, not plan limits: the
// same for everyone (NOLOCK-R).
export const FAVORITES_MAX = 200;
export const SAVED_MEALS_MAX = 100;
export const SAVED_MEAL_ITEMS_MAX = 30;

// A name needs one visible character; trimmed before it is stored.
const HAS_TEXT = /\S/;

export class AddFavoriteDto {
  // The food the way POST /log/food takes it: a FoodItem id or a search id
  // ("usda_..." / "off_..."), resolved to a FoodItem before it is stored.
  @IsString()
  @MaxLength(128)
  food_item_id!: string;
}

/** One food in a saved meal, with the portion fields of LogFoodDto and its bounds. */
export class SavedMealItemDto {
  @IsString()
  @MaxLength(128)
  food_item_id!: string;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(50)
  quantity_multiplier?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100000)
  original_quantity?: number;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  original_unit?: string;
}

export class CreateSavedMealDto {
  @IsString()
  @MaxLength(80)
  @Matches(HAS_TEXT)
  name!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SAVED_MEAL_ITEMS_MAX)
  @ValidateNested({ each: true })
  @Type(() => SavedMealItemDto)
  items!: SavedMealItemDto[];
}

export class RenameSavedMealDto {
  @IsString()
  @MaxLength(80)
  @Matches(HAS_TEXT)
  name!: string;
}

/** Log every food of a saved meal into one meal slot of one day. */
export class LogSavedMealDto {
  @IsDateString()
  date!: string;

  @IsIn(['breakfast', 'lunch', 'dinner', 'snack'])
  meal_type!: 'breakfast' | 'lunch' | 'dinner' | 'snack';

  // Idempotency key, as on POST /log/food: a retry with the same key returns
  // the entries the first call wrote and writes nothing.
  @IsOptional()
  @IsString()
  @MaxLength(128)
  client_uuid?: string;
}
