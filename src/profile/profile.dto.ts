import {
  IsOptional,
  IsNumber,
  IsString,
  IsBoolean,
  IsIn,
  IsDateString,
  IsArray,
  IsInt,
  Min,
  Max,
} from 'class-validator';

// SECURITY: allow-list DTO for profile updates. The previous endpoint accepted
// `@Body() body: any` and spread it straight into prisma.userProfile.update, which
// let a client overwrite `user_id` (reassigning the profile to another account) as
// well as `macro_target_*` (bypassing the server's BMR/TDEE calculation).
// See audit C4. `user_id`, `id`, `updated_at` are deliberately absent from this
// DTO; ValidationPipe (whitelist + forbidNonWhitelisted) will strip them.
// Macro targets are also excluded because they are computed server-side by
// ProfileService.computeAndSaveMacros.
export class UpdateProfileDto {
  @IsOptional()
  @IsNumber()
  @Min(50)
  @Max(300)
  height_cm?: number;

  @IsOptional()
  @IsNumber()
  @Min(40)
  @Max(1000)
  current_weight_lbs?: number;

  @IsOptional()
  @IsNumber()
  @Min(40)
  @Max(1000)
  target_weight_lbs?: number;

  @IsOptional()
  @IsDateString()
  date_of_birth?: string;

  @IsOptional()
  @IsIn(['male', 'female', 'prefer_not_to_say'])
  sex?: 'male' | 'female' | 'prefer_not_to_say';

  @IsOptional()
  @IsIn(['sedentary', 'light', 'moderate', 'active', 'very_active'])
  activity_level?: 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active';

  @IsOptional()
  @IsIn(['fat_loss', 'muscle_gain', 'maintenance', 'performance'])
  goal_type?: 'fat_loss' | 'muscle_gain' | 'maintenance' | 'performance';

  @IsOptional()
  @IsIn(['beginner', 'intermediate', 'advanced'])
  workout_experience?: 'beginner' | 'intermediate' | 'advanced';

  @IsOptional()
  @IsBoolean()
  has_gym_membership?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  preferred_snacks?: string[];

  // The schema column is a free-form TEXT to keep room for future values
  // (low-FODMAP, halal, kosher) without a migration. New writes are
  // restricted to the curated list below; legacy values stored before the
  // list grew remain readable.
  @IsOptional()
  @IsString()
  @IsIn(['none', 'vegan', 'vegetarian', 'keto', 'pescatarian', 'paleo', 'other'])
  dietary_pattern?:
    | 'none'
    | 'vegan'
    | 'vegetarian'
    | 'keto'
    | 'pescatarian'
    | 'paleo'
    | 'other';

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  dietary_restrictions?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(7)
  workout_days_per_week?: number;

  @IsOptional()
  @IsString()
  avatar_url?: string;

  @IsOptional()
  @IsString()
  bio?: string;

  @IsOptional()
  @IsIn(['lbs', 'kg'])
  weight_unit?: 'lbs' | 'kg';

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(10)
  meals_per_day?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(500)
  water_goal_oz?: number;

  @IsOptional()
  @IsIn(['net', 'gross'])
  calorie_display?: 'net' | 'gross';

  @IsOptional()
  @IsBoolean()
  onboardingCompleted?: boolean;
}
