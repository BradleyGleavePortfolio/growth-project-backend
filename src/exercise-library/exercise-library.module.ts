/**
 * ExerciseLibraryModule — wires the ExerciseDB API adapter into the NestJS DI
 * container and exports ExerciseLibraryService for optional injection by other
 * modules (e.g. WorkoutBuilderModule).
 *
 * Imports ExerciseVideoProviderModule to make ExerciseVideoFallbackService
 * available for injection into ExerciseLibraryController — used to enrich
 * GET /exercises/:id responses with video_url from YMove / MuscleWiki.
 */

import { Module } from '@nestjs/common';
import { ExerciseLibraryController } from './exercise-library.controller';
import { ExerciseLibraryService } from './exercise-library.service';
import { ExerciseVideoProviderModule } from '../exercise-catalog/exercise-video-provider.module';

@Module({
  imports: [ExerciseVideoProviderModule],
  controllers: [ExerciseLibraryController],
  providers: [ExerciseLibraryService],
  exports: [ExerciseLibraryService],
})
export class ExerciseLibraryModule {}
