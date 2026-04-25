import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AddListItemDto, UpdateListItemDto } from './lists.dto';
import { ListType } from '@prisma/client';

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
    return this.prisma.listItem.create({
      data: {
        user_id: userId,
        list_type: listType,
        name: data.name,
        quantity: data.quantity ?? 1,
        unit: data.unit ?? null,
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

  // Bulk-add items (used by PrepGuide "Add to grocery list").
  async bulkAddItems(
    userId: string,
    listType: ListType,
    items: AddListItemDto[],
  ) {
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
          },
        }),
      ),
    );
    return { added: created.length };
  }
}
