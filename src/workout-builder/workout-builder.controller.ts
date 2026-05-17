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
  Headers,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { ClientEntitlementGuard } from '../common/guards/client-entitlement.guard';
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
  @UseGuards(JwtAuthGuard, CoachGuard)
  listPlans(@Req() req: AuthRequest) {
    return this.workoutBuilder.listPlans(req.user.id);
  }

  @Post()
  @UseGuards(JwtAuthGuard, CoachGuard)
  createPlan(@Req() req: AuthRequest, @Body() dto: CreateWorkoutPlanDto) {
    return this.workoutBuilder.createPlan(req.user.id, dto);
  }

  @Get(':planId')
  @UseGuards(JwtAuthGuard, CoachGuard)
  getPlan(@Req() req: AuthRequest, @Param('planId') planId: string) {
    return this.workoutBuilder.getPlan(req.user.id, planId);
  }

  @Patch(':planId')
  @UseGuards(JwtAuthGuard, CoachGuard)
  updatePlan(
    @Req() req: AuthRequest,
    @Param('planId') planId: string,
    @Body() dto: UpdateWorkoutPlanDto,
  ) {
    return this.workoutBuilder.updatePlan(req.user.id, planId, dto);
  }

  @Delete(':planId')
  @UseGuards(JwtAuthGuard, CoachGuard)
  archivePlan(@Req() req: AuthRequest, @Param('planId') planId: string) {
    return this.workoutBuilder.archivePlan(req.user.id, planId);
  }

  @Put(':planId/exercises')
  @UseGuards(JwtAuthGuard, CoachGuard)
  setExercises(
    @Req() req: AuthRequest,
    @Param('planId') planId: string,
    @Body() rows: UpsertExerciseRowDto[],
    // Optimistic-concurrency token. When the client has previously read the
    // plan it should echo back `If-Unmodified-Since: <plan.updated_at>` so
    // a parallel edit from another tab/device throws 409 instead of being
    // silently overwritten. Absent header → legacy "last write wins" path
    // (logged at the service layer). See QA P0-W2.
    @Headers('if-unmodified-since') ifUnmodifiedSince?: string,
  ) {
    return this.workoutBuilder.setExercises(req.user.id, planId, rows, {
      ifUnmodifiedSince,
    });
  }

  @Post(':planId/assignments')
  @UseGuards(JwtAuthGuard, CoachGuard)
  assignPlan(
    @Req() req: AuthRequest,
    @Param('planId') planId: string,
    @Body() dto: CreateAssignmentDto,
  ) {
    return this.workoutBuilder.assignPlan(req.user.id, planId, dto);
  }

  @Get(':planId/assignments')
  @UseGuards(JwtAuthGuard, CoachGuard)
  listAssignments(@Req() req: AuthRequest, @Param('planId') planId: string) {
    return this.workoutBuilder.listAssignments(req.user.id, planId);
  }
}

/** Separate controller for assignment listing/completion (client-facing). */
@Controller('assignments')
@UseGuards(JwtAuthGuard, ClientEntitlementGuard)
export class AssignmentController {
  constructor(private readonly workoutBuilder: WorkoutBuilderService) {}

  // Sprint B — client list of their own workout assignments. Returns
  // each assignment with its plan and exercise rows so the mobile app
  // can render "today's workout" without a second round-trip.
  @Get('me')
  @UseGuards(JwtAuthGuard)
  listMine(@Req() req: AuthRequest) {
    return this.workoutBuilder.listAssignmentsForClient(req.user.id);
  }

  @Get(':assignmentId')
  @UseGuards(JwtAuthGuard)
  getMine(@Req() req: AuthRequest, @Param('assignmentId') assignmentId: string) {
    return this.workoutBuilder.getAssignmentForClient(req.user.id, assignmentId);
  }

  @Patch(':assignmentId/complete')
  @UseGuards(JwtAuthGuard)
  complete(
    @Req() req: AuthRequest,
    @Param('assignmentId') assignmentId: string,
    @Body() dto: CompleteAssignmentDto,
  ) {
    return this.workoutBuilder.completeAssignment(req.user.id, assignmentId, dto);
  }
}
