import { Controller, Get, Post, Body, Param, Query, UseGuards, NotFoundException } from '@nestjs/common';
import { FoodService } from './food.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CreateFoodDto } from './food.dto';

@Controller('foods')
@UseGuards(JwtAuthGuard)
export class FoodController {
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
    } catch (err: any) {
      const msg = err?.message || 'Product not found';
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

  @Post()
  async create(@Body() body: CreateFoodDto) {
    return this.foodService.create(body);
  }
}
