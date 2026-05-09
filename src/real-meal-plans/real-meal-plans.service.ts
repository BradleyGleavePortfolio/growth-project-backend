import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {
  AssignDailyPlanDto,
  CreateDailyMealPlanDto,
  CreateMealTemplateDto,
  UpdateDailyMealPlanDto,
  UpdateMealTemplateDto,
  DailyPlanSlotInputDto,
} from './real-meal-plans.dto';

@Injectable()
export class RealMealPlansService {
  private readonly logger = new Logger(RealMealPlansService.name);
  constructor(private readonly prisma: PrismaService) {}

  // ─── Tenancy guards ──────────────────────────────────────────────────
  private async assertClientOfCoach(coachId: string, clientId: string) {
    const c = await this.prisma.user.findFirst({
      where: { id: clientId, coach_id: coachId, role: 'student' },
      select: { id: true },
    });
    if (!c) throw new NotFoundException('Client not found');
  }

  private async assertTemplateOwnedBy(coachId: string, templateId: string) {
    const t = await this.prisma.mealTemplate.findFirst({
      where: { id: templateId, coach_id: coachId, archived_at: null },
      select: { id: true },
    });
    if (!t) throw new NotFoundException('Meal template not found');
  }

  private async assertPlanOwnedBy(coachId: string, planId: string) {
    const p = await this.prisma.dailyMealPlan.findFirst({
      where: { id: planId, coach_id: coachId, archived_at: null },
      select: { id: true },
    });
    if (!p) throw new NotFoundException('Daily meal plan not found');
  }

  // ─── MealTemplate CRUD ───────────────────────────────────────────────
  async createTemplate(coachId: string, dto: CreateMealTemplateDto) {
    return this.prisma.mealTemplate.create({
      data: {
        coach_id: coachId,
        name: dto.name,
        description: dto.description ?? null,
        calories_kcal: dto.calories_kcal,
        protein_g: dto.protein_g,
        carbs_g: dto.carbs_g,
        fats_g: dto.fats_g,
        fiber_g: dto.fiber_g ?? null,
        items: (dto.items ?? null) as unknown as object | null,
      },
    });
  }

  async listTemplates(coachId: string) {
    return this.prisma.mealTemplate.findMany({
      where: { coach_id: coachId, archived_at: null },
      orderBy: { created_at: 'desc' },
    });
  }

  async getTemplate(coachId: string, templateId: string) {
    await this.assertTemplateOwnedBy(coachId, templateId);
    return this.prisma.mealTemplate.findUnique({ where: { id: templateId } });
  }

