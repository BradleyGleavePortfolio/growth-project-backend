import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CreateMacroTargetDto } from './macros.dto';

import {
  ACTIVITY_FACTORS,
  computeMacros,
  LBS_PER_KG,
  resolveDisplayedTargets,
  type MacroActivity,
  type MacroGoal,
  type TargetsSource,
} from './macro-calculator';

export type Goal = 'cut' | 'maintain' | 'bulk';

export interface PresetInput {
  weight_kg: number;
  height_cm: number;
  age_years: number;
  sex: 'male' | 'female' | 'prefer_not_to_say';
  activity_level: MacroActivity;
  goal: Goal;
}

/**
 * GET /me/macros/current response. A live coach MacroTarget row is returned
 * unchanged plus `source: 'coach_target'`. When there is none, the profile's
 * server-computed targets are returned in the SAME field names with
 * `source: 'profile'` and `id: null`. `null` only when neither exists.
 */
export interface CurrentMacrosForSelf {
  id: string | null;
  client_id: string;
  coach_id: string | null;
  calories_kcal: number;
  protein_g: number;
  carbs_g: number;
  fats_g: number;
  fiber_g: number | null;
  notes: string | null;
  effective_from: Date | null;
  source: Exclude<TargetsSource, 'unset'>;
  /**
   * C05 item 8: 'simple' (calories + protein only) for the first 7 days
   * after onboarding when the client had never tracked food (N4 = never).
   * Carbs and fat are still computed and returned; only display changes.
   */
  macro_display_mode: 'simple' | 'full';
  simple_until: string | null;
}

export interface PresetOutput {
  calories_kcal: number;
  protein_g: number;
  carbs_g: number;
  fats_g: number;
  fiber_g: number;
  rationale: string;
}

