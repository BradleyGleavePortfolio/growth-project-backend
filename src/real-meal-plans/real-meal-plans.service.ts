import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
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
        ...(dto.items !== undefined && { items: dto.items as unknown as object }),
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
    return this.prisma.$transaction(async (tx) => {
      const used = await tx.dailyMealPlanSlot.findMany({
        where: { meal_template_id: templateId },
        select: { daily_meal_plan_id: true },
      });
      await this.freezeForMovedClients(tx, coachId, used.map((u) => u.daily_meal_plan_id));
      return tx.mealTemplate.update({
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
  // to this coach and is live. MEALBUILD-BE: on an edit, a meal archived
  // after it went into this plan may stay ("Day plans that use it keep it
  // until you swap it"), so a plan with archived meals can still be edited;
  // an archived meal can't be added. Coach-owned rows only, either way.
  private async validateSlotTemplates(
    coachId: string,
    slots: DailyPlanSlotInputDto[],
    planId?: string,
  ) {
    if (slots.length === 0) return;
    const ids = Array.from(new Set(slots.map((s) => s.meal_template_id)));
    const kept = planId
      ? (await this.prisma.dailyMealPlanSlot.findMany({ where: { daily_meal_plan_id: planId }, select: { meal_template_id: true } }))
        .map((s) => s.meal_template_id)
      : [];
    const found = await this.prisma.mealTemplate.findMany({
      where: { id: { in: ids }, coach_id: coachId, OR: [{ archived_at: null }, { id: { in: kept } }] },
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
            time_of_day: s.time_of_day ?? null,
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
    if (dto.slots) await this.validateSlotTemplates(coachId, dto.slots, planId);

    return this.prisma.$transaction(async (tx) => {
      await this.freezeForMovedClients(tx, coachId, [planId]);
      await tx.dailyMealPlan.update({
        where: { id: planId },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.notes !== undefined && { notes: dto.notes }),
        },
      });
      if (dto.slots) {
        // FOODLINK: a slot whose (slot_label, order) is still listed keeps its row (and so the client's food
        // logs linked to it); only its meal and time change. Unlisted slots are deleted (their links go null),
        // new ones created. Kept rows keep their key, so the unique (plan, label, order) cannot collide.
        const next = dto.slots.map((s, idx) => ({
          meal_template_id: s.meal_template_id,
          slot_label: s.slot_label,
          order: s.order ?? idx,
          time_of_day: s.time_of_day ?? null,
        }));
        const key = (s: { slot_label: string; order: number }) => `${s.slot_label}#${s.order}`;
        const wanted = new Map(next.map((s) => [key(s), s]));
        const existing = await tx.dailyMealPlanSlot.findMany({
          where: { daily_meal_plan_id: planId },
          select: { id: true, slot_label: true, order: true, meal_template_id: true, time_of_day: true },
        });
        const gone = existing.filter((e) => !wanted.has(key(e))).map((e) => e.id);
        if (gone.length > 0) {
          await tx.dailyMealPlanSlot.deleteMany({ where: { id: { in: gone } } });
        }
        for (const e of existing) {
          const w = wanted.get(key(e));
          if (w && (w.meal_template_id !== e.meal_template_id || w.time_of_day !== e.time_of_day)) {
            await tx.dailyMealPlanSlot.update({
              where: { id: e.id },
              data: { meal_template_id: w.meal_template_id, time_of_day: w.time_of_day },
            });
          }
        }
        const kept = new Set(existing.map(key));
        const fresh = next.filter((s) => !kept.has(key(s)));
        if (fresh.length > 0) {
          await tx.dailyMealPlanSlot.createMany({
            data: fresh.map((s) => ({ daily_meal_plan_id: planId, ...s })),
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

  /**
   * Owner 4 + 139-13: a client who moved to another coach keeps the plan as it
   * was, and the former coach's later edits no longer reach them. Before an
   * edit, the moved clients' assignments of these plans move to a frozen copy
   * of the plan and its meal templates, with the plan's own date. The copy is
   * archived, so it is on none of the coach's lists and no coach route opens
   * it; the client still reads it, on GET /meal-plans too (meal-plans.service.ts).
   */
  private async freezeForMovedClients(
    tx: Prisma.TransactionClient,
    coachId: string,
    planIds: string[],
  ) {
    if (planIds.length === 0) return;
    const moved = await tx.dailyMealPlanAssignment.findMany({
      where: {
        daily_meal_plan_id: { in: planIds },
        NOT: { client: { coach_id: coachId, role: 'student' } },
      },
      select: { id: true, daily_meal_plan_id: true },
    });
    const now = new Date();
    for (const planId of new Set(moved.map((a) => a.daily_meal_plan_id))) {
      const plan = await tx.dailyMealPlan.findUnique({
        where: { id: planId },
        include: { slots: { include: { meal_template: true } } },
      });
      if (!plan) continue;
      const { coach_id, name, notes, created_at } = plan;
      const copy = await tx.dailyMealPlan.create({
        data: { coach_id, name, notes, created_at, archived_at: now },
      });
      const frozen = new Map<string, string>();
      for (const { meal_template: t } of plan.slots) {
        if (frozen.has(t.id)) continue;
        const row = await tx.mealTemplate.create({
          data: {
            coach_id: t.coach_id,
            name: t.name,
            description: t.description,
            calories_kcal: t.calories_kcal,
            protein_g: t.protein_g,
            carbs_g: t.carbs_g,
            fats_g: t.fats_g,
            fiber_g: t.fiber_g,
            ...(t.items !== null && { items: t.items as Prisma.InputJsonValue }),
            archived_at: now,
          },
        });
        frozen.set(t.id, row.id);
      }
      if (plan.slots.length > 0) {
        await tx.dailyMealPlanSlot.createMany({
          data: plan.slots.map((s) => ({
            daily_meal_plan_id: copy.id,
            meal_template_id: frozen.get(s.meal_template_id) ?? s.meal_template_id,
            slot_label: s.slot_label,
            order: s.order,
            time_of_day: s.time_of_day,
          })),
        });
      }
      const ids = moved.filter((a) => a.daily_meal_plan_id === planId).map((a) => a.id);
      await tx.dailyMealPlanAssignment.updateMany({
        where: { id: { in: ids } },
        data: { daily_meal_plan_id: copy.id },
      });
    }
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

  // Owner 4: a client who moved to another coach leaves this list at once,
  // the same client rule as assignPlan (assertClientOfCoach).
  async listAssignmentsForCoach(coachId: string, planId: string) {
    await this.assertPlanOwnedBy(coachId, planId);
    return this.prisma.dailyMealPlanAssignment.findMany({
      where: { daily_meal_plan_id: planId, client: { coach_id: coachId, role: 'student' } },
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
