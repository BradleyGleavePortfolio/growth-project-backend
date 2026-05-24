/**
 * WorkoutBuilderController + AssignmentController — REST surface for the
 * Phase 11 workout builder.
 *
 * Auth: every route is JWT-authenticated by the global JwtAuthGuard.
 * RBAC: coach-side routes additionally require @Roles('coach', 'owner')
 *       via RolesGuard. Owner is included in the RolesGuard hierarchy.
 *       Service-layer assertCoach() re-checks before any write.
 * Idempotency: coach mutations accept Idempotency-Key (UUID) header for
 *       safe client retries. Completion uses an in-body idempotency_key.
 * Pagination: list endpoints accept ?limit (≤50) and ?cursor (opaque).
 *
 * Route overview (workout-plans / coach-facing):
 *   GET    /workout-plans                         list coach's plans (paginated)
 *   POST   /workout-plans                         create plan
 *   GET    /workout-plans/:planId                 get single plan
 *   PATCH  /workout-plans/:planId                 update plan metadata
 *   DELETE /workout-plans/:planId                 archive plan
 *   PUT    /workout-plans/:planId/exercises       replace exercise rows
 *   POST   /workout-plans/:planId/assignments     assign plan to a client
 *   GET    /workout-plans/:planId/assignments     list assignments (paginated)
 *
 * Route overview (assignments / client-facing):
 *   GET    /assignments/me                        my upcoming + past assignments
 *   GET    /assignments/:assignmentId             single assignment (must be mine)
 *   PATCH  /assignments/:assignmentId/complete    mark complete
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import {
  CompleteAssignmentDto,
  CreateAssignmentDto,
  CreateWorkoutPlanDto,
  UpdateWorkoutPlanDto,
  UpsertExerciseRowsDto,
} from './workout-builder.dto';
import { WorkoutBuilderService } from './workout-builder.service';

const IDEMPOTENCY_HEADER = 'idempotency-key';

@ApiTags('workout-plans')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('coach', 'owner')
@Controller('workout-plans')
export class WorkoutBuilderController {
  constructor(private readonly workoutBuilder: WorkoutBuilderService) {}

  @Get()
  @ApiOperation({ summary: "List the calling coach's active workout plans (paginated)." })
  @ApiResponse({ status: 200, description: 'Paginated plan list.' })
  @ApiResponse({ status: 403, description: 'Not a coach.' })
  listPlans(
    @Req() req: AuthedRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.workoutBuilder.listPlans(req.user.id, {
      limit: limit ? Number(limit) : undefined,
      cursor: cursor ?? null,
    });
  }

  @Post()
  @ApiOperation({ summary: 'Create a new workout plan.' })
  @ApiHeader({
    name: 'Idempotency-Key',
    description: 'UUID — server dedups retries with the same key per coach.',
    required: false,
  })
  @ApiResponse({ status: 201, description: 'Plan created.' })
  @ApiResponse({ status: 403, description: 'Not a coach.' })
  createPlan(
    @Req() req: AuthedRequest,
    @Body() dto: CreateWorkoutPlanDto,
    @Headers(IDEMPOTENCY_HEADER) idempotencyKey?: string,
  ) {
    return this.workoutBuilder.createPlan(req.user.id, dto, idempotencyKey);
  }

  @Get(':planId')
  @ApiOperation({ summary: 'Get a single plan (with live exercises).' })
  getPlan(
    @Req() req: AuthedRequest,
    @Param('planId', new ParseUUIDPipe()) planId: string,
  ) {
    return this.workoutBuilder.getPlan(req.user.id, planId);
  }

  @Patch(':planId')
  @ApiOperation({ summary: "Update a plan's metadata." })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  updatePlan(
    @Req() req: AuthedRequest,
    @Param('planId', new ParseUUIDPipe()) planId: string,
    @Body() dto: UpdateWorkoutPlanDto,
    @Headers(IDEMPOTENCY_HEADER) idempotencyKey?: string,
  ) {
    return this.workoutBuilder.updatePlan(req.user.id, planId, dto, idempotencyKey);
  }

  @Delete(':planId')
  @ApiOperation({ summary: 'Soft-archive a plan.' })
  archivePlan(
    @Req() req: AuthedRequest,
    @Param('planId', new ParseUUIDPipe()) planId: string,
  ) {
    return this.workoutBuilder.archivePlan(req.user.id, planId);
  }

  @Put(':planId/exercises')
  @ApiOperation({
    summary:
      "Replace the plan's exercise list. Prior rows are soft-archived so " +
      'assigned clients keep seeing the snapshot they were assigned.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  setExercises(
    @Req() req: AuthedRequest,
    @Param('planId', new ParseUUIDPipe()) planId: string,
    @Body() body: UpsertExerciseRowsDto,
    @Headers(IDEMPOTENCY_HEADER) idempotencyKey?: string,
  ) {
    return this.workoutBuilder.setExercises(
      req.user.id,
      planId,
      body.rows,
      idempotencyKey,
    );
  }

  @Post(':planId/assignments')
  @ApiOperation({ summary: 'Assign a plan to a client.' })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  assignPlan(
    @Req() req: AuthedRequest,
    @Param('planId', new ParseUUIDPipe()) planId: string,
    @Body() dto: CreateAssignmentDto,
    @Headers(IDEMPOTENCY_HEADER) idempotencyKey?: string,
  ) {
    return this.workoutBuilder.assignPlan(req.user.id, planId, dto, idempotencyKey);
  }

  @Get(':planId/assignments')
  @ApiOperation({ summary: 'List assignments for a plan (paginated).' })
  listAssignments(
    @Req() req: AuthedRequest,
    @Param('planId', new ParseUUIDPipe()) planId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.workoutBuilder.listAssignments(req.user.id, planId, {
      limit: limit ? Number(limit) : undefined,
      cursor: cursor ?? null,
    });
  }
}

/**
 * Client-facing /assignments controller. Reachable by ANY authenticated
 * user (no role gate) because clients hold the `student` role, not
 * `coach`. Access is restricted at the service layer by client_id =
 * req.user.id checks (defense-in-depth atop RLS).
 */