@Injectable()
export class MacrosService {
  private readonly logger = new Logger(MacrosService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Coach -> client tenancy guard. Same 404-not-403 convention used in
  // MealPlansService / NudgesService: a foreign client must look exactly
  // like a missing one to a coach who is not their owner.
  private async assertClientOfCoach(coachId: string, clientId: string) {
    const client = await this.prisma.user.findFirst({
      where: { id: clientId, coach_id: coachId, role: 'student' },
      select: { id: true },
    });
    if (!client) throw new NotFoundException('Client not found');
  }

  async createForClient(coachId: string, clientId: string, dto: CreateMacroTargetDto) {
    await this.assertClientOfCoach(coachId, clientId);
    const effective = dto.effective_from ? new Date(dto.effective_from) : new Date();
    const target = await this.prisma.macroTarget.create({
      data: {
        coach_id: coachId,
        client_id: clientId,
        calories_kcal: dto.calories_kcal,
        protein_g: dto.protein_g,
        carbs_g: dto.carbs_g,
        fats_g: dto.fats_g,
        fiber_g: dto.fiber_g ?? null,
        notes: dto.notes ?? null,
        effective_from: effective,
      },
    });
    this.logger.log(
      `MacroTarget created coach=${coachId} client=${clientId} kcal=${dto.calories_kcal}`,
    );
    return target;
  }

  // History (newest first), excluding archived.
  async listForClientByCoach(coachId: string, clientId: string) {
    await this.assertClientOfCoach(coachId, clientId);
    return this.prisma.macroTarget.findMany({
      where: { client_id: clientId, archived_at: null },
      orderBy: { effective_from: 'desc' },
    });
  }

  // The "current" target for a client is the most recent row whose
  // effective_from is <= now. Returns null if no row qualifies.
  async getCurrentForClient(clientId: string) {
    return this.prisma.macroTarget.findFirst({
      where: {
        client_id: clientId,
        archived_at: null,
        effective_from: { lte: new Date() },
      },
      orderBy: { effective_from: 'desc' },
    });
  }

  // Client-side read: a client always reads their *own* current target.
  // Falls back to the profile's computed targets (C06) so Home, Log and
  // Macros read the same numbers whether or not a coach row exists yet.
  async getCurrentForSelf(
    userId: string,
    now: Date = new Date(),
  ): Promise<CurrentMacrosForSelf | null> {
    const base = await this.currentTargetsForSelf(userId);
    if (!base) return null;
    return { ...base, ...(await this.macroDisplay(userId, now)) };
  }

  private async macroDisplay(
    userId: string,
    now: Date,
  ): Promise<{ macro_display_mode: 'simple' | 'full'; simple_until: string | null }> {
    const intake = await this.prisma.clientOnboardingIntake.findUnique({
      where: { client_id: userId },
      select: { completion_result: true },
    });
    const r = intake?.completion_result;
    const until =
      r && typeof r === 'object' && !Array.isArray(r) && typeof r.simple_until === 'string'
        ? r.simple_until
        : null;
    if (!until) return { macro_display_mode: 'full', simple_until: null };
    return { macro_display_mode: now < new Date(until) ? 'simple' : 'full', simple_until: until };
  }

  private async currentTargetsForSelf(
    userId: string,
  ): Promise<Omit<CurrentMacrosForSelf, 'macro_display_mode' | 'simple_until'> | null> {
    const target = await this.getCurrentForClient(userId);
    if (target) {
      return {
        id: target.id,
        client_id: target.client_id,
        coach_id: target.coach_id,
        calories_kcal: target.calories_kcal,
        protein_g: target.protein_g,
        carbs_g: target.carbs_g,
        fats_g: target.fats_g,
        fiber_g: target.fiber_g,
        notes: target.notes,
        effective_from: target.effective_from,
        source: 'coach_target',
      };
    }
    const profile = await this.prisma.userProfile.findUnique({
      where: { user_id: userId },
      select: {
        macro_target_calories: true,
        macro_target_protein_g: true,
        macro_target_carbs_g: true,
        macro_target_fat_g: true,
        updated_at: true,
      },
    });
    const shown = resolveDisplayedTargets(null, profile);
    if (shown.source !== 'profile' || shown.calories === null) return null;
    return {
      id: null,
      client_id: userId,
      coach_id: null,
      calories_kcal: shown.calories,
      protein_g: shown.protein_g ?? 0,
      carbs_g: shown.carbs_g ?? 0,
      fats_g: shown.fat_g ?? 0,
      fiber_g: null,
      notes: null,
      effective_from: profile?.updated_at ?? null,
      source: 'profile',
    };
  }

  // Coach-side read of a single target. 404 if missing or the client is no
  // longer this coach's (privacy: same shape as a genuine miss). Scoped by
  // the client's current coach, not the coach who set the target.
  async getOneByCoach(coachId: string, targetId: string) {
    const t = await this.prisma.macroTarget.findFirst({
      where: { id: targetId, client: { coach_id: coachId }, archived_at: null },
    });
    if (!t) throw new NotFoundException('Macro target not found');
    return t;
  }

  async archiveByCoach(coachId: string, targetId: string) {
    const result = await this.prisma.macroTarget.updateMany({
      where: { id: targetId, client: { coach_id: coachId }, archived_at: null },
      data: { archived_at: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('Macro target not found');
    return { archived: result.count };
  }

  // Quick-set preset. Delegates to the single calculator
  // (macro-calculator.ts) so the coach preset, PUT /profile and onboarding
  // complete can never disagree. Output is advisory; the coach can edit
  // before saving. Unknown activity levels are rejected by the controller.
  computePreset(input: PresetInput): PresetOutput {
    const goal: MacroGoal =
      input.goal === 'cut' ? 'fat_loss' : input.goal === 'bulk' ? 'muscle_gain' : 'maintenance';
    const m = computeMacros({
      weight_lbs: input.weight_kg * LBS_PER_KG,
      height_cm: input.height_cm,
      age_years: input.age_years,
      sex: input.sex,
      activity_level: input.activity_level,
      goal,
    });
    const fiber_g = Math.round((m.calories / 1000) * 14);
    const factor = ACTIVITY_FACTORS[input.activity_level];
    const rationale =
      `Mifflin-St Jeor BMR ${m.bmr} kcal, activity factor ${factor}, goal ${input.goal}` +
      `${m.floor_applied ? `, raised to the ${m.floor_kcal} kcal floor` : ''}. ` +
      'Protein 1 g per lb of body weight, fats 25% of kcal, carbs fill remainder. Fiber 14 g per 1000 kcal.';
    return {
      calories_kcal: m.calories,
      protein_g: m.protein_g,
      carbs_g: m.carbs_g,
      fats_g: m.fat_g,
      fiber_g,
      rationale,
    };
  }
}
