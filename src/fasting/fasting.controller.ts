import { Controller, Post, Get, Body, Query, UseGuards, Request } from '@nestjs/common';
import { FastingService } from './fasting.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@Controller('fasting')
@UseGuards(JwtAuthGuard)
export class FastingController {
  constructor(private fastingService: FastingService) {}

  @Post('start')
  async startFast(@Request() req, @Body() body: any) {
    return this.fastingService.startFast(req.user.id, body);
  }

  @Post('end')
  async endFast(@Request() req, @Body() body: any) {
    return this.fastingService.endFast(req.user.id, body.notes);
  }

  @Get('history')
  async getHistory(@Request() req, @Query('limit') limit?: string) {
    return this.fastingService.getHistory(req.user.id, limit ? parseInt(limit) : 10);
  }
}
