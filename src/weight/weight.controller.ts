import { Controller, Post, Get, Body, Query, UseGuards, Request } from '@nestjs/common';
import type { AuthedRequest } from '../auth/auth-request';
import { WeightService } from './weight.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@Controller('weight')
@UseGuards(JwtAuthGuard)
export class WeightController {
  constructor(private weightService: WeightService) {}

  @Post()
  async logWeight(@Request() req: AuthedRequest, @Body() body: any) {
    return this.weightService.logWeight(req.user.id, body);
  }

  @Get('history')
  async getHistory(@Request() req: AuthedRequest, @Query('days') days?: string) {
    return this.weightService.getHistory(req.user.id, days ? parseInt(days) : 30);
  }
}
