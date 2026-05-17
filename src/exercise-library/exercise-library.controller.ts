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
import { ExerciseVideoFallbackService } from './exercise-video-provider.service';

@Controller('exercises')
export class ExerciseLibraryController {
  constructor(
    private readonly exerciseLibrary: ExerciseLibraryService,
    private readonly videoFallback: ExerciseVideoFallbackService,
  ) {}

  /**
   * Search the ExerciseDB catalog.
   *
   * Query params:
   *   q           — free-text name search (optional)
   *   muscleGroup — filter by body part (optional)
   *   equipment   — filter by equipment (optional)
   *   limit       — page size 1–100 (default 20)
   *   cursor      — opaque pagination cursor from a prior response
   *
   * Note: video_url is NOT enriched on list results to keep list
   * responses fast. Clients fetch /exercises/:id for video-enriched
   * detail view.
   */
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

    // Stamp video_url: null on list items — video enrichment only on detail.
    return {
      ...result,
      items: result.items.map((item) => ({
        ...item,
        video_url: null,
        video_provider: null,
      })),
    };
  }

  /**
   * Retrieve a single exercise by its ExerciseDB catalog id.
   *
   * Appends `video_url` from the video provider fallback chain:
   *   1. YMove (HLS, pre-signed, 3h cache)
   *   2. MuscleWiki (stable MP4, 24h cache)
   *   3. null → caller renders gifUrl as fallback
   *
   * The lookup is non-blocking: if both providers fail or are
   * unconfigured, the endpoint still returns the exercise with
   * `video_url: null`. No 5xx is surfaced to the client.
   */
  @Get(':id')
  async getById(@Param('id') id: string): Promise<Exercise> {
    const [exercise, videoResult] = await Promise.all([
      this.exerciseLibrary.getExerciseById(id),
      this.videoFallback.getVideoUrl(id).catch(() => ({ url: null, provider: null })),
    ]);

    // We use the exercise name for provider matching, not the id. If the
    // exercise fetch fails, getExerciseById already throws NotFoundException.
    // Fetch the video again using the resolved name when id != name.
    let video = videoResult;
    if (!video.url && exercise.name) {
      video = await this.videoFallback
        .getVideoUrl(exercise.name)
        .catch(() => ({ url: null, provider: null }));
    }

    return {
      ...exercise,
      video_url: video.url,
      video_provider: video.provider as 'ymove' | 'musclewiki' | null,
    };
  }
}
