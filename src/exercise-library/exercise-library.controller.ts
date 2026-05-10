/**
 * ExerciseLibraryController — coach-facing exercise catalog search.
 *
 * All routes are protected by the global JwtAuthGuard; no @Public() decorator.
 *
 * Routes:
 *   GET /exercises/search   — paginated search with optional filters
 *   GET /exercises/:id      — single exercise by ExerciseDB id
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

@Controller('exercises')
export class ExerciseLibraryController {
  constructor(private readonly exerciseLibrary: ExerciseLibraryService) {}

  /**
   * Search the ExerciseDB catalog.
   *
   * Query params:
   *   q           — free-text name search (optional)
   *   muscleGroup — filter by body part (optional)
   *   equipment   — filter by equipment (optional)
   *   limit       — page size 1–100 (default 20)
   *   cursor      — opaque pagination cursor from a prior response
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
    return this.exerciseLibrary.searchExercises({
      q: q?.trim() || undefined,
      muscleGroup: muscleGroup?.trim() || undefined,
      equipment: equipment?.trim() || undefined,
      limit,
      cursor,
    });
  }

  /**
   * Retrieve a single exercise by its ExerciseDB catalog id.
   */
  @Get(':id')
  async getById(@Param('id') id: string): Promise<Exercise> {
    return this.exerciseLibrary.getExerciseById(id);
  }
}
