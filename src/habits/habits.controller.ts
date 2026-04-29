import { Controller, Get, Post, Delete, Body, Param, Query, UseGuards, Request, HttpCode, GoneException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { HabitsService } from './habits.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CreateHabitDto, LogHabitDto } from './habits.dto';

@ApiTags('habits')
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

  // GET /habits/streaks — REMOVED (doctrine cleanup).
  // Returns 410 Gone for one mobile release window before being deleted.
  // TODO: remove route entirely after one mobile release window.
  @Get('streaks')
  @HttpCode(410)
  async getStreaks() {
    throw new GoneException(
      'This endpoint has been removed. Habit streaks are no longer part of the product surface.',
    );
  }

  @Delete(':id')
  @HttpCode(204)
  async deleteHabit(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.habitsService.deleteHabit(req.user.id, id);
  }
}
