import { Controller, Post, Get, Body, Query, UseGuards, Request } from '@nestjs/common';
import { WaterService } from './water.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@Controller('nutrition/water')
@UseGuards(JwtAuthGuard)
export class WaterController {
  constructor(private waterService: WaterService) {}

  @Post()
  async logWater(@Request() req, @Body() body: any) {
    return this.waterService.logWater(req.user.id, body);
  }

  @Get()
  async getDaily(@Request() req, @Query('date') date: string) {
    const d = date || new Date().toISOString().split('T')[0];
    return this.waterService.getDaily(req.user.id, d);
  }

  @Get('weekly')
  async getWeekly(@Request() req, @Query('start_date') startDate: string) {
    const sd = startDate || new Date().toISOString().split('T')[0];
    return this.waterService.getWeekly(req.user.id, sd);
  }
}
