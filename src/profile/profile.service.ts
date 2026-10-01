import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma, type UserProfile } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { UpdateProfileDto } from './profile.dto';
import { computeMacros, LBS_PER_KG, resolveMacroInputs } from '../macros/macro-calculator';

@Injectable()
export class ProfileService {
  constructor(private prisma: PrismaService) {}

  async getProfile(userId: string) {
    const profile = await this.prisma.userProfile.findUnique({
      where: { user_id: userId },
    });

    if (!profile) {
      // Return empty profile shell
      return { user_id: userId };
    }

    return profile;
  }

  async updateProfile(userId: string, data: UpdateProfileDto, now: Date = new Date()) {
    // CRITICAL: height_cm stored ONLY in UserProfile — single source of truth
    // SECURITY: explicit allow-list mapping (audit C4). The controller DTO already
    // strips unknown fields via ValidationPipe, but we defend-in-depth by mapping
    // only the permitted fields into Prisma rather than spreading. This prevents
    // any future regression (e.g. DTO drift) from letting a client overwrite
    // `user_id`, `id`, `updated_at`, or any of the `macro_target_*` fields that
    // should be computed server-side by `computeAndSaveMacros`.
    const legacy = mapLegacyProfileFields(data);
    const allowed: Record<string, unknown> = {
      ...legacy,
      height_cm: data.height_cm,
      current_weight_lbs: data.current_weight_lbs ?? legacy.current_weight_lbs,
      target_weight_lbs: data.target_weight_lbs ?? legacy.target_weight_lbs,
      date_of_birth: data.date_of_birth ? new Date(data.date_of_birth) : legacy.date_of_birth,
      sex: data.sex,
      activity_level: data.activity_level,
      goal_type: data.goal_type ?? legacy.goal_type,
      workout_experience: data.workout_experience ?? legacy.workout_experience,
      has_gym_membership: data.has_gym_membership ?? legacy.has_gym_membership,
      preferred_snacks: data.preferred_snacks,
      dietary_pattern: data.dietary_pattern ?? legacy.dietary_pattern,
      dietary_restrictions: data.dietary_restrictions ?? legacy.dietary_restrictions,
      workout_days_per_week: data.workout_days_per_week,
      equipment_access: data.equipment_access,
      avatar_url: data.avatar_url,
      bio: data.bio,
      weight_unit: data.weight_unit,
      meals_per_day: data.meals_per_day,
      water_goal_oz: data.water_goal_oz,
      calorie_display: data.calorie_display,
      onboardingCompleted: data.onboardingCompleted ?? legacy.onboardingCompleted,
      injuries: data.injuries,
      preferred_training_time: data.preferred_training_time,
      food_preferences: data.food_preferences,
    };
    // Drop undefined AND null so a "not answered" never overwrites a stored
    // value (the legacy results screen sends `null` for every unanswered
    // field, and several columns are non-null enums).
    const payload: Prisma.UserProfileUncheckedUpdateInput & Prisma.UserProfileUncheckedCreateInput =
      { user_id: userId };
    for (const [k, v] of Object.entries(allowed)) {
      if (v !== undefined && v !== null) (payload as Record<string, unknown>)[k] = v;
    }

    // B606-1 / B606-2 / B606-3: the write and the recomputation are one
    // atomic, per-user serialised step (see writeProfileWithTargets). The
    // merged (stored + incoming) profile must carry every calculator input;
    // otherwise the contract's 409 `consultation_incomplete` is returned and
    // NOTHING is written. On success the same write stores the freshly
    // computed, floor-respecting targets and that row is returned, so the
    // PUT response, GET /profile and GET /me/macros/current agree.
    const written = await this.runSerialised((tx) =>
      writeProfileWithTargets(tx, userId, payload, now, 'require_complete'),
    );
    if (!written.ok) {
      throw new ConflictException({
        code: 'consultation_incomplete',
        message: 'Profile is missing inputs required to compute targets.',
        missing: written.missing,
      });
    }
    return written.row;
  }

