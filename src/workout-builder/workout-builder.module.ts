/**
 * WorkoutBuilderModule — CRUD for WorkoutPlan + WorkoutPlanExercise +
 * ClientWorkoutAssignment.  Imports ExerciseLibraryModule so WorkoutBuilderService
 * can optionally enrich plan responses with live exercise metadata.
 */

import { Module } from '@nestjs/common';
import { WorkoutBuilderController, AssignmentController } from './workout-builder.controller';
import { WorkoutBuilderService } from './workout-builder.service';
import { ExerciseLibraryModule } from '../exercise-library/exercise-library.module';

@Module({
  imports: [ExerciseLibraryModule],
  controllers: [WorkoutBuilderController, AssignmentController],
  providers: [WorkoutBuilderService],
  exports: [WorkoutBuilderService],
})
export class WorkoutBuilderModule {}
