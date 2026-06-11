/**
 * WorkoutBuilderModule — CRUD for WorkoutPlan + WorkoutPlanExercise +
 * ClientWorkoutAssignment.
 *
 * AuthModule import wires JwtAuthGuard + JwksVerifierService into this
 * module's DI scope so @UseGuards(JwtAuthGuard, RolesGuard) resolves
 * locally (mirrors AdminModule). RolesGuard is provided locally because
 * it is not @Global; the global RolesGuard pattern would only matter if
 * we wanted @Roles to gate every route. Coach-side routes set
 * @Roles('coach', 'owner'); client-facing /assignments routes intentionally
 * have no role gate (they're reachable by students too).
 *
 * ExerciseLibraryModule import is retained for future enrichment of plan
 * responses with live exercise metadata.
 */

import { forwardRef, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RolesGuard } from '../auth/roles.guard';
import { ExerciseLibraryModule } from '../exercise-library/exercise-library.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PackagesModule } from '../packages/packages.module';
import { SubCoachModule } from '../sub-coach/sub-coach.module';
import {
  AssignmentController,
  WorkoutBuilderController,
  WorkoutProgramController,
} from './workout-builder.controller';
import { WorkoutBuilderService } from './workout-builder.service';
import { MwbTemplatesFeatureGuard } from './mwb-templates-feature.guard';
import { WorkoutBuilderAutosaveController } from './workout-builder-autosave.controller';
import { WorkoutBuilderAutosaveService } from './workout-builder-autosave.service';
import { MwbAutosaveUndoFeatureGuard } from './workout-builder-autosave-feature.guard';
import { WorkoutBuilderRevisionPruneCron } from './workout-builder-revision-prune.cron';

// PR-11 — PackagesModule is imported with forwardRef so DripTriggerService
// is reachable from WorkoutBuilderService.completeAssignment to fire
// on_completion drip drops. The forwardRef is defensive: PackagesModule
// today does NOT import WorkoutBuilderModule, but AssignableAssetResolversModule
// (@Global) does, and a future refactor of the resolver wiring could
// introduce a cycle that the forwardRef cleanly absorbs.

// MWB-1: SubCoachModule (@Global, but imported explicitly per spec §7 so the
// dependency is legible) provides SubCoachScopeService for assertCanAccessClient.
// NotificationsModule provides NotificationsService so coach-driven assigns emit
// the same WORKOUT_ASSIGNED push as the AI assign-workout materialiser (§3.3).
@Module({
  imports: [
    AuthModule,
    ExerciseLibraryModule,
    forwardRef(() => PackagesModule),
    SubCoachModule,
    NotificationsModule,
  ],
  controllers: [
    WorkoutBuilderController,
    WorkoutProgramController,
    AssignmentController,
    // MWB-3 (§5/§6) — autosave + real-undo surface. Stays mounted at all times;
    // MwbAutosaveUndoFeatureGuard 404s the handlers while the flag is off.
    WorkoutBuilderAutosaveController,
  ],
  providers: [
    WorkoutBuilderService,
    RolesGuard,
    MwbTemplatesFeatureGuard,
    // MWB-3 — autosave/undo domain service, its handler-level feature guard, and
    // the 6-hourly revision-prune cron (operator decision C: retain 30). The
    // cron self-checks FEATURE_MWB_AUTOSAVE_UNDO and no-ops when off.
    WorkoutBuilderAutosaveService,
    MwbAutosaveUndoFeatureGuard,
    WorkoutBuilderRevisionPruneCron,
  ],
  exports: [WorkoutBuilderService, WorkoutBuilderAutosaveService],
})
export class WorkoutBuilderModule {}
