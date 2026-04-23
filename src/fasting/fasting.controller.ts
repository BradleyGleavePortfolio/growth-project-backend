import { Controller, Post, Get, Body, Query, UseGuards, Request } from '@nestjs/common';
import type { AuthedRequest } from '../auth/auth-request';
import { FastingService } from './fasting.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { StartFastDto, EndFastDto } from './fasting.dto';

@Controller('fasting')
@UseGuards(JwtAuthGuard)
export class FastingController {
  constructor(private fastingService: FastingService) {}

  @Post('start')
  async startFast(@Request() req: AuthedRequest, @Body() body: StartFastDto) {
    return this.fastingService.startFast(req.user.id, body);
  }

  @Post('end')
  async endFast(@Request() req: AuthedRequest, @Body() body: EndFastDto) {
    return this.fastingService.endFast(req.user.id, body.notes);
  }

  @Get('history')
  async getHistory(@Request() req: AuthedRequest, @Query('limit') limit?: string) {
    return this.fastingService.getHistory(req.user.id, limit ? parseInt(limit) : 10);
  }
}
