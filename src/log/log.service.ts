import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { FoodService } from '../food/food.service';
import { LogFoodDto, UpdateLogEntryDto } from './log.dto';
import { AnalyticsService } from '../analytics/analytics.service';
import { Events } from '../analytics/events';
import { PtmService } from '../ptm/ptm.service';
import { ClientAIContextService } from '../ai/client-ai-context.service';
import { resolveDisplayedTargets } from '../macros/macro-calculator';

@Injectable()
export class LogService {
  constructor(
    private prisma: PrismaService,
    private foodService: FoodService,
    private analytics: AnalyticsService,
    private ptm: PtmService,
    // M2 — bust the AI context cache after food-log writes.
    private aiContext: ClientAIContextService,
  ) {}

  async logFood(userId: string, data: LogFoodDto) {
    // R6 (LO-FOOD B6, LS-FOOD B3): a repeat of a keyed save whose answer was
    // lost returns the stored entry and does nothing else — no food import, no
    // second entry, no analytics event or meal_logged signal. Another
    // person's key reads as not found (D2 below).
    if (data.client_uuid) {
      const earlier = await this.prisma.loggedFoodEntry.findUnique({
        where: { client_uuid: data.client_uuid },
        include: { food_item: true },
      });
      if (earlier) {
        if (earlier.user_id !== userId) throw new NotFoundException('Entry not found');
        return earlier;
      }
    }
    // Mobile client may send synthetic ids ("usda_123", "off_456") returned by food search.
    // Resolve them to real FoodItem.id via upsert-on-log so the FK below can't blow up.
    // Another person's custom food resolves as not found (UX-FOOD-PRIV-124).
    const resolvedFoodItemId = await this.foodService.resolveOrImportId(data.food_item_id, userId);
    const plan_slot_id = data.plan_slot_id
      ? await this.ownPlanSlot(userId, data.plan_slot_id, new Date(data.date))
      : null;
    const entryData = {
      user_id: userId,
      date: new Date(data.date),
      meal_type: data.meal_type,
      food_item_id: resolvedFoodItemId,
      quantity_multiplier: data.quantity_multiplier ?? 1.0,
      // Persist the original user-entered qty + unit so coach views render
      // "6 oz chicken" not "1.7008x chicken". Both columns are nullable;
      // older entries (and clients that don't send them) leave them null
      // and the API falls back to quantity_multiplier.
      original_quantity: data.original_quantity,
      original_unit: data.original_unit,
      notes: data.notes,
      // FOODLINK: set only when sent (and, for the slot, verified); otherwise the column defaults (null,
      // false) apply, so a write without them is exactly today's.
      ...(plan_slot_id ? { plan_slot_id } : {}),
      ...(data.fills_usual_meal ? { fills_usual_meal: true } : {}),
    };
    // Upsert on client_uuid so a flush retry after a mobile crash is idempotent.
    // D2 (AUTHB-03): no key means a plain create. client_uuid is unique across
    // all users, so a shared fallback key (or another person's key) used to
    // return their entry and save nothing; such an entry is never returned.
    const write = () =>
      data.client_uuid
        ? this.prisma.loggedFoodEntry.upsert({
            where: { client_uuid: data.client_uuid },
            create: { ...entryData, client_uuid: data.client_uuid },
            update: {}, // no-op if already exists — idempotent on retry
            include: { food_item: true },
          })
        : this.prisma.loggedFoodEntry.create({ data: entryData, include: { food_item: true } });
    let created: Awaited<ReturnType<typeof write>>;
    try {
      created = await write();
    } catch (err) {
      // FR-1198 (LO-1198 C1): two saves with one key at once both miss the
      // read above, and the loser's insert hits the unique key (P2002). The
      // loser answers with the stored entry, like the saved-meal route.
      if (!data.client_uuid || (err as { code?: string } | null)?.code !== 'P2002') throw err;
      const stored = await this.prisma.loggedFoodEntry.findUnique({
        where: { client_uuid: data.client_uuid },
        include: { food_item: true },
      });
      if (!stored) throw err;
      if (stored.user_id !== userId) throw new NotFoundException('Entry not found');
      return stored;
    }
    if (created.user_id !== userId) throw new NotFoundException('Entry not found');
    this.analytics.capture(userId, Events.CLIENT_FOOD_LOGGED, {
      meal_type: data.meal_type,
    });
    const calories = Math.round(created.food_item.calories * created.quantity_multiplier);
    this.ptm.emit(userId, 'meal_logged', calories, {
      meal_type: data.meal_type,
    });
    // M2 — bust AI context cache so next chat sees the new log entry.
    this.aiContext.invalidateForUser(userId);
    return created;
  }

  /**
   * FOODLINK: the slot id only if it belongs to a meal plan assigned to this client on this date (the rule of
   * GET /me/meal-plan/today: starts_on <= date, ends_on null or >= date); otherwise null. Prisma's role
   * bypasses RLS, so this query is the tenant check. It never returns anything about another person.
   */
  private async ownPlanSlot(userId: string, slotId: string, date: Date): Promise<string | null> {
    const slot = await this.prisma.dailyMealPlanSlot.findFirst({
      where: {
        id: slotId,
        daily_meal_plan: {
          assignments: {
            some: { client_id: userId, starts_on: { lte: date }, OR: [{ ends_on: null }, { ends_on: { gte: date } }] },
          },
        },
      },
      select: { id: true },
    });
    return slot?.id ?? null;
  }

