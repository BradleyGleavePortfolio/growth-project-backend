import { Controller, Post, Get, Put, Delete, Body, Param, Query, UseGuards, Request } from '@nestjs/common';
import type { AuthedRequest } from '../auth/auth-request';
import { WorkoutService } from './workout.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CreateWorkoutDto, CreateRoutineDto, UpdateRoutineDto } from './workout.dto';

@Controller()
@UseGuards(JwtAuthGuard)
export class WorkoutController {
  constructor(private workoutService: WorkoutService) {}

  @Post('workouts')
  async createWorkout(@Request() req: AuthedRequest, @Body() body: CreateWorkoutDto) {
    return this.workoutService.createWorkout(req.user.id, body);
  }

  @Get('workouts')
  async getWorkouts(@Request() req: AuthedRequest, @Query('limit') limit?: string) {
    return this.workoutService.getWorkouts(req.user.id, limit ? parseInt(limit) : 10);
  }

  @Get('workouts/volume')
  async getVolume(@Request() req: AuthedRequest, @Query('period') period?: 'week' | 'month') {
    return this.workoutService.getVolume(req.user.id, period || 'week');
  }

  @Get('routines')
  async getRoutines(@Request() req: AuthedRequest) {
    return this.workoutService.getRoutines(req.user.id);
  }

  @Post('routines')
  async createRoutine(@Request() req: AuthedRequest, @Body() body: CreateRoutineDto) {
    return this.workoutService.createRoutine(req.user.id, body);
  }

  @Put('routines/:id')
  async updateRoutine(@Request() req: AuthedRequest, @Param('id') id: string, @Body() body: UpdateRoutineDto) {
    return this.workoutService.updateRoutine(req.user.id, id, body);
  }

  @Delete('routines/:id')
  async deleteRoutine(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.workoutService.deleteRoutine(req.user.id, id);
  }
}
