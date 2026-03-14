import { Controller, Get, Post, Body, Param, UseGuards, Request } from '@nestjs/common';
import { HabitsService } from './habits.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@Controller('habits')
@UseGuards(JwtAuthGuard)
export class HabitsController {
  constructor(private habitsService: HabitsService) {}

  @Get()
  async getHabits(@Request() req) {
    return this.habitsService.getHabits(req.user.id);
  }

  @Post()
  async createHabit(@Request() req, @Body() body: any) {
    return this.habitsService.createHabit(req.user.id, body);
  }

  @Post(':id/log')
  async logHabit(@Request() req, @Param('id') id: string, @Body() body: any) {
    return this.habitsService.logHabit(req.user.id, id, body);
  }

  @Get('streaks')
  async getStreaks(@Request() req) {
    return this.habitsService.getStreaks(req.user.id);
  }
}
