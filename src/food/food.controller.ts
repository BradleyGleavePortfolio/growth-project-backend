import { Controller, Get, Post, Body, Param, Query, UseGuards } from '@nestjs/common';
import { FoodService } from './food.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@Controller('foods')
@UseGuards(JwtAuthGuard)
export class FoodController {
  constructor(private foodService: FoodService) {}

  @Get('search')
  async search(@Query('q') q: string, @Query('limit') limit?: string) {
    return this.foodService.search(q, limit ? parseInt(limit, 10) : 20);
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.foodService.getById(id);
  }

  @Post()
  async create(@Body() body: any) {
    return this.foodService.create(body);
  }
}