@ApiTags('assignments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('assignments')
export class AssignmentController {
  constructor(private readonly workoutBuilder: WorkoutBuilderService) {}

  @Get('me')
  @ApiOperation({
    summary:
      "List the calling user's own workout assignments, including the " +
      'owning plan and its current exercises (paginated).',
  })
  @ApiResponse({ status: 200, description: 'Paginated assignment list.' })
  listMine(
    @Req() req: AuthedRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.workoutBuilder.listMyAssignments(req.user.id, {
      limit: limit ? Number(limit) : undefined,
      cursor: cursor ?? null,
    });
  }

  @Get(':assignmentId')
  @ApiOperation({
    summary:
      "Get a single assignment. 404 if the row does not exist OR does " +
      'not belong to the calling user.',
  })
  getOne(
    @Req() req: AuthedRequest,
    @Param('assignmentId', new ParseUUIDPipe()) assignmentId: string,
  ) {
    return this.workoutBuilder.getMyAssignment(req.user.id, assignmentId);
  }

  @Patch(':assignmentId/complete')
  @ApiOperation({
    summary:
      'Mark an assignment complete. Requires idempotency_key in the body ' +
      'for retry safety; replays return the original record.',
  })
  @ApiResponse({ status: 200, description: 'Assignment completed.' })
  @ApiResponse({
    status: 409,
    description: 'Assignment already completed with a different idempotency key.',
  })
  complete(
    @Req() req: AuthedRequest,
    @Param('assignmentId', new ParseUUIDPipe()) assignmentId: string,
    @Body() dto: CompleteAssignmentDto,
  ) {
    return this.workoutBuilder.completeAssignment(req.user.id, assignmentId, dto);
  }
}
