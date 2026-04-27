import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { FoodService } from '../food/food.service';
import { LogFoodDto, UpdateLogEntryDto } from './log.dto';
import { AnalyticsService } from '../analytics/analytics.service';
import { Events } from '../analytics/events';

@Injectable()
export class LogService {
  constructor(
    private prisma: PrismaService,
    private foodService: FoodService,
    private analytics: AnalyticsService,
  ) {}

  async logFood(userId: string, data: LogFoodDto) {
    // Mobile client may send synthetic ids ("usda_123", "off_456") returned by food search.
    // Resolve them to real FoodItem.id via upsert-on-log so the FK below can't blow up.
    const resolvedFoodItemId = await this.foodService.resolveOrImportId(data.food_item_id);
    const created = await this.prisma.loggedFoodEntry.create({
      data: {
        user_id: userId,
        date: new Date(data.date),
        meal_type: data.meal_type,
        food_item_id: resolvedFoodItemId,
        quantity_multiplier: data.quantity_multiplier ?? 1.0,
        notes: data.notes,
      },
      include: { food_item: true },
    });
    this.analytics.capture(userId, Events.CLIENT_FOOD_LOGGED, {
      meal_type: data.meal_type,
    });
    return created;
  }

  async getDaily(userId: string, date: string) {
    const targetDate = new Date(date);
    const entries = await this.prisma.loggedFoodEntry.findMany({
      where: { user_id: userId, date: targetDate },
      include: { food_item: true },
      orderBy: { logged_at: 'asc' },
    });

    const profile = await this.prisma.userProfile.findUnique({ where: { user_id: userId } });

    let total_calories = 0, total_protein_g = 0, total_carbs_g = 0, total_fat_g = 0;

    entries.forEach(e => {
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
      remaining_calories: Math.round((profile?.macro_target_calories || 2000) - total_calories),
      remaining_protein_g: Math.round((profile?.macro_target_protein_g || 180) - total_protein_g),
      remaining_carbs_g: Math.round((profile?.macro_target_carbs_g || 200) - total_carbs_g),
      remaining_fat_g: Math.round((profile?.macro_target_fat_g || 60) - total_fat_g),
      macro_targets: {
        calories: profile?.macro_target_calories || 2000,
        protein_g: profile?.macro_target_protein_g || 180,
        carbs_g: profile?.macro_target_carbs_g || 200,
        fat_g: profile?.macro_target_fat_g || 60,
      },
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
      },
    });
  }

  async deleteEntry(userId: string, entryId: string) {
    const entry = await this.prisma.loggedFoodEntry.findUnique({ where: { id: entryId } });
    if (!entry || entry.user_id !== userId) throw new NotFoundException('Entry not found');
    return this.prisma.loggedFoodEntry.delete({ where: { id: entryId } });
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
    entries.forEach(e => {
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
