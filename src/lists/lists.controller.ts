import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
  HttpCode,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { ListsService } from './lists.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { AddListItemDto, UpdateListItemDto } from './lists.dto';
import { ListType } from '@prisma/client';

function parseListType(type: string): ListType {
  if (type === 'grocery' || type === 'shopping') return type as ListType;
  throw new BadRequestException('List type must be "grocery" or "shopping"');
}

@ApiTags('lists')
@Controller('lists')
@UseGuards(JwtAuthGuard)
export class ListsController {
  constructor(private listsService: ListsService) {}

  /** GET /lists/:type — get all items in the list (ordered: unchecked first) */
  @Get(':type')
  async getList(@Request() req: AuthedRequest, @Param('type') type: string) {
    return this.listsService.getList(req.user.id, parseListType(type));
  }

  /** POST /lists/:type — add a new item */
  @Post(':type')
  async addItem(
    @Request() req: AuthedRequest,
    @Param('type') type: string,
    @Body() body: AddListItemDto,
  ) {
    return this.listsService.addItem(req.user.id, parseListType(type), body);
  }

  /** POST /lists/:type/clear-checked — delete all checked items */
  @Post(':type/clear-checked')
  @HttpCode(200)
  async clearChecked(@Request() req: AuthedRequest, @Param('type') type: string) {
    return this.listsService.clearChecked(req.user.id, parseListType(type));
  }

  /** POST /lists/:type/bulk — add multiple items at once (for PrepGuide) */
  @Post(':type/bulk')
  async bulkAdd(
    @Request() req: AuthedRequest,
    @Param('type') type: string,
    @Body() body: { items: AddListItemDto[] },
  ) {
    if (!Array.isArray(body.items) || body.items.length === 0) {
      throw new BadRequestException('items must be a non-empty array');
    }
    return this.listsService.bulkAddItems(req.user.id, parseListType(type), body.items);
  }

  /** PATCH /lists/items/:id — toggle checked, update quantity or name */
  @Patch('items/:id')
  async updateItem(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: UpdateListItemDto,
  ) {
    return this.listsService.updateItem(req.user.id, id, body);
  }

  /** DELETE /lists/items/:id — delete a single item */
  @Delete('items/:id')
  @HttpCode(204)
  async deleteItem(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.listsService.deleteItem(req.user.id, id);
  }
}
