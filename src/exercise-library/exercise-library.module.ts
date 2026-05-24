/**
 * ExerciseLibraryModule — wires the ExerciseDB API adapter into the NestJS DI
 * container and exports ExerciseLibraryService for optional injection by other
 * modules (e.g. WorkoutBuilderModule).
 */

import { Module } from '@nestjs/common';
import { ExerciseLibraryController } from './exercise-library.controller';
import { ExerciseLibraryService } from './exercise-library.service';

@Module({
  controllers: [ExerciseLibraryController],
  providers: [ExerciseLibraryService],
  exports: [ExerciseLibraryService],
})
export class ExerciseLibraryModule {}
