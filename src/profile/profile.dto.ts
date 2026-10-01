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
  MaxLength,
  ArrayMaxSize,
} from 'class-validator';

// Legacy mobile vocabularies (growth-project-mobile lib/finalizeLeanOnboarding,
// lib/profileCompletion, screens/client/EditProfileScreen). Both the legacy
// names and the lean names are listed so an older build never 400s.
export const LEGACY_PRIMARY_GOALS = [
  'lose_fast',
  'lose_moderate',
  'maintain',
  'gain',
  'gain_fast',
  'mobility',
  'lose_weight',
  'build_muscle',
  'fat_loss',
  'muscle_gain',
  'maintenance',
  'performance',
] as const;
export const LEGACY_FITNESS_LEVELS = [
  'beginner',
  'intermediate',
  'advanced',
  'new',
  'some',
  'experienced',
] as const;
export const LEGACY_DIET_TYPES = [
  'omnivore',
  'none',
  'vegetarian',
  'vegan',
  'pescatarian',
  'keto',
  'paleo',
  'mediterranean',
  'other',
] as const;
export const LEGACY_GYM_MEMBERSHIP = [
  'yes_regular',
  'yes_occasional',
  'home_gym',
  'no_gym',
] as const;

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
  dietary_pattern?: 'none' | 'vegan' | 'vegetarian' | 'keto' | 'pescatarian' | 'paleo' | 'other';

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  dietary_restrictions?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(7)
  workout_days_per_week?: number;

  // Granular equipment availability. `has_gym_membership` already answers
  // "gym vs no gym"; this list lets the AI workout-builder pick between
  // barbell, dumbbell-only, band, and bodyweight programming without a
  // follow-up clarifying question. The schema column is `String[]` so a
  // future token (e.g. "trx", "sandbag") does not require a migration;
  // new writes are restricted to the curated vocabulary below, and any
  // non-curated entry is rejected before it can land in the DB. An empty
  // array is the explicit "no extra equipment / bodyweight only" answer
  // once the client has actually answered — the prompt treats `[]` from
  // a fresh row as "unknown" because no write has occurred yet.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @IsIn(
    [
      'full_gym',
      'home_gym',
      'dumbbells',
      'kettlebells',
      'barbell',
      'resistance_bands',
      'pull_up_bar',
      'cardio_machine',
      'bodyweight_only',
      'other',
    ],
    { each: true },
  )
  equipment_access?: Array<
    | 'full_gym'
    | 'home_gym'
    | 'dumbbells'
    | 'kettlebells'
    | 'barbell'
    | 'resistance_bands'
    | 'pull_up_bar'
    | 'cardio_machine'
    | 'bodyweight_only'
    | 'other'
  >;

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

  // ── C05 additive allow-list (columns already exist on UserProfile) ─────
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  @ArrayMaxSize(20)
  injuries?: string[];

  @IsOptional()
  @IsIn(['morning', 'midday', 'evening', 'varies'])
  preferred_training_time?: 'morning' | 'midday' | 'evening' | 'varies';

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  @ArrayMaxSize(30)
  food_preferences?: string[];

  // ── C06: legacy mobile field names (lean onboarding, legacy results
  // screen, EditProfile). Before C06 these keys were not on the allow-list
  // and forbidNonWhitelisted rejected the whole request with a 400, so the
  // lean onboarding save never landed. They are now accepted and mapped onto
  // the canonical columns by ProfileService.mapLegacyFields; see
  // docs/profile-contract.md for the exact mapping. `null` means "not
  // answered" and never overwrites a stored value.
  //
  // Client-computed targets (tdee, calorie_target, protein_target,
  // carbs_target, fat_target) are accepted for compatibility and IGNORED:
  // the server computes targets with the single calculator.
  @IsOptional()
  @IsDateString()
  dob?: string | null;

  /** Interpreted in `weight_unit` when sent in the same body, else lbs. */
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(1000)
  current_weight?: number | null;

  /** Interpreted in `weight_unit` when sent in the same body, else lbs. */
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(1000)
  target_weight?: number | null;

  @IsOptional()
  @IsIn(LEGACY_PRIMARY_GOALS)
  primary_goal?: (typeof LEGACY_PRIMARY_GOALS)[number] | null;

  @IsOptional()
  @IsIn(LEGACY_FITNESS_LEVELS)
  fitness_level?: (typeof LEGACY_FITNESS_LEVELS)[number] | null;

  @IsOptional()
  @IsIn(LEGACY_DIET_TYPES)
  diet_type?: (typeof LEGACY_DIET_TYPES)[number] | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  @ArrayMaxSize(30)
  diet_restrictions?: string[] | null;

  @IsOptional()
  @IsIn(LEGACY_GYM_MEMBERSHIP)
  gym_membership?: (typeof LEGACY_GYM_MEMBERSHIP)[number] | null;

  @IsOptional()
  @IsBoolean()
  onboarding_completed?: boolean | null;

  /** Lean Q3 intent. Accepted and ignored (no column). */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  lean_intent?: string | null;

  // Accepted and ignored: the server is the only macro calculator.
  @IsOptional()
  @IsNumber()
  tdee?: number | null;

  @IsOptional()
  @IsNumber()
  calorie_target?: number | null;

  @IsOptional()
  @IsNumber()
  protein_target?: number | null;

  @IsOptional()
  @IsNumber()
  carbs_target?: number | null;

  @IsOptional()
  @IsNumber()
  fat_target?: number | null;
}
