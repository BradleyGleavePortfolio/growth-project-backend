/**
 * WorkoutBuilderAutosaveController — MWB-3 autosave + real-undo REST surface
 * (MASTER_WORKOUT_BUILDER_SPEC.md §6.2 autosave, §5.1 undo).
 *
 * Routes (coach-facing, under the existing /workout-plans namespace):
 *   PATCH /workout-plans/:planId/autosave   commit a batch of diff ops
 *   POST  /workout-plans/:planId/undo       undo/redo to a prior revision index
 *
 * Auth: JWT (JwtAuthGuard) + RBAC (@Roles('coach','owner') via RolesGuard) —
 * the same posture as WorkoutBuilderController's existing plan routes. The
 * service additionally authorises the acting user against the plan's owning
 * client via the MWB-1 §7.2 sub-coach scope gate (head coach OR open
 * sub-coach), so a sub-coach out of scope gets 403.
 *
 * Feature flag: MwbAutosaveUndoFeatureGuard is mounted at the HANDLER level on
 * both routes, returning 404 while FEATURE_MWB_AUTOSAVE_UNDO is OFF (default) so
 * the surface is invisible until an operator flips the flag — yet stays MOUNTED
 * so the module-graph cycle guard keeps exercising the wiring. The service
 * re-checks the flag inside every transaction (defence-in-depth).
 *
 * Body validation is zod (in the service), so each handler binds
 * `@Body() body: unknown` — the same pattern as the coach-media surface. No new
 * user-visible copy is introduced (operator face+voice contract): error
 * envelopes reuse the existing typed vocabulary.
 */

import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { MwbAutosaveUndoFeatureGuard } from './workout-builder-autosave-feature.guard';
import {
  AutosaveResponseDto,
  UndoResponseDto,
} from './workout-builder-autosave.dto';
import { WorkoutBuilderAutosaveService } from './workout-builder-autosave.service';

@ApiTags('workout-plans')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('coach', 'owner')
@Controller('workout-plans')
export class WorkoutBuilderAutosaveController {
  constructor(
    private readonly autosave: WorkoutBuilderAutosaveService,
  ) {}

  @Patch(':planId/autosave')
  @UseGuards(MwbAutosaveUndoFeatureGuard)
  @ApiOperation({
    summary:
      'MWB-3: autosave a batch of diff ops to a plan (Serializable txn, ' +
      'optimistic concurrency). Sub-coaches may autosave plans in their scope. ' +
      'Gated by FEATURE_MWB_AUTOSAVE_UNDO — returns 404 while the flag is off.',
  })
  @ApiResponse({ status: 200, description: 'New head revision committed.' })
  @ApiResponse({ status: 400, description: 'Invalid body / ops.' })
  @ApiResponse({ status: 403, description: 'No access to the plan.' })
  @ApiResponse({
    status: 404,
    description: 'Feature off or plan not found.',
  })
  @ApiResponse({
    status: 409,
    description:
      'autosave_lock_stale (stale lock_token) or autosave_conflict_retry ' +
      '(stale base_revision_index / serialization conflict).',
  })
  autosaveBatch(
    @Req() req: AuthedRequest,
    @Param('planId', new ParseUUIDPipe()) planId: string,
    @Body() body: unknown,
  ): Promise<AutosaveResponseDto> {
    return this.autosave.applyAutosave(
      planId,
      { userId: req.user.id },
      body,
    );
  }

  @Post(':planId/undo')
  @UseGuards(MwbAutosaveUndoFeatureGuard)
  @ApiOperation({
    summary:
      'MWB-3: undo (or redo) a plan to a prior revision index by writing a new ' +
      "head revision whose state = the target snapshot. Redo is 'undo to a " +
      "later index'. Gated by FEATURE_MWB_AUTOSAVE_UNDO — 404 while off.",
  })
  @ApiResponse({ status: 200, description: 'New head revision committed.' })
  @ApiResponse({ status: 400, description: 'Invalid target revision index.' })
  @ApiResponse({ status: 403, description: 'No access to the plan.' })
  @ApiResponse({
    status: 404,
    description: 'Feature off, plan, or target revision not found.',
  })
  @ApiResponse({
    status: 409,
    description: 'autosave_conflict_retry — serialization conflict.',
  })
  undo(
    @Req() req: AuthedRequest,
    @Param('planId', new ParseUUIDPipe()) planId: string,
    @Body() body: unknown,
  ): Promise<UndoResponseDto> {
    return this.autosave.applyUndo(planId, { userId: req.user.id }, body);
  }
}