  async updateTemplate(
    coachId: string,
    templateId: string,
    dto: UpdateMealTemplateDto,
  ) {
    await this.assertTemplateOwnedBy(coachId, templateId);
    return this.prisma.mealTemplate.update({
      where: { id: templateId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.calories_kcal !== undefined && { calories_kcal: dto.calories_kcal }),
        ...(dto.protein_g !== undefined && { protein_g: dto.protein_g }),
        ...(dto.carbs_g !== undefined && { carbs_g: dto.carbs_g }),
        ...(dto.fats_g !== undefined && { fats_g: dto.fats_g }),
        ...(dto.fiber_g !== undefined && { fiber_g: dto.fiber_g }),
        ...(dto.items !== undefined && {
          items: dto.items as unknown as object,
        }),
      },
    });
  }

  async archiveTemplate(coachId: string, templateId: string) {
    const result = await this.prisma.mealTemplate.updateMany({
      where: { id: templateId, coach_id: coachId, archived_at: null },
      data: { archived_at: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('Meal template not found');
    return { archived: result.count };
  }

  // ─── DailyMealPlan CRUD ──────────────────────────────────────────────

  // Validate that every meal_template_id referenced by `slots` belongs
  // to this coach. Done in one round-trip to keep big plans cheap.
  private async validateSlotTemplates(
    coachId: string,
    slots: DailyPlanSlotInputDto[],
  ) {
    if (slots.length === 0) return;
    const ids = Array.from(new Set(slots.map((s) => s.meal_template_id)));
    const found = await this.prisma.mealTemplate.findMany({
      where: { id: { in: ids }, coach_id: coachId, archived_at: null },
      select: { id: true },
    });
    const foundSet = new Set(found.map((f) => f.id));
    const missing = ids.filter((id) => !foundSet.has(id));
    if (missing.length > 0) {
      throw new BadRequestException(
        `Meal template(s) not owned by coach: ${missing.join(', ')}`,
      );
    }
  }

  async createPlan(coachId: string, dto: CreateDailyMealPlanDto) {
    await this.validateSlotTemplates(coachId, dto.slots);

    return this.prisma.$transaction(async (tx) => {
      const plan = await tx.dailyMealPlan.create({
        data: {
          coach_id: coachId,
          name: dto.name,
          notes: dto.notes ?? null,
        },
      });
      if (dto.slots.length > 0) {
        await tx.dailyMealPlanSlot.createMany({
          data: dto.slots.map((s, idx) => ({
            daily_meal_plan_id: plan.id,
            meal_template_id: s.meal_template_id,
            slot_label: s.slot_label,
            // Stable ordering: caller-provided order wins, otherwise
            // index in the input array.
            order: s.order ?? idx,
          })),
        });
      }
      return tx.dailyMealPlan.findUnique({
        where: { id: plan.id },
        include: {
          slots: {
            orderBy: [{ slot_label: 'asc' }, { order: 'asc' }],
            include: { meal_template: true },
          },
        },
      });
    });
  }

  async listPlans(coachId: string) {
    return this.prisma.dailyMealPlan.findMany({
      where: { coach_id: coachId, archived_at: null },
      orderBy: { created_at: 'desc' },
      include: {
        slots: {
          orderBy: [{ slot_label: 'asc' }, { order: 'asc' }],
          include: { meal_template: true },
        },
      },
    });
  }

  async getPlan(coachId: string, planId: string) {
    await this.assertPlanOwnedBy(coachId, planId);
    return this.prisma.dailyMealPlan.findUnique({
      where: { id: planId },
      include: {
        slots: {
          orderBy: [{ slot_label: 'asc' }, { order: 'asc' }],
          include: { meal_template: true },
        },
      },
    });
  }

  async updatePlan(
    coachId: string,
    planId: string,
    dto: UpdateDailyMealPlanDto,
  ) {
    await this.assertPlanOwnedBy(coachId, planId);
    if (dto.slots) await this.validateSlotTemplates(coachId, dto.slots);

    return this.prisma.$transaction(async (tx) => {
      await tx.dailyMealPlan.update({
        where: { id: planId },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.notes !== undefined && { notes: dto.notes }),
        },
      });
      if (dto.slots) {
        await tx.dailyMealPlanSlot.deleteMany({
          where: { daily_meal_plan_id: planId },
        });
        if (dto.slots.length > 0) {
          await tx.dailyMealPlanSlot.createMany({
            data: dto.slots.map((s, idx) => ({
              daily_meal_plan_id: planId,
              meal_template_id: s.meal_template_id,
              slot_label: s.slot_label,
              order: s.order ?? idx,
            })),
          });
        }
      }
      return tx.dailyMealPlan.findUnique({
        where: { id: planId },
        include: {
          slots: {
            orderBy: [{ slot_label: 'asc' }, { order: 'asc' }],
            include: { meal_template: true },
          },
        },
      });
    });
  }

  async archivePlan(coachId: string, planId: string) {
    const result = await this.prisma.dailyMealPlan.updateMany({
      where: { id: planId, coach_id: coachId, archived_at: null },
      data: { archived_at: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('Daily meal plan not found');
    return { archived: result.count };
  }

  // ─── Assignments ─────────────────────────────────────────────────────

  async assignPlan(
    coachId: string,
    planId: string,
    dto: AssignDailyPlanDto,
  ) {
    await this.assertPlanOwnedBy(coachId, planId);
    await this.assertClientOfCoach(coachId, dto.client_id);

    const startsOn = new Date(dto.starts_on);
    const endsOn = dto.ends_on ? new Date(dto.ends_on) : null;
    if (endsOn && endsOn.getTime() < startsOn.getTime()) {
      throw new BadRequestException('ends_on must not precede starts_on');
    }

    return this.prisma.dailyMealPlanAssignment.create({
      data: {
        daily_meal_plan_id: planId,
        client_id: dto.client_id,
        assigned_by_coach_id: coachId,
        starts_on: startsOn,
        ends_on: endsOn,
      },
    });
  }

  async listAssignmentsForCoach(coachId: string, planId: string) {
    await this.assertPlanOwnedBy(coachId, planId);
    return this.prisma.dailyMealPlanAssignment.findMany({
      where: { daily_meal_plan_id: planId },
      orderBy: { starts_on: 'asc' },
    });
  }

  // Client-side: list "today's" plan(s). A plan applies on a given date
  // if starts_on <= date and (ends_on is null OR ends_on >= date).
  async getTodayForClient(clientId: string, dateIso?: string) {
    const today = dateIso ? new Date(dateIso) : new Date();
    today.setHours(0, 0, 0, 0);
    const assignments = await this.prisma.dailyMealPlanAssignment.findMany({
      where: {
        client_id: clientId,
        starts_on: { lte: today },
        OR: [{ ends_on: null }, { ends_on: { gte: today } }],
      },
      orderBy: { starts_on: 'desc' },
      include: {
        daily_meal_plan: {
          include: {
            slots: {
              orderBy: [{ slot_label: 'asc' }, { order: 'asc' }],
              include: { meal_template: true },
            },
          },
        },
      },
    });
    return { date: today.toISOString().slice(0, 10), assignments };
  }
}