  /**
   * Run a profile write transaction, retrying (bounded) when two FIRST
   * writes for the same user race on the unique `user_id` (P2002). On the
   * retry the winner's row exists, so the row lock serialises the loser
   * behind it and it re-merges onto the committed row.
   */
  private async runSerialised<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.prisma.$transaction(fn);
      } catch (err) {
        if (isUniqueViolation(err) && attempt < PROFILE_WRITE_MAX_ATTEMPTS) continue;
        throw err;
      }
    }
  }

  /**
   * Recompute the profile's targets with the single calculator
   * (src/macros/macro-calculator.ts). When any required input is missing the
   * stored targets are left untouched and nothing is invented: there are no
   * 180 lb / 175 cm / age-30 defaults any more.
   */
  async computeAndSaveMacros(userId: string, now: Date = new Date()) {
    return this.runSerialised(async (tx) => {
      await lockProfileRow(tx, userId);
      const profile = await tx.userProfile.findUnique({ where: { user_id: userId } });
      if (!profile) return null;
      const resolved = resolveMacroInputs(macroRawFromProfile(profile), now);
      if (!resolved.ok) return profile;
      const m = computeMacros(resolved.inputs);
      return tx.userProfile.update({
        where: { user_id: userId },
        data: targetColumns(m),
      });
    });
  }
}

