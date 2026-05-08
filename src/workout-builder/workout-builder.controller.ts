/**
 * WorkoutBuilderController — REST surface for WorkoutPlan management.
 *
 * All routes require a valid JWT (global JwtAuthGuard).
 *
 * Route overview:
 *   GET    /workout-plans                         list coach's plans
 *   POST   /workout-plans                         create plan
 *   GET    /workout-plans/:planId                 get single plan
 *   PATCH  /workout-plans/:planId                 update plan metadata
 *   DELETE /workout-plans/:planId                 archive plan
 *   PUT    /workout-plans/:planId/exercises       replace all exercise rows
 *   POST   /workout-plans/:planId/assignments     assign to a client
 *   GET    /workout-plans/:planId/assignments     list assignments
 *   PATCH  /assignments/:assignmentId/complete    client marks complete
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { WorkoutBuilderService } from './workout-builder.service';
import {
  CreateWorkoutPlanDto,
  UpdateWorkoutPlanDto,
  UpsertExerciseRowDto,
  CreateAssignmentDto,
  CompleteAssignmentDto,
} from './workout-builder.dto';
import type { Request } from 'express';

interface AuthRequest extends Request {
  user: { id: string };
}

@Controller('workout-plans')
export class WorkoutBuilderController {
  constructor(private readonly workoutBuilder: WorkoutBuilderService) {}

  @Get()
  listPlans(@Req() req: AuthRequest) {
    return this.workoutBuilder.listPlans(req.user.id);
  }

  @Post()
  createPlan(@Req() req: AuthRequest, @Body() dto: CreateWorkoutPlanDto) {
    return this.workoutBuilder.createPlan(req.user.id, dto);
  }

  @Get(':planId')
  getPlan(@Req() req: AuthRequest, @Param('planId') planId: string) {
    return this.workoutBuilder.getPlan(req.user.id, planId);
  }

  @Patch(':planId')
  updatePlan(
    @Req() req: AuthRequest,
    @Param('planId') planId: string,
    @Body() dto: UpdateWorkoutPlanDto,
  ) {
    return this.workoutBuilder.updatePlan(req.user.id, planId, dto);
  }

  @Delete(':planId')
  archivePlan(@Req() req: AuthRequest, @Param('planId') planId: string) {
    return this.workoutBuilder.archivePlan(req.user.id, planId);
  }

  @Put(':planId/exercises')
  setExercises(
    @Req() req: AuthRequest,
    @Param('planId') planId: string,
    @Body() rows: UpsertExerciseRowDto[],
  ) {
    return this.workoutBuilder.setExercises(req.user.id, planId, rows);
  }

  @Post(':planId/assignments')
  assignPlan(
    @Req() req: AuthRequest,
    @Param('planId') planId: string,
    @Body() dto: CreateAssignmentDto,
  ) {
    return this.workoutBuilder.assignPlan(req.user.id, planId, dto);
  }

  @Get(':planId/assignments')
  listAssignments(@Req() req: AuthRequest, @Param('planId') planId: string) {
    return this.workoutBuilder.listAssignments(req.user.id, planId);
  }
}

/** Separate controller for assignment completion (client-facing). */
@Controller('assignments')
export class AssignmentController {
  constructor(private readonly workoutBuilder: WorkoutBuilderService) {}

  @Patch(':assignmentId/complete')
  complete(
    @Req() req: AuthRequest,
    @Param('assignmentId') assignmentId: string,
    @Body() dto: CompleteAssignmentDto,
  ) {
    return this.workoutBuilder.completeAssignment(req.user.id, assignmentId, dto);
  }
}
