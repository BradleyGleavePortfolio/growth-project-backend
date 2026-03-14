import { Controller, Post, Get, Put, Delete, Body, Param, Query, UseGuards, Request } from '@nestjs/common';
import { WorkoutService } from './workout.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@Controller()
@UseGuards(JwtAuthGuard)
export class WorkoutController {
  constructor(private workoutService: WorkoutService) {}

  @Post('workouts')
  async createWorkout(@Request() req, @Body() body: any) {
    return this.workoutService.createWorkout(req.user.id, body);
  }

  @Get('workouts')
  async getWorkouts(@Request() req, @Query('limit') limit?: string) {
    return this.workoutService.getWorkouts(req.user.id, limit ? parseInt(limit) : 10);
  }

  @Get('workouts/volume')
  async getVolume(@Request() req, @Query('period') period?: 'week' | 'month') {
    return this.workoutService.getVolume(req.user.id, period || 'week');
  }

  @Get('routines')
  async getRoutines(@Request() req) {
    return this.workoutService.getRoutines(req.user.id);
  }

  @Post('routines')
  async createRoutine(@Request() req, @Body() body: any) {
    return this.workoutService.createRoutine(req.user.id, body);
  }

  @Put('routines/:id')
  async updateRoutine(@Request() req, @Param('id') id: string, @Body() body: any) {
    return this.workoutService.updateRoutine(req.user.id, id, body);
  }

  @Delete('routines/:id')
  async deleteRoutine(@Request() req, @Param('id') id: string) {
    return this.workoutService.deleteRoutine(req.user.id, id);
  }
}
