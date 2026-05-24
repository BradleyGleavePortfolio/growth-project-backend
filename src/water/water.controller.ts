import { Controller, Post, Get, Body, Query, UseGuards, Request } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { WaterService } from './water.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { LogWaterDto } from './water.dto';

@ApiTags('nutrition')
@Controller('nutrition/water')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class WaterController {
  constructor(private waterService: WaterService) {}

  @Post()
  async logWater(@Request() req: AuthedRequest, @Body() body: LogWaterDto) {
    return this.waterService.logWater(req.user.id, body);
  }

  @Get()
  async getDaily(@Request() req: AuthedRequest, @Query('date') date: string) {
    const d = date || new Date().toISOString().split('T')[0];
    return this.waterService.getDaily(req.user.id, d);
  }

  @Get('weekly')
  async getWeekly(@Request() req: AuthedRequest, @Query('start_date') startDate: string) {
    const sd = startDate || new Date().toISOString().split('T')[0];
    return this.waterService.getWeekly(req.user.id, sd);
  }
}
