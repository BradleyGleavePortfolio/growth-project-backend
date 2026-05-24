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

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RolesGuard } from '../auth/roles.guard';
import { ExerciseLibraryModule } from '../exercise-library/exercise-library.module';
import {
  AssignmentController,
  WorkoutBuilderController,
} from './workout-builder.controller';
import { WorkoutBuilderService } from './workout-builder.service';

@Module({
  imports: [AuthModule, ExerciseLibraryModule],
  controllers: [WorkoutBuilderController, AssignmentController],
  providers: [WorkoutBuilderService, RolesGuard],
  exports: [WorkoutBuilderService],
})
export class WorkoutBuilderModule {}
