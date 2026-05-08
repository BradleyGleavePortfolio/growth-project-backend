import { Controller, Get, Post, Body, Param, Query, UseGuards, NotFoundException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { FoodService } from './food.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CreateFoodDto } from './food.dto';

@ApiTags('food')
@Controller('foods')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
 FoodController {
  constructor(private foodService: FoodService) {}

  @Get('search')
  async search(@Query('q') q: string, @Query('limit') limit?: string) {
    return this.foodService.search(q, limit ? parseInt(limit, 10) : 50);
  }

  /**
   * GET /foods/barcode/:upc
   *
   * Look up a food item by UPC/barcode via OpenFoodFacts API.
   * Results are cached as FoodItem rows for instant future hits.
   * Maps the OpenFoodFacts product to the app's food schema.
   */
  @Get('barcode/:upc')
  async getByBarcode(@Param('upc') upc: string) {
    try {
      // upsertFromOpenFoodFacts is private — expose via a new public method.
      const id = await this.foodService.lookupByBarcode(upc);
      return this.foodService.getById(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Product not found';
      if (msg.includes('not found') || msg.includes('fetch failed')) {
        throw new NotFoundException(`Barcode ${upc} not found in OpenFoodFacts`);
      }
      throw err;
    }
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.foodService.getById(id);
  }

  // Gated to coach + owner + student. Coaches/owners create one-off custom foods
  // for client meal plans; students need this for their offline food-log queue
  // (the flush path calls POST /foods to materialise a FoodItem before logging
  // it). Throttled per-user to keep the typo-bots out. See QA P0-F2.
  @Post()
  @UseGuards(RolesGuard)
  @Roles('coach', 'owner', 'student')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async create(@Body() body: CreateFoodDto) {
    return this.foodService.create(body);
  }
}
