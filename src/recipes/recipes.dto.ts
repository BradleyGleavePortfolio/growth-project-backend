import {
  IsString,
  IsOptional,
  IsInt,
  IsNumber,
  IsArray,
  IsBoolean,
  IsIn,
  ArrayMaxSize,
  ArrayUnique,
  MaxLength,
  Min,
  Max,
  ValidateIf,
} from 'class-validator';
import { ALLERGEN_CODES } from './allergens';

export class CreateRecipeDto {
  @IsString()
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  /**
   * Accepted only as absent, null or blank. TGP has no recipe-photo storage,
   * so any link is refused with 400 RECIPE_IMAGE_URL_NOT_ALLOWED (see
   * recipe-access.ts). Kept in the contract so the refusal is specific
   * instead of a generic "property should not exist".
   */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  imageUrl?: string;

  @IsInt()
  @Min(0)
  @Max(600)
  prepTimeMin!: number;

  @IsInt()
  @Min(0)
  @Max(600)
  cookTimeMin!: number;

  @IsInt()
  @Min(1)
  @Max(100)
  servings!: number;

  @IsNumber()
  @Min(0)
  calories!: number;

  @IsNumber()
  @Min(0)
  protein!: number;

  @IsNumber()
  @Min(0)
  carbs!: number;

  @IsNumber()
  @Min(0)
  fat!: number;

  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  ingredients!: string[];

  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(2000, { each: true })
  instructions!: string[];

  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  tags!: string[];

  /**
   * Share with the creator's OWN clients. Never platform-wide: there is no
   * public recipe feed. Default false (private to the creator). Only a coach
   * or the owner account may send true; a client gets 403
   * RECIPE_SHARING_COACH_ONLY.
   */
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  /**
   * CF-ALLERGY-128: the allergens this recipe contains, as codes from the one
   * list (src/recipes/allergens.ts; GET /recipes/allergens). Required as an
   * array (an empty one is allowed) when `allergensDeclared` is true.
   */
  @ValidateIf((o: CreateRecipeDto) => o.allergens !== undefined || o.allergensDeclared === true)
  @IsArray()
  @ArrayMaxSize(ALLERGEN_CODES.length)
  @ArrayUnique()
  @IsIn([...ALLERGEN_CODES], { each: true })
  allergens?: string[];

  /**
   * true = the author confirms `allergens` lists every listed allergen the
   * recipe contains (an empty list then means none of them). Absent or false =
   * undeclared: the recipe is shown to clients labelled as undeclared, and
   * still hidden from a client whose saved allergen it lists.
   */
  @IsOptional()
  @IsBoolean()
  allergensDeclared?: boolean;
}
