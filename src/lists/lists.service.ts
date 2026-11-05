import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AddListItemDto, BulkListItemDto, UpdateListItemDto } from './lists.dto';
import { ListType } from '@prisma/client';
import { canonicalIngredientUnit } from '../common/ingredient-unit';

@Injectable()
export class ListsService {
  constructor(private prisma: PrismaService) {}

  async getList(userId: string, listType: ListType) {
    const items = await this.prisma.listItem.findMany({
      where: { user_id: userId, list_type: listType },
      orderBy: [{ is_checked: 'asc' }, { added_at: 'desc' }],
    });
    return items;
  }

  async addItem(userId: string, listType: ListType, data: AddListItemDto) {
    const name = data.name.trim();
    const unit = canonicalIngredientUnit(data.unit) || null;
    const candidates = await this.prisma.listItem.findMany({
      where: {
        user_id: userId, list_type: listType, is_checked: false,
        name: { equals: name, mode: 'insensitive' },
      },
    });
    const existing = candidates.find((item) =>
      (canonicalIngredientUnit(item.unit) || null) === unit,
    );
    if (existing) {
      return this.prisma.listItem.update({
        where: { id: existing.id },
        data: { quantity: { increment: data.quantity ?? 1 }, unit },
      });
    }
    return this.prisma.listItem.create({
      data: {
        user_id: userId,
        list_type: listType,
        name,
        quantity: data.quantity ?? 1,
        unit,
        source_recipe_id: data.source_recipe_id ?? null,
      },
    });
  }

  async updateItem(userId: string, itemId: string, data: UpdateListItemDto) {
    const item = await this.prisma.listItem.findUnique({ where: { id: itemId } });
    if (!item) throw new NotFoundException('List item not found');
    if (item.user_id !== userId) throw new ForbiddenException('Not your list item');

    return this.prisma.listItem.update({
      where: { id: itemId },
      data: {
        ...(data.is_checked !== undefined ? { is_checked: data.is_checked } : {}),
        ...(data.quantity !== undefined ? { quantity: data.quantity } : {}),
        ...(data.name !== undefined ? { name: data.name } : {}),
      },
    });
  }

  async deleteItem(userId: string, itemId: string) {
    const item = await this.prisma.listItem.findUnique({ where: { id: itemId } });
    if (!item) throw new NotFoundException('List item not found');
    if (item.user_id !== userId) throw new ForbiddenException('Not your list item');

    await this.prisma.listItem.delete({ where: { id: itemId } });
    return { deleted: true };
  }

  async clearChecked(userId: string, listType: ListType) {
    const result = await this.prisma.listItem.deleteMany({
      where: { user_id: userId, list_type: listType, is_checked: true },
    });
    return { deleted: result.count };
  }

  // Bulk-add items (used by PrepGuide "Add to grocery list", and by a plan meal's "Add to grocery list").
  // PLAN-SWAPS-BE: an item keeps source_plan_slot_id only when that slot is in a plan assigned to the
  // caller; any other id (another client's plan, a removed meal, a made-up id) is stored as null, as
  // FOODLINK does for a food log's plan_slot_id (log.service.ts), so the add itself never fails on it.
  async bulkAddItems(
    userId: string,
    listType: ListType,
    items: BulkListItemDto[],
  ) {
    const asked = [...new Set(items.flatMap((i) => (i.source_plan_slot_id ? [i.source_plan_slot_id] : [])))];
    const own = asked.length > 0
      ? new Set((await this.prisma.dailyMealPlanSlot.findMany({
          where: { id: { in: asked }, daily_meal_plan: { assignments: { some: { client_id: userId } } } },
          select: { id: true },
        })).map((s) => s.id))
      : new Set<string>();
    const created = await this.prisma.$transaction(
      items.map((item) =>
        this.prisma.listItem.create({
          data: {
            user_id: userId,
            list_type: listType,
            name: item.name,
            quantity: item.quantity ?? 1,
            unit: item.unit ?? null,
            source_recipe_id: item.source_recipe_id ?? null,
            source_plan_slot_id: item.source_plan_slot_id && own.has(item.source_plan_slot_id) ? item.source_plan_slot_id : null,
          },
        }),
      ),
    );
    return { added: created.length };
  }
}