/** Bounded attempts for a profile write that lost a first-row creation race. */
export const PROFILE_WRITE_MAX_ATTEMPTS = 3;

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * B606-3: take the per-user profile row lock for the rest of the caller's
 * transaction. Every writer of calculator inputs or targets
 * (PUT /profile, computeAndSaveMacros, the onboarding intake sync) calls
 * this FIRST, so read -> merge -> compute -> write is serialised per user:
 * a second writer blocks here until the first commits and then reads the
 * committed row (Postgres READ COMMITTED takes a fresh snapshot per
 * statement). When no row exists yet nothing is locked; two concurrent
 * first writes then collide on the unique `user_id` and the loser retries
 * (runSerialised / the caller's retry loop).
 */
export async function lockProfileRow(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "UserProfile" WHERE "user_id" = ${userId} FOR UPDATE`;
}

type ProfileRowLike = Record<string, unknown>;

/**
 * Columns a writer may set (UserProfile column names). Targets, ids and
 * ownership keys are stripped by writeProfileWithTargets; null/undefined
 * values never overwrite a stored value.
 */
export type ProfilePatch = Readonly<Record<string, unknown>>;

function macroRawFromProfile(p: ProfileRowLike) {
  return {
    current_weight_lbs: p.current_weight_lbs as number | null | undefined,
    target_weight_lbs: p.target_weight_lbs as number | null | undefined,
    height_cm: p.height_cm as number | null | undefined,
    date_of_birth: p.date_of_birth as Date | string | null | undefined,
    sex: p.sex as string | null | undefined,
    activity_level: p.activity_level as string | null | undefined,
    goal_type: p.goal_type as string | null | undefined,
  };
}

function targetColumns(m: { calories: number; protein_g: number; carbs_g: number; fat_g: number }) {
  return {
    macro_target_calories: m.calories,
    macro_target_protein_g: m.protein_g,
    macro_target_carbs_g: m.carbs_g,
    macro_target_fat_g: m.fat_g,
  };
}

export type ProfileWriteMode =
  /** PUT /profile: incomplete merged inputs -> nothing written, `missing` returned. */
  | 'require_complete'
  /**
   * Partial writers (onboarding intake sync): the fields are written; when
   * the merged row cannot be calculated the stored targets are cleared, so
   * a stored target ALWAYS equals the calculator applied to its own row.
   */
  | 'allow_incomplete';

export type ProfileWriteResult =
  { ok: true; row: UserProfile } | { ok: false; missing: string[]; row: UserProfile | null };

/**
 * The single profile write path (B606-3). Inside the caller's transaction:
 * lock the row, read the COMMITTED row, merge the patch, compute targets
 * from the merged row with the single calculator, and write fields and
 * targets together. Invariant: the stored targets are exactly
 * computeMacros(stored inputs), whatever the interleaving of writers.
 */
export async function writeProfileWithTargets(
  tx: Prisma.TransactionClient,
  userId: string,
  patch: ProfilePatch,
  now: Date,
  mode: ProfileWriteMode,
): Promise<ProfileWriteResult> {
  await lockProfileRow(tx, userId);
  const existing = await tx.userProfile.findUnique({ where: { user_id: userId } });
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    // Targets are server-computed only; never taken from a patch.
    if (k.startsWith('macro_target_') || k === 'user_id' || k === 'id') continue;
    if (v !== undefined && v !== null) clean[k] = v;
  }
  const merged: ProfileRowLike = { ...(existing ?? {}), ...clean };
  const resolved = resolveMacroInputs(macroRawFromProfile(merged), now);
  if (!resolved.ok && mode === 'require_complete') {
    return { ok: false, missing: resolved.missing, row: existing };
  }
  const targets = resolved.ok
    ? targetColumns(computeMacros(resolved.inputs))
    : {
        macro_target_calories: null,
        macro_target_protein_g: null,
        macro_target_carbs_g: null,
        macro_target_fat_g: null,
      };
  const data = { ...clean, ...targets };
  const row = existing
    ? await tx.userProfile.update({
        where: { user_id: userId },
        data: data as Prisma.UserProfileUncheckedUpdateInput,
      })
    : await tx.userProfile.create({
        data: { ...data, user_id: userId } as Prisma.UserProfileUncheckedCreateInput,
      });
  return resolved.ok ? { ok: true, row } : { ok: false, missing: resolved.missing, row };
}

const GOAL_FROM_LEGACY: Record<string, 'fat_loss' | 'muscle_gain' | 'maintenance' | 'performance'> =
  {
    lose_fast: 'fat_loss',
    lose_moderate: 'fat_loss',
    lose_weight: 'fat_loss',
    fat_loss: 'fat_loss',
    maintain: 'maintenance',
    maintenance: 'maintenance',
    mobility: 'maintenance',
    gain: 'muscle_gain',
    gain_fast: 'muscle_gain',
    build_muscle: 'muscle_gain',
    muscle_gain: 'muscle_gain',
    performance: 'performance',
  };

const EXPERIENCE_FROM_LEGACY: Record<string, 'beginner' | 'intermediate' | 'advanced'> = {
  beginner: 'beginner',
  new: 'beginner',
  intermediate: 'intermediate',
  some: 'intermediate',
  advanced: 'advanced',
  experienced: 'advanced',
};

/**
 * Legacy weight unit rule (docs/profile-contract.md):
 *   1. `weight_unit` in the same body wins ('kg' or 'lbs').
 *   2. Otherwise a payload carrying a lean-onboarding-only key
 *      (`fitness_level` or `lean_intent`) is kg: the lean writer
 *      (mobile lib/finalizeLeanOnboarding) stores weight in kg.
 *   3. Otherwise lbs (legacy results screen and EditProfile both send lbs).
 */
export function legacyWeightUnit(data: UpdateProfileDto): 'kg' | 'lbs' {
  if (data.weight_unit === 'kg' || data.weight_unit === 'lbs') return data.weight_unit;
  const hasLeanKey =
    (data.fitness_level !== undefined && data.fitness_level !== null) ||
    (data.lean_intent !== undefined && data.lean_intent !== null);
  return hasLeanKey ? 'kg' : 'lbs';
}

function toLbs(v: number | null | undefined, unit: 'kg' | 'lbs'): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
  const lbs = unit === 'kg' ? v * LBS_PER_KG : v;
  return Math.round(lbs * 10) / 10;
}

/**
 * Map the legacy mobile field names onto canonical UserProfile columns.
 * Pure; returns only the keys it could map (undefined otherwise). Canonical
 * names in the same body win over these (see updateProfile).
 */
export function mapLegacyProfileFields(data: UpdateProfileDto): {
  date_of_birth?: Date;
  current_weight_lbs?: number;
  target_weight_lbs?: number;
  goal_type?: 'fat_loss' | 'muscle_gain' | 'maintenance' | 'performance';
  workout_experience?: 'beginner' | 'intermediate' | 'advanced';
  dietary_pattern?: string;
  dietary_restrictions?: string[];
  has_gym_membership?: boolean;
  onboardingCompleted?: boolean;
} {
  const unit = legacyWeightUnit(data);
  const out: ReturnType<typeof mapLegacyProfileFields> = {};
  if (data.dob) out.date_of_birth = new Date(data.dob);
  const cw = toLbs(data.current_weight, unit);
  if (cw !== undefined) out.current_weight_lbs = cw;
  const tw = toLbs(data.target_weight, unit);
  if (tw !== undefined) out.target_weight_lbs = tw;
  if (data.primary_goal) out.goal_type = GOAL_FROM_LEGACY[data.primary_goal];
  if (data.fitness_level) out.workout_experience = EXPERIENCE_FROM_LEGACY[data.fitness_level];
  if (data.diet_type) {
    // 'omnivore' and 'mediterranean' are not on the canonical list: omnivore
    // is "no particular pattern"; mediterranean is stored as 'other'.
    out.dietary_pattern =
      data.diet_type === 'omnivore'
        ? 'none'
        : data.diet_type === 'mediterranean'
          ? 'other'
          : data.diet_type;
  }
  if (Array.isArray(data.diet_restrictions)) out.dietary_restrictions = data.diet_restrictions;
  // gym_membership maps onto the boolean only; it never overwrites a granular
  // equipment_access list.
  if (data.gym_membership) {
    out.has_gym_membership =
      data.gym_membership === 'yes_regular' || data.gym_membership === 'yes_occasional';
  }
  if (typeof data.onboarding_completed === 'boolean')
    out.onboardingCompleted = data.onboarding_completed;
  return out;
}
