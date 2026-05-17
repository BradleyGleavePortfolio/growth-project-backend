/**
 * ExerciseLibraryController — coach-facing exercise catalog search.
 *
 * All routes are protected by the global JwtAuthGuard; no @Public() decorator.
 *
 * Routes:
 *   GET /exercises/search   — paginated search with optional filters
 *   GET /exercises/:id      — single exercise by ExerciseDB id
 *                             Appends `video_url` from ExerciseVideoFallbackService
 *                             (YMove HLS preferred, MuscleWiki MP4 fallback, then null)
 */

import {
  Controller,
  Get,
  Param,
  Query,
  ParseIntPipe,
  DefaultValuePipe,
  BadRequestException,
} from '@nestjs/common';
import { ExerciseLibraryService } from './exercise-library.service';
import { ExerciseSearchResult, Exercise } from './exercise.entity';
import { ExerciseVideoFallbackService } from '../exercise-catalog/exercise-video-provider.service';

@Controller('exercises')
export class ExerciseLibraryController {
  constructor(
    private readonly exerciseLibrary: ExerciseLibraryService,
    private readonly videoFallback: ExerciseVideoFallbackService,
  ) {}

  @Get('search')
  async search(
    @Query('q') q?: string,
    @Query('muscleGroup') muscleGroup?: string,
    @Query('equipment') equipment?: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit?: number,
    @Query('cursor') cursor?: string,
  ): Promise<ExerciseSearchResult> {
    if (limit !== undefined && (limit < 1 || limit > 100)) {
      throw new BadRequestException('limit must be between 1 and 100');
    }
    const result = await this.exerciseLibrary.searchExercises({
      q: q?.trim() || undefined,
      muscleGroup: muscleGroup?.trim() || undefined,
      equipment: equipment?.trim() || undefined,
      limit,
      cursor,
    });

    return {
      ...result,
      items: result.items.map((item) => ({
        ...item,
        video_url: null,
        video_provider: null,
      })),
    };
  }

  @Get(':id')
  async getById(@Param('id') id: string): Promise<Exercise> {
    const exercise = await this.exerciseLibrary.getExerciseById(id);

    const video = await this.videoFallback
      .getVideoUrl(exercise.name)
      .catch(() => ({ url: null, provider: null }));

    return {
      ...exercise,
      video_url: video.url,
      video_provider: video.provider as 'ymove' | 'musclewiki' | null,
    };
  }
}