  async getDaily(userId: string, date: string) {
    const targetDate = new Date(date);
    const entries = await this.prisma.loggedFoodEntry.findMany({
      where: { user_id: userId, date: targetDate },
      include: { food_item: true },
      orderBy: { logged_at: 'asc' },
    });

    const profile = await this.prisma.userProfile.findUnique({ where: { user_id: userId } });
    // C06: same resolver as GET /me/macros/current (coach MacroTarget, then
    // profile targets). The legacy 2000/180/200/60 numbers are kept ONLY for
    // response-shape compatibility when nothing is set, and are labelled via
    // `macro_targets_source: 'unset'` so no client mistakes them for a plan.
    const coachTarget = await this.prisma.macroTarget.findFirst({
      where: { client_id: userId, archived_at: null, effective_from: { lte: new Date() } },
      orderBy: { effective_from: 'desc' },
    });
    const shown = resolveDisplayedTargets(coachTarget, profile);
    const tCal = shown.calories ?? 2000;
    const tPro = shown.protein_g ?? 180;
    const tCarb = shown.carbs_g ?? 200;
    const tFat = shown.fat_g ?? 60;

    let total_calories = 0,
      total_protein_g = 0,
      total_carbs_g = 0,
      total_fat_g = 0;

    entries.forEach((e) => {
      const q = e.quantity_multiplier;
      total_calories += e.food_item.calories * q;
      total_protein_g += e.food_item.protein_g * q;
      total_carbs_g += e.food_item.carbs_g * q;
      total_fat_g += e.food_item.fat_g * q;
    });

    return {
      date,
      entries,
      total_calories: Math.round(total_calories),
      total_protein_g: Math.round(total_protein_g),
      total_carbs_g: Math.round(total_carbs_g),
      total_fat_g: Math.round(total_fat_g),
      remaining_calories: Math.round(tCal - total_calories),
      remaining_protein_g: Math.round(tPro - total_protein_g),
      remaining_carbs_g: Math.round(tCarb - total_carbs_g),
      remaining_fat_g: Math.round(tFat - total_fat_g),
      macro_targets: {
        calories: tCal,
        protein_g: tPro,
        carbs_g: tCarb,
        fat_g: tFat,
      },
      macro_targets_source: shown.source,
    };
  }

  async updateEntry(userId: string, entryId: string, data: UpdateLogEntryDto) {
    const entry = await this.prisma.loggedFoodEntry.findUnique({ where: { id: entryId } });
    if (!entry || entry.user_id !== userId) throw new NotFoundException('Entry not found');
    // Explicit field mapping — no spread. DTO already rejects unknown keys via
    // the global ValidationPipe (whitelist + forbidNonWhitelisted), but the
    // explicit map is a second line of defense against mass-assignment.
    return this.prisma.loggedFoodEntry.update({
      where: { id: entryId },
      data: {
        quantity_multiplier: data.quantity_multiplier,
        notes: data.notes,
        meal_type: data.meal_type,
        // Preserve the human-readable quantity + unit so coach views keep
        // showing "6 oz" after an edit. Fall back to the stored value when
        // the caller omits the field (e.g. only changing meal_type). See Fix 5.
        original_quantity: data.original_quantity ?? entry.original_quantity,
        original_unit: data.original_unit ?? entry.original_unit,
      },
    });
  }

  async deleteEntry(userId: string, entryId: string) {
    const entry = await this.prisma.loggedFoodEntry.findUnique({ where: { id: entryId } });
    if (!entry || entry.user_id !== userId) throw new NotFoundException('Entry not found');
    const deleted = await this.prisma.loggedFoodEntry.delete({ where: { id: entryId } });
    // M2 — bust AI context cache after deletion.
    this.aiContext.invalidateForUser(userId);
    return deleted;
  }

  async getWeekly(userId: string, weekStart: string) {
    const start = new Date(weekStart);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);

    const entries = await this.prisma.loggedFoodEntry.findMany({
      where: { user_id: userId, date: { gte: start, lt: end } },
      include: { food_item: true },
      orderBy: { date: 'asc' },
    });

    // Group by date
    const byDate: Record<string, any> = {};
    entries.forEach((e) => {
      const d = e.date.toISOString().split('T')[0];
      if (!byDate[d]) byDate[d] = { date: d, calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
      byDate[d].calories += e.food_item.calories * e.quantity_multiplier;
      byDate[d].protein_g += e.food_item.protein_g * e.quantity_multiplier;
      byDate[d].carbs_g += e.food_item.carbs_g * e.quantity_multiplier;
      byDate[d].fat_g += e.food_item.fat_g * e.quantity_multiplier;
    });

    return Object.values(byDate);
  }
}
