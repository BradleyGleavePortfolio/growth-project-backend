import {
  IsString,
  IsOptional,
  IsNumber,
  IsIn,
  IsArray,
  MaxLength,
  ArrayMaxSize,
  Min,
  Max,
} from 'class-validator';

// SECURITY: allow-list DTO for user-submitted food items. Previously the
// endpoint took `@Body() body: any` and spread into prisma.foodItem.create,
// which let a client set arbitrary fields including `id`, `barcode`, or
// `created_at`. FoodItem is a *shared* catalog, so writes reach every user.
// See audit C4 and the "spammable shared catalog" note.
const FOOD_CATEGORIES = ['generic', 'packaged', 'fast_food', 'restaurant', 'recipe_ingredient'] as const;
type FoodCategory = (typeof FOOD_CATEGORIES)[number];

export class CreateFoodDto {
  @IsString()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  brand_or_restaurant?: string;

  @IsOptional()
  @IsIn(FOOD_CATEGORIES)
  category?: FoodCategory;

  @IsString()
  @MaxLength(200)
  serving_description!: string;

  @IsNumber()
  @Min(0)
  @Max(100000)
  serving_size_grams!: number;

  @IsNumber()
  @Min(0)
  @Max(50000)
  calories!: number;

  @IsNumber()
  @Min(0)
  @Max(5000)
  protein_g!: number;

  @IsNumber()
  @Min(0)
  @Max(5000)
  carbs_g!: number;

  @IsNumber()
  @Min(0)
  @Max(5000)
  fat_g!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(5000)
  saturated_fat_g?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(5000)
  mono_fat_g?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(5000)
  poly_fat_g?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(5000)
  fiber_g?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(5000)
  sugar_g?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(500000)
  sodium_mg?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  search_aliases?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  image_url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  barcode?: string;
}
