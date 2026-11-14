import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { isDeepStrictEqual } from 'util';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { resolveRecipientTimeZone } from '../notifications/recipient-timezone';
import { NotificationKind } from '../notifications/notification-kind';
import { NotificationsService } from '../notifications/notifications.service';
import { coachStudent, inForceToday, inForceWhere, type MealPlanChange, planDay, tellMealPlanChange, whoSeesToday } from './meal-plan-notice';
import { visibleRecipesWhere } from '../recipes/recipe-access';
import { loadViewerAllergens } from '../recipes/allergens';
import {
  CHANGES_TODAY_LIMIT,
  localDayStartBefore,
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

/**
 * MEAL-PLAN-NOTICE-BE (question 4): the meal fields a client's phone draws from GET /me/meal-plan/today (the meal
 * plan screen and the Food tab at mobile main 763c3cb5). Fiber, swaps and the recipe are drawn nowhere yet.
 */
const DRAWN_MEAL_FIELDS = ['name', 'description', 'calories_kcal', 'protein_g', 'carbs_g', 'fats_g', 'items'] as const;

@Injectable()
export class RealMealPlansService {
  private readonly logger = new Logger(RealMealPlansService.name);
  constructor(
    private readonly prisma: PrismaService,
    // MEAL-PLAN-NOTICE-BE: tells the client (tellMealPlanChange). @Optional, as in WorkoutBuilderService, so the
    // specs that build this service with Prisma alone still do; without it nothing is read or sent.
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  /** MEAL-PLAN-NOTICE-BE: after the write commits; never awaited, never throws. */
  private tell(coachId: string, kind: MealPlanChange['kind'], reach: MealPlanChange['reach'], assignments: MealPlanChange['assignments']) {
    void tellMealPlanChange(this.prisma, this.notifications, { coachId, kind, reach, assignments });
  }

  // ─── Tenancy guards ──────────────────────────────────────────────────
  private async assertClientOfCoach(coachId: string, clientId: string) {
    const c = await this.prisma.user.findFirst({
      where: { id: clientId, ...coachStudent(coachId) },
      select: { id: true },
    });
    if (!c) throw new NotFoundException('Client not found');
  }

  private async assertTemplateOwnedBy(coachId: string, templateId: string) {
    const t = await this.prisma.mealTemplate.findFirst({
      where: { id: templateId, coach_id: coachId, archived_at: null },
      // MEAL-PLAN-NOTICE-BE: the fields a client sees (DRAWN_MEAL_FIELDS), to tell a change from a same-value save.
      select: { id: true, name: true, description: true, calories_kcal: true, protein_g: true, carbs_g: true, fats_g: true, items: true },
    });
    if (!t) throw new NotFoundException('Meal template not found');
    return t;
  }

  private async assertPlanOwnedBy(coachId: string, planId: string) {
    const p = await this.prisma.dailyMealPlan.findFirst({
      where: { id: planId, coach_id: coachId, archived_at: null },
      select: { id: true, name: true, notes: true },
    });
    if (!p) throw new NotFoundException('Daily meal plan not found');
    return p;
  }

  // PLAN-SWAPS-BE: every swap is one of this coach's live templates and not the template itself; the
  // recipe is one this coach created. Anything else (another coach's, archived, missing, an empty
  // recipe id) is refused. FIX-1221 (LO-1221 C1): on an update, swaps and the recipe the template
  // already stores are accepted back, so a coach can save a meal whose swap was archived later; the
  // database applies the same rule (p_mealtemplate_links_insert/_update, 20270502011100).
  private async assertTemplateLinks(
    coachId: string,
    dto: { swap_template_ids?: string[]; recipe_id?: string | null },
    selfId?: string,
  ) {
    const stored = selfId
      ? await this.prisma.mealTemplate.findFirst({
          where: { id: selfId, coach_id: coachId },
          select: { swap_template_ids: true, recipe_id: true },
        })
      : null;
    const kept = new Set(stored?.swap_template_ids ?? []);
    const swaps = dto.swap_template_ids ?? [];
    if (selfId && swaps.includes(selfId)) throw planSwapsError(MEAL_SWAP_INVALID);
    const added = [...new Set(swaps.filter((id) => !kept.has(id)))];
    if (added.length > 0) {
      const found = await this.prisma.mealTemplate.count({
        where: { id: { in: added }, coach_id: coachId, archived_at: null },
      });
      if (found !== added.length) throw planSwapsError(MEAL_SWAP_INVALID);
    }
    if (dto.recipe_id !== undefined && dto.recipe_id !== null && dto.recipe_id !== stored?.recipe_id) {
      const recipe = dto.recipe_id
        ? await this.prisma.recipe.findFirst({
            where: { id: dto.recipe_id, created_by_id: coachId },
            select: { id: true },
          })
        : null;
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
    const before = await this.assertTemplateOwnedBy(coachId, templateId);
    await this.assertTemplateLinks(coachId, dto, templateId);
    const updated = await this.prisma.$transaction(async (tx) => {
      // FIX-1221R2 (LS-1221R2B B1): a plan depends on this meal through a slot or through a change that
      // names it (from or to), so a meal swapped out still freezes for a moved client's history first; the
      // database rule matches (app.caller_keeps_meal_template, 20270502011100).
      const used = await tx.dailyMealPlanSlot.findMany({
        where: { meal_template_id: templateId },
        select: { daily_meal_plan_id: true },
      });
      const named = await tx.dailyMealPlanRevision.findMany({
        where: { OR: [{ from_template_id: templateId }, { to_template_id: templateId }] },
        select: { plan_id: true },
      });
      await this.freezeForMovedClients(tx, coachId, [
        ...new Set([...used.map((u) => u.daily_meal_plan_id), ...named.map((r) => r.plan_id)]),
      ]);
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
    // MEAL-PLAN-NOTICE-BE: a change the client sees (DRAWN_MEAL_FIELDS) tells the clients of every plan with this meal.
    const shown = DRAWN_MEAL_FIELDS.some(
      (f) => dto[f] !== undefined && !isDeepStrictEqual(JSON.parse(JSON.stringify(dto[f])), JSON.parse(JSON.stringify(before[f] ?? null))),
    );
    if (shown) {
      this.tell(coachId, NotificationKind.MEAL_PLAN_UPDATED, 'today', () =>
        this.prisma.dailyMealPlanAssignment.findMany({
          where: { daily_meal_plan: { coach_id: coachId, slots: { some: { meal_template_id: templateId } } } },
          select: { id: true, client_id: true },
        }),
      );
    }
    return updated;
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
    const before = await this.assertPlanOwnedBy(coachId, planId);
    if (dto.slots) await this.validateSlotTemplates(coachId, dto.slots, planId);
    // MEAL-PLAN-NOTICE-BE: whether the client sees a change (the name, the note or a slot).
    let shown = (dto.name !== undefined && dto.name !== before.name) || (dto.notes !== undefined && dto.notes !== before.notes);

    const plan = await this.prisma.$transaction(async (tx) => {
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
          shown = true;
          await tx.dailyMealPlanSlot.deleteMany({ where: { id: { in: gone } } });
        }
        for (const e of existing) {
          const w = wanted.get(key(e));
          if (w && (w.meal_template_id !== e.meal_template_id || w.time_of_day !== e.time_of_day)) {
            shown = true;
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
          shown = true;
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
    if (shown) {
      this.tell(coachId, NotificationKind.MEAL_PLAN_UPDATED, 'today', () =>
        this.prisma.dailyMealPlanAssignment.findMany({ where: { daily_meal_plan_id: planId }, select: { id: true, client_id: true } }),
      );
    }
    return plan;
  }

  async archivePlan(coachId: string, planId: string) {
    // MEAL-PLAN-NOTICE-BE: who sees this plan today, read before the archive takes it off their day.
    // MEAL-NOTICE-EDGES-BE (R2): a failed read tells nobody and never fails the archive.
    const today = await whoSeesToday(this.prisma, this.notifications, NotificationKind.MEAL_PLAN_UPDATED, () =>
      this.prisma.dailyMealPlanAssignment.findMany({
        where: { daily_meal_plan_id: planId, client: coachStudent(coachId) },
        select: { id: true, client_id: true },
      }),
    );
    const result = await this.prisma.dailyMealPlan.updateMany({
      where: { id: planId, coach_id: coachId, archived_at: null },
      data: { archived_at: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('Daily meal plan not found');
    this.tell(coachId, NotificationKind.MEAL_PLAN_UPDATED, 'gone', today);
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
      const snapshot = async (t: (typeof plan.slots)[number]['meal_template']) => {
        if (frozen.has(t.id)) return;
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
      };
      for (const { meal_template: t } of plan.slots) await snapshot(t);
      // FIX-1221 (LS-1221 B2): the plan's change history goes with the copy. A meal a change names that
      // is no longer in the plan (the meal swapped out) gets its own frozen snapshot too, so the moved
      // client's feed keeps reading the names as they were, from rows of the plan's own coach.
      const history = await tx.dailyMealPlanRevision.findMany({
        where: { plan_id: planId },
        orderBy: { changed_at: 'asc' },
      });
      const named = [...new Set(history.flatMap((r) => [r.from_template_id, r.to_template_id]))]
        .filter((id): id is string => !!id && !frozen.has(id));
      if (named.length > 0) {
        for (const t of await tx.mealTemplate.findMany({ where: { id: { in: named }, coach_id } })) {
          await snapshot(t);
        }
      }
      const held = moved.filter((a) => a.daily_meal_plan_id === planId);
      const clientIds = [...new Set(held.map((a) => a.client_id))];
      const slotCopy = new Map<string, string>();
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
        slotCopy.set(s.id, id);
        // FOODLINK: the moved clients' meals logged for this slot follow it to the copy, so their plan still
        // shows them eaten; every other client's links stay on the live slot.
        await tx.loggedFoodEntry.updateMany({
          where: { plan_slot_id: s.id, user_id: { in: clientIds } },
          data: { plan_slot_id: id },
        });
        // FIX-1221 (LS-1221 B2): so do the moved clients' grocery items added from this slot; every
        // other client's items stay on the live slot.
        await tx.listItem.updateMany({
          where: { source_plan_slot_id: s.id, user_id: { in: clientIds } },
          data: { source_plan_slot_id: id },
        });
      }
      if (history.length > 0) {
        // A change keeps its time; its slot and meals point at the copy's rows (a slot since removed
        // keeps its old id, as on the live plan).
        await tx.dailyMealPlanRevision.createMany({
          // (A revision is history, not a slot write: test/c2-c0-planned-times.spec.ts walks slot writers.)
          data: history.map(({ id: _id, plan_id: _planId, slot_id, from_template_id, to_template_id, ...same }) => ({
            ...same, // slot_label and changed_at
            plan_id: copy.id,
            slot_id: slotCopy.get(slot_id) ?? slot_id,
            from_template_id: from_template_id ? frozen.get(from_template_id) ?? from_template_id : null,
            to_template_id: to_template_id ? frozen.get(to_template_id) ?? to_template_id : null,
          })),
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

    const created = await this.prisma.dailyMealPlanAssignment.create({
      data: {
        daily_meal_plan_id: planId,
        client_id: dto.client_id,
        assigned_by_coach_id: coachId,
        starts_on: startsOn,
        ends_on: endsOn,
      },
    });
    this.tell(coachId, NotificationKind.MEAL_PLAN_ASSIGNED, 'created', [created]);
    return created;
  }

  // Owner 4: a client who moved to another coach leaves this list at once,
  // the same client rule as assignPlan (assertClientOfCoach).
  async listAssignmentsForCoach(coachId: string, planId: string) {
    await this.assertPlanOwnedBy(coachId, planId);
    return this.prisma.dailyMealPlanAssignment.findMany({
      where: { daily_meal_plan_id: planId, client: coachStudent(coachId) },
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
      client: coachStudent(coachId),
    };
    const row = await this.prisma.dailyMealPlanAssignment.findFirst({ where, select: { id: true, client_id: true } });
    if (!row) throw new NotFoundException('Assignment not found');
    // MEAL-PLAN-NOTICE-BE: the client hears only when the end takes the plan off today.
    // MEAL-NOTICE-EDGES-BE (R2): a failed read tells nobody and never fails the end.
    const was = await whoSeesToday(this.prisma, this.notifications, NotificationKind.MEAL_PLAN_UPDATED, [row]);
    // Each write re-checks its own rule in its WHERE, so two ends at once settle on the earlier day.
    const endsOn = new Date(dto.ends_on);
    const removed = await this.prisma.dailyMealPlanAssignment.deleteMany({
      where: { ...where, starts_on: { gt: endsOn } },
    });
    if (removed.count) {
      this.tell(coachId, NotificationKind.MEAL_PLAN_UPDATED, 'gone', was);
      return;
    }
    await this.prisma.dailyMealPlanAssignment.updateMany({
      where: { ...where, OR: [{ ends_on: null }, { ends_on: { gt: endsOn } }] },
      data: { ends_on: endsOn },
    });
    this.tell(coachId, NotificationKind.MEAL_PLAN_UPDATED, 'gone', async () =>
      was.length > 0 && (await inForceToday(this.prisma, was)).length === 0 ? was : [],
    );
  }

  // Client-side: list "today's" plan(s). A plan applies on a given date
  // if starts_on <= date and (ends_on is null OR ends_on >= date).
  async getTodayForClient(clientId: string, dateIso?: string) {
    const today = planDay(dateIso);
    const assignments = await this.prisma.dailyMealPlanAssignment.findMany({
      // MEAL-PLAN-NOTICE-BE: the same where tells a client their plan changed (meal-plan-notice.ts).
      where: inForceWhere(clientId, today),
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
          // FIX-1221 (LS-1221 C1): bounded to the local day before the cap, so the cap keeps today's
          // earliest CHANGES_TODAY_LIMIT changes and yesterday's rows cannot use it up.
          where: { plan_id: { in: planIds }, changed_at: { gte: localDayStartBefore(now, tz), lte: now } },
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
