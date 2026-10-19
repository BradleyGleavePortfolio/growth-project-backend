import { Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards, Request, HttpCode } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { HabitsService } from './habits.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { OpenToCoachlessClient } from '../common/decorators/open-to-coachless-client.decorator';
import { CreateHabitDto, HabitSummaryQuery, LogHabitDto, UpdateHabitDto } from './habits.dto';

@ApiTags('habits')
@Controller('habits')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
// B1 (owner 10-08 23:5x): basic self logging, open to every client and
// reachable during a Day-10 dunning lock (no package guard here either).
@OpenToCoachlessClient()
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

  // HB1: the client edits their habit; on one their coach set, only its reminder.
  @Patch(':id')
  async updateHabit(@Request() req: AuthedRequest, @Param('id') id: string, @Body() body: UpdateHabitDto) {
    return this.habitsService.updateHabit(req.user.id, id, body);
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

  // HB3: each day's planned and done, each habit's, and the best week.
  @Get('summary')
  async getSummary(@Request() req: AuthedRequest, @Query() query: HabitSummaryQuery) {
    return this.habitsService.getSummary(req.user.id, query);
  }

  // Archives the habit; its logs stay in the client's history (HB1).
  @Delete(':id')
  @HttpCode(204)
  async deleteHabit(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.habitsService.deleteHabit(req.user.id, id);
  }
}
