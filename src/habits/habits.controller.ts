import { Controller, Get, Post, Delete, Body, Param, Query, UseGuards, Request, HttpCode } from '@nestjs/common';
import type { AuthedRequest } from '../auth/auth-request';
import { HabitsService } from './habits.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CreateHabitDto, LogHabitDto } from './habits.dto';

@Controller('habits')
@UseGuards(JwtAuthGuard)
export class HabitsController {
  constructor(private habitsService: HabitsService) {}

  @Get()
  async getHabits(@Request() req: AuthedRequest) {
    return this.habitsService.getHabits(req.user.id);
  }

  @Post()
  async createHabit(@Request() req: AuthedRequest, @Body() body: CreateHabitDto) {
    return this.habitsService.createHabit(req.user.id, body);
  }

  @Post(':id/log')
  async logHabit(@Request() req: AuthedRequest, @Param('id') id: string, @Body() body: LogHabitDto) {
    return this.habitsService.logHabit(req.user.id, id, body);
  }

  @Get('logs')
  async getLogs(@Request() req: AuthedRequest, @Query('date') date: string) {
    const d = date || new Date().toISOString().split('T')[0];
    return this.habitsService.getLogs(req.user.id, d);
  }

  @Get('streaks')
  async getStreaks(@Request() req: AuthedRequest) {
    return this.habitsService.getStreaks(req.user.id);
  }

  @Delete(':id')
  @HttpCode(204)
  async deleteHabit(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.habitsService.deleteHabit(req.user.id, id);
  }
}
