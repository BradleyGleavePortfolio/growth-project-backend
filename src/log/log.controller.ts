import { Controller, Post, Get, Put, Delete, Body, Param, Query, UseGuards, Request } from '@nestjs/common';
import type { AuthedRequest } from '../auth/auth-request';
import { LogService } from './log.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { LogFoodDto, UpdateLogEntryDto } from './log.dto';

@Controller('log')
@UseGuards(JwtAuthGuard)
export class LogController {
  constructor(private logService: LogService) {}

  @Post('food')
  async logFood(@Request() req: AuthedRequest, @Body() body: LogFoodDto) {
    return this.logService.logFood(req.user.id, body);
  }

  @Get('daily')
  async getDaily(@Request() req: AuthedRequest, @Query('date') date: string) {
    const d = date || new Date().toISOString().split('T')[0];
    return this.logService.getDaily(req.user.id, d);
  }

  @Put('food/:id')
  async updateEntry(@Request() req: AuthedRequest, @Param('id') id: string, @Body() body: UpdateLogEntryDto) {
    return this.logService.updateEntry(req.user.id, id, body);
  }

  @Delete('food/:id')
  async deleteEntry(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.logService.deleteEntry(req.user.id, id);
  }

  @Get('weekly')
  async getWeekly(@Request() req: AuthedRequest, @Query('week_start') weekStart: string) {
    const ws = weekStart || new Date().toISOString().split('T')[0];
    return this.logService.getWeekly(req.user.id, ws);
  }
}
