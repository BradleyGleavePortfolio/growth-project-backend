import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CreateMacroTargetDto } from './macros.dto';

// Activity multipliers for resting energy expenditure. Used by the
// quick-set preset endpoint. Values from Mifflin-St Jeor + standard
// activity factors; we round inputs to whole numbers in the response.
const ACTIVITY_FACTORS: Record<string, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

export type Goal = 'cut' | 'maintain' | 'bulk';

export interface PresetInput {
  weight_kg: number;
  height_cm: number;
  age_years: number;
  sex: 'male' | 'female';
  activity_level: keyof typeof ACTIVITY_FACTORS;
  goal: Goal;
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

  async createForClient(
    coachId: string,
    clientId: string,
    dto: CreateMacroTargetDto,
  ) {
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
  async getCurrentForSelf(userId: string) {
    return this.getCurrentForClient(userId);
  }

  // Coach-side read of a single target. 404 if missing or owned by a
  // different coach (privacy: same shape as a genuine miss).
  async getOneByCoach(coachId: string, targetId: string) {
    const t = await this.prisma.macroTarget.findFirst({
      where: { id: targetId, coach_id: coachId, archived_at: null },
    });
    if (!t) throw new NotFoundException('Macro target not found');
    return t;
  }

  async archiveByCoach(coachId: string, targetId: string) {
    const result = await this.prisma.macroTarget.updateMany({
      where: { id: targetId, coach_id: coachId, archived_at: null },
      data: { archived_at: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('Macro target not found');
    return { archived: result.count };
  }

  // Quick-set preset. Calculates a target from anthropometric inputs
  // using Mifflin-St Jeor BMR + activity factor + goal adjustment.
  // Output is purely advisory — the coach can edit before saving.
  computePreset(input: PresetInput): PresetOutput {
    const bmr =
      input.sex === 'male'
        ? 10 * input.weight_kg + 6.25 * input.height_cm - 5 * input.age_years + 5
        : 10 * input.weight_kg + 6.25 * input.height_cm - 5 * input.age_years - 161;
    const factor = ACTIVITY_FACTORS[input.activity_level] ?? 1.55;
    const tdee = bmr * factor;
    let kcal: number;
    if (input.goal === 'cut') kcal = tdee - 500;
    else if (input.goal === 'bulk') kcal = tdee + 350;
    else kcal = tdee;
    kcal = Math.max(800, Math.round(kcal));

    // Macro split: protein at 1.8 g/kg, fats at 25% of calories, carbs
    // fill the remainder. Fiber recommended at 14g/1000kcal.
    const protein_g = Math.round(input.weight_kg * 1.8);
    const fats_g = Math.round((kcal * 0.25) / 9);
    const carbs_g = Math.max(0, Math.round((kcal - protein_g * 4 - fats_g * 9) / 4));
    const fiber_g = Math.round((kcal / 1000) * 14);
    const rationale =
      `Mifflin-St Jeor BMR ${Math.round(bmr)} kcal, activity factor ${factor}, goal ${input.goal}. ` +
      'Protein 1.8 g/kg, fats 25% of kcal, carbs fill remainder. Fiber 14 g per 1000 kcal.';
    return { calories_kcal: kcal, protein_g, carbs_g, fats_g, fiber_g, rationale };
  }
}
