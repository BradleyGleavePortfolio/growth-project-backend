import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { FoodService } from '../food/food.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { Events } from '../analytics/events';
import { PtmService } from '../ptm/ptm.service';
import { ClientAIContextService } from '../ai/client-ai-context.service';
import { CreateSavedMealDto, FAVORITES_MAX, LogSavedMealDto, SAVED_MEALS_MAX } from './saved-foods.dto';

const WITH_FOOD = { food_item: true } as const;
const WITH_ITEMS = { items: { orderBy: { position: 'asc' }, include: WITH_FOOD } } as const;

/**
 * FOODSAVED: a client's favourite foods and saved meals. Every query is scoped
 * to the signed-in client (the server's connection bypasses RLS; the row rules
 * in 20270502001300 are the second line). Another person's row reads as not
 * found, like a missing id.
 */
@Injectable()
export class SavedFoodsService {
  constructor(
    private prisma: PrismaService,
    private foodService: FoodService,
    private analytics: AnalyticsService,
    private ptm: PtmService,
    private aiContext: ClientAIContextService,
  ) {}

  listFavorites(userId: string) {
    return this.prisma.foodFavorite.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
      include: WITH_FOOD,
    });
  }

  /** Idempotent: favouriting a food twice returns the first favourite. */
  async addFavorite(userId: string, foodRef: string) {
    const food_item_id = await this.resolveFood(userId, foodRef);
    const where = { user_id_food_item_id: { user_id: userId, food_item_id } };
    const existing = await this.prisma.foodFavorite.findUnique({ where, include: WITH_FOOD });
    if (existing) return existing;
    const count = await this.prisma.foodFavorite.count({ where: { user_id: userId } });
    if (count >= FAVORITES_MAX) throw limitReached('FOOD_FAVORITES_LIMIT', FAVORITES_MAX);
    const create = { user_id: userId, food_item_id };
    return this.prisma.foodFavorite.upsert({ where, create, update: {}, include: WITH_FOOD });
  }

  /** Idempotent: removing a food that is not a favourite removes nothing. */
  async removeFavorite(userId: string, foodItemId: string) {
    const { count } = await this.prisma.foodFavorite.deleteMany({
      where: { user_id: userId, food_item_id: foodItemId },
    });
    return { removed: count > 0 };
  }

  listSavedMeals(userId: string) {
    return this.prisma.savedMeal.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
      include: WITH_ITEMS,
    });
  }

  async createSavedMeal(userId: string, data: CreateSavedMealDto) {
    const count = await this.prisma.savedMeal.count({ where: { user_id: userId } });
    if (count >= SAVED_MEALS_MAX) throw limitReached('SAVED_MEALS_LIMIT', SAVED_MEALS_MAX);
    // One at a time, in order: a search id may import the food first.
    const foodIds: string[] = [];
    for (const item of data.items) foodIds.push(await this.resolveFood(userId, item.food_item_id));
    const items = data.items.map((item, position) => ({
      food_item_id: foodIds[position],
      quantity_multiplier: item.quantity_multiplier ?? 1.0,
      original_quantity: item.original_quantity,
      original_unit: item.original_unit,
      position,
    }));
    return this.prisma.savedMeal.create({
      data: { user_id: userId, name: data.name.trim(), items: { createMany: { data: items } } },
      include: WITH_ITEMS,
    });
  }

  async renameSavedMeal(userId: string, mealId: string, name: string) {
    await this.ownMeal(userId, mealId);
    const data = { name: name.trim() };
    return this.prisma.savedMeal.update({ where: { id: mealId }, data, include: WITH_ITEMS });
  }

  /** Its items go with it (ON DELETE CASCADE). Entries already logged from it stay. */
  async deleteSavedMeal(userId: string, mealId: string) {
    const where = { id: mealId, user_id: userId };
    const { count } = await this.prisma.savedMeal.deleteMany({ where });
    if (count === 0) throw new NotFoundException('Saved meal not found');
    return { deleted: true };
  }

  /**
   * Logs every food of the meal as an ordinary LoggedFoodEntry, all in one
   * transaction, same day, meal slot and logged_at, in the meal's order, and
   * returns them. With client_uuid, the item at position p is logged under the
   * key `<client_uuid>:<p>`; a retry finds those entries and returns them
   * without writing (the POST /log/food rule: another person's entry is never
   * returned).
   */
  async logSavedMeal(userId: string, mealId: string, data: LogSavedMealDto) {
    const meal = await this.ownMeal(userId, mealId);
    const key = data.client_uuid;
    const keys = key ? meal.items.map((item) => `${key}:${item.position}`) : null;
    const earlier = keys && (await this.entriesWithKeys(userId, keys));
    if (earlier) return earlier;

    const logged_at = new Date();
    const writes = meal.items.map((item, i) =>
      this.prisma.loggedFoodEntry.create({
        data: {
          user_id: userId,
          date: new Date(data.date),
          meal_type: data.meal_type,
          food_item_id: item.food_item_id,
          quantity_multiplier: item.quantity_multiplier,
          original_quantity: item.original_quantity,
          original_unit: item.original_unit,
          logged_at,
          client_uuid: keys?.[i],
        },
        include: WITH_FOOD,
      }),
    );
    try {
      const entries = await this.prisma.$transaction(writes);
      for (const entry of entries) {
        this.analytics.capture(userId, Events.CLIENT_FOOD_LOGGED, { meal_type: data.meal_type });
        const calories = Math.round(entry.food_item.calories * entry.quantity_multiplier);
        this.ptm.emit(userId, 'meal_logged', calories, { meal_type: data.meal_type });
      }
      this.aiContext.invalidateForUser(userId);
      return entries;
    } catch (err) {
      // Two retries at once: the loser's keys collide; answer with the winner's entries.
      const raced = keys && isUniqueViolation(err) && (await this.entriesWithKeys(userId, keys));
      if (raced) return raced;
      throw err;
    }
  }

  private async ownMeal(userId: string, mealId: string) {
    const meal = await this.prisma.savedMeal.findFirst({
      where: { id: mealId, user_id: userId },
      include: WITH_ITEMS,
    });
    if (!meal) throw new NotFoundException('Saved meal not found');
    return meal;
  }

  /** Entries already written under these keys, in key order; null when none. */
  private async entriesWithKeys(userId: string, keys: string[]) {
    const rows = await this.prisma.loggedFoodEntry.findMany({
      where: { client_uuid: { in: keys } },
      include: WITH_FOOD,
    });
    if (rows.length === 0) return null;
    if (rows.some((r) => r.user_id !== userId)) throw new NotFoundException('Entry not found');
    return rows.sort((a, b) => keys.indexOf(a.client_uuid ?? '') - keys.indexOf(b.client_uuid ?? ''));
  }

  /** Resolves a food id or search id like POST /log/food; another person's custom food is not found. */
  private async resolveFood(userId: string, ref: string): Promise<string> {
    try {
      return await this.foodService.resolveOrImportId(ref, userId);
    } catch (err) {
      const notFound = err instanceof Error && /not found/i.test(err.message);
      if (notFound) throw new NotFoundException('Food not found');
      throw err;
    }
  }
}

/** 409 with a stable code for the app to show its own message (no UI yet). */
function limitReached(code: string, limit: number) {
  return new ConflictException({ code, limit });
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
