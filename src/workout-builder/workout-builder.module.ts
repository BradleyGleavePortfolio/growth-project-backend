/**
 * WorkoutBuilderModule — CRUD for WorkoutPlan + WorkoutPlanExercise +
 * ClientWorkoutAssignment.  Imports ExerciseLibraryModule so WorkoutBuilderService
 * can optionally enrich plan responses with live exercise metadata.
 */

import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { JwksVerifierService } from '../auth/jwks.service';
import { WorkoutBuilderController, AssignmentController } from './workout-builder.controller';
import { WorkoutBuilderService } from './workout-builder.service';
import { ExerciseLibraryModule } from '../exercise-library/exercise-library.module';
import { ExerciseCatalogModule } from '../exercise-catalog/exercise-catalog.module';

// PrismaService is global. Providing JwtAuthGuard / CoachGuard /
// JwksVerifierService locally mirrors MacrosModule / MealPlansModule
// and avoids the circular-import risk of pulling AuthModule.
@Module({
  imports: [ExerciseLibraryModule, ExerciseCatalogModule],
  controllers: [WorkoutBuilderController, AssignmentController],
  providers: [WorkoutBuilderService, JwtAuthGuard, CoachGuard, JwksVerifierService],
  exports: [WorkoutBuilderService],
})
export class WorkoutBuilderModule {}
