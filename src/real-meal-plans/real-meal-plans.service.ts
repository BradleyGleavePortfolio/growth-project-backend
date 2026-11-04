import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { resolveRecipientTimeZone } from '../notifications/recipient-timezone';
import { visibleRecipesWhere } from '../recipes/recipe-access';
import { loadViewerAllergens } from '../recipes/allergens';
import {
  CHANGES_TODAY_LIMIT,
  LOCAL_DAY_LOOKBACK_MS,
  MEAL_RECIPE_INVALID,
  MEAL_SWAP_INVALID,
  localDateKey,
  planSwapsError,
  revisionsFor,
  sameLocalDay,
} from './plan-swaps';
import {
  AssignDailyPlanDto,
  CreateDailyMealPlanDto,
  CreateMealTemplateDto,
  EndDailyPlanAssignmentDto,
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

  // PLAN-SWAPS-BE: every swap is one of this coach's live templates and not the template itself; the
  // recipe is one this coach created. Anything else (another coach's, archived, missing) is refused.
  private async assertTemplateLinks(
    coachId: string,
    dto: { swap_template_ids?: string[]; recipe_id?: string | null },
    selfId?: string,
  ) {
    const swaps = dto.swap_template_ids ?? [];
    if (swaps.length > 0) {
      if (selfId && swaps.includes(selfId)) throw planSwapsError(MEAL_SWAP_INVALID);
      const found = await this.prisma.mealTemplate.count({
        where: { id: { in: swaps }, coach_id: coachId, archived_at: null },
      });
      if (found !== new Set(swaps).size) throw planSwapsError(MEAL_SWAP_INVALID);
    }
    if (dto.recipe_id) {
      const recipe = await this.prisma.recipe.findFirst({
        where: { id: dto.recipe_id, created_by_id: coachId },
        select: { id: true },
      });
      if (!recipe) throw planSwapsError(MEAL_RECIPE_INVALID);
    }
  }

  // ─── MealTemplate CRUD ───────────────────────────────────────────────
  async createTemplate(coachId: string, dto: CreateMealTemplateDto) {
    await this.assertTemplateLinks(coachId, dto);
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
        swap_template_ids: dto.swap_template_ids ?? [],
        recipe_id: dto.recipe_id ?? null,
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
    await this.assertTemplateLinks(coachId, dto, templateId);
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
          ...(dto.swap_template_ids !== undefined && { swap_template_ids: dto.swap_template_ids }),
          ...(dto.recipe_id !== undefined && { recipe_id: dto.recipe_id }),
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
          updated_at: new Date(),
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
        const goneRows = existing.filter((e) => !wanted.has(key(e)));
        const gone = goneRows.map((e) => e.id);
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
        const freshKeys = new Set(fresh.map(key));
        let added: { id: string; slot_label: string; order: number; meal_template_id: string }[] = [];
        if (fresh.length > 0) {
          await tx.dailyMealPlanSlot.createMany({
            data: fresh.map((s) => ({ daily_meal_plan_id: planId, ...s })),
          });
          added = (await tx.dailyMealPlanSlot.findMany({
            where: { daily_meal_plan_id: planId },
            select: { id: true, slot_label: true, order: true, meal_template_id: true },
          })).filter((r) => freshKeys.has(key(r)));
        }
        // PLAN-SWAPS-BE: one revision per meal change, in this transaction, so today's changes
        // (getTodayForClient) can never disagree with the slots.
        const revisions = revisionsFor(
          planId,
          existing.flatMap((e) => {
            const w = wanted.get(key(e));
            return w ? [{ before: e, afterTemplateId: w.meal_template_id }] : [];
          }),
          goneRows,
          added,
          new Date(),
          randomUUID,
        );
        if (revisions.length > 0) {
          await tx.dailyMealPlanRevision.createMany({ data: revisions });
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
      select: { id: true, daily_meal_plan_id: true, client_id: true },
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
      const held = moved.filter((a) => a.daily_meal_plan_id === planId);
      const clientIds = [...new Set(held.map((a) => a.client_id))];
      for (const s of plan.slots) {
        const { id } = await tx.dailyMealPlanSlot.create({
          data: {
            daily_meal_plan_id: copy.id,
            meal_template_id: frozen.get(s.meal_template_id) ?? s.meal_template_id,
            slot_label: s.slot_label,
            order: s.order,
            time_of_day: s.time_of_day,
          },
          select: { id: true },
        });
        // FOODLINK: the moved clients' meals logged for this slot follow it to the copy, so their plan still
        // shows them eaten; every other client's links stay on the live slot.
        await tx.loggedFoodEntry.updateMany({
          where: { plan_slot_id: s.id, user_id: { in: clientIds } },
          data: { plan_slot_id: id },
        });
      }
      await tx.dailyMealPlanAssignment.updateMany({
        where: { id: { in: held.map((a) => a.id) } },
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

  // MEALPLAN-END (OWN-1): the coach ends an assignment that listAssignmentsForCoach lists: their live plan,
  // a client still theirs (owner 4: a moved client's is not theirs to end). ends_on is the client's last
  // day on it, and ending never extends it. An end before the start leaves no day, so the row goes.
  async endAssignment(coachId: string, planId: string, assignmentId: string, dto: EndDailyPlanAssignmentDto) {
    await this.assertPlanOwnedBy(coachId, planId);
    const where: Prisma.DailyMealPlanAssignmentWhereInput = {
      id: assignmentId,
      daily_meal_plan_id: planId,
      client: { coach_id: coachId, role: 'student' },
    };
    if (!(await this.prisma.dailyMealPlanAssignment.findFirst({ where, select: { id: true } }))) {
      throw new NotFoundException('Assignment not found');
    }
    // Each write re-checks its own rule in its WHERE, so two ends at once settle on the earlier day.
    const endsOn = new Date(dto.ends_on);
    const removed = await this.prisma.dailyMealPlanAssignment.deleteMany({
      where: { ...where, starts_on: { gt: endsOn } },
    });
    if (removed.count) return;
    await this.prisma.dailyMealPlanAssignment.updateMany({
      where: { ...where, OR: [{ ends_on: null }, { ends_on: { gt: endsOn } }] },
      data: { ends_on: endsOn },
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
        // MEALPLAN-END (OWN-1): an archive hides a plan from its own coach's client, as GET /meal-plans and
        // Roman's context do; a moved client keeps an earlier coach's plan, frozen copy included (owner 4).
        daily_meal_plan: { OR: [{ archived_at: null }, { coach: { students: { none: { id: clientId } } } }] },
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
    return this.withSwapsAndChanges(clientId, today.toISOString().slice(0, 10), dateIso, assignments);
  }

  /**
   * PLAN-SWAPS-BE (C2 S2): on a plan from the client's current coach, each slot gets that coach's live swaps
   * (name, kcal, protein) and the meal's recipe when the client can open it (visibleRecipesWhere, with the
   * client's allergens, so the link never opens onto RECIPE_NOT_FOUND or RECIPE_HIDDEN_FOR_ALLERGENS); a plan
   * kept from an earlier coach gets none (owner 4). `changes_today` lists the meal changes to these plans
   * since the client's local midnight (resolveRecipientTimeZone; UTC when no zone is known), and is empty
   * when ?date names another day.
   */
  private async withSwapsAndChanges<
    A extends {
      daily_meal_plan: {
        id: string;
        coach_id: string;
        slots: {
          id: string;
          meal_template_id: string;
          meal_template: { swap_template_ids: string[]; recipe_id: string | null };
        }[];
      };
    },
  >(clientId: string, date: string, dateIso: string | undefined, assignments: A[]) {
    const viewer = await this.prisma.user.findFirst({
      where: { id: clientId },
      select: { id: true, role: true, coach_id: true },
    });
    const coachId = viewer?.coach_id ?? null;
    const ownSlots = assignments
      .filter((a) => coachId !== null && a.daily_meal_plan.coach_id === coachId)
      .flatMap((a) => a.daily_meal_plan.slots);
    const swapIds = [...new Set(ownSlots.flatMap((s) => s.meal_template.swap_template_ids ?? []))];
    const recipeIds = [...new Set(ownSlots.flatMap((s) => (s.meal_template.recipe_id ? [s.meal_template.recipe_id] : [])))];
    const avoid = recipeIds.length > 0 ? await loadViewerAllergens(this.prisma, clientId) : [];
    const [swapRows, recipeRows] = await Promise.all([
      swapIds.length > 0 && coachId
        ? this.prisma.mealTemplate.findMany({
            where: { id: { in: swapIds }, coach_id: coachId, archived_at: null },
            select: { id: true, name: true, calories_kcal: true, protein_g: true },
          })
        : Promise.resolve([]),
      recipeIds.length > 0 && viewer && coachId
        ? this.prisma.recipe.findMany({
            where: { AND: [{ id: { in: recipeIds }, created_by_id: coachId }, visibleRecipesWhere(viewer, avoid)] },
            select: { id: true },
          })
        : Promise.resolve([]),
    ]);
    const swapById = new Map(swapRows.map((t) => [t.id, t]));
    const openable = new Set(recipeRows.map((r) => r.id));
    const ownSlotIds = new Set(ownSlots.map((s) => s.id));
    const withSwaps = assignments.map((a) => ({
      ...a,
      daily_meal_plan: {
        ...a.daily_meal_plan,
        slots: a.daily_meal_plan.slots.map((s) => {
          const own = ownSlotIds.has(s.id);
          const swaps = own
            ? (s.meal_template.swap_template_ids ?? []).flatMap((id) => {
                const t = swapById.get(id);
                return t && t.id !== s.meal_template_id ? [t] : [];
              })
            : [];
          const recipeId = own && s.meal_template.recipe_id && openable.has(s.meal_template.recipe_id)
            ? s.meal_template.recipe_id
            : null;
          // The raw ids stay server-side: the client sees only the checked swaps and recipe.
          const { swap_template_ids: _swapIds, recipe_id: _recipeId, ...meal_template } = s.meal_template;
          return { ...s, meal_template, swaps, recipe_id: recipeId };
        }),
      },
    }));

    const now = new Date();
    const planIds = [...new Set(assignments.map((a) => a.daily_meal_plan.id))];
    const tz = planIds.length > 0 ? (await resolveRecipientTimeZone(this.prisma, clientId)) ?? 'UTC' : 'UTC';
    // ?date arrives untyped (a repeated ?date is an array): only a string naming the client's today counts.
    const forToday = dateIso === undefined || (typeof dateIso === 'string' && dateIso.slice(0, 10) === localDateKey(now, tz));
    const rows = forToday && planIds.length > 0
      ? (await this.prisma.dailyMealPlanRevision.findMany({
          where: { plan_id: { in: planIds }, changed_at: { gte: new Date(now.getTime() - LOCAL_DAY_LOOKBACK_MS), lte: now } },
          orderBy: { changed_at: 'asc' },
          take: CHANGES_TODAY_LIMIT,
        })).filter((r) => sameLocalDay(r.changed_at, now, tz))
      : [];
    const nameIds = [...new Set(rows.flatMap((r) => [r.from_template_id, r.to_template_id]).filter((id): id is string => !!id))];
    const names = nameIds.length > 0
      ? new Map((await this.prisma.mealTemplate.findMany({
          where: { id: { in: nameIds }, coach_id: { in: [...new Set(assignments.map((a) => a.daily_meal_plan.coach_id))] } },
          select: { id: true, name: true },
        })).map((t) => [t.id, t.name]))
      : new Map<string, string>();
    const changes_today = rows.map(({ id: _id, from_template_id, to_template_id, ...r }) => ({
      ...r,
      from_template_id,
      from_name: from_template_id ? names.get(from_template_id) ?? null : null,
      to_template_id,
      to_name: to_template_id ? names.get(to_template_id) ?? null : null,
    }));
    return { date, assignments: withSwaps, changes_today };
  }
}
