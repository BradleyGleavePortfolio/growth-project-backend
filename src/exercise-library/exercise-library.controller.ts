/**
 * ExerciseLibraryController — coach-facing exercise catalog search.
 *
 * Auth: every route is JWT-authenticated by the global JwtAuthGuard.
 * RBAC: gated to @Roles('coach', 'owner') via RolesGuard so students /
 *       clients cannot drain the platform's paid RapidAPI quota.
 *       Mirrors the WorkoutBuilderController gating exactly so the two
 *       coach-facing surfaces have identical posture.
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
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ExerciseLibraryService } from './exercise-library.service';
import { ExerciseSearchResult, Exercise } from './exercise.entity';

@ApiTags('exercises')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('coach', 'owner')
@Controller('exercises')
export class ExerciseLibraryController {
  constructor(private readonly exerciseLibrary: ExerciseLibraryService) {}

  /**
   * Search the ExerciseDB catalog.
   */
  @Get('search')
  @ApiOperation({
    summary:
      'Search the exercise catalog by name and/or filter by muscle group / equipment.',
  })
  @ApiQuery({ name: 'q', required: false, description: 'Free-text name search.' })
  @ApiQuery({
    name: 'muscleGroup',
    required: false,
    description: 'Filter by body part (e.g. chest, back, legs).',
  })
  @ApiQuery({
    name: 'equipment',
    required: false,
    description: 'Filter by equipment (e.g. barbell, dumbbell, body weight).',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Page size 1–100 (default 20).',
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: 'Opaque pagination cursor returned by a prior response.',
  })
  @ApiResponse({ status: 200, description: 'Paginated search result.' })
  @ApiResponse({ status: 400, description: 'limit out of range.' })
  @ApiResponse({
    status: 503,
    description: 'EXERCISEDB_NOT_CONFIGURED — upstream key missing.',
  })
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

  @Get(':id')
  @ApiOperation({
    summary: 'Retrieve a single exercise by its ExerciseDB catalog id.',
  })
  @ApiParam({ name: 'id', description: 'ExerciseDB exercise id.' })
  @ApiResponse({ status: 200, description: 'Exercise found.' })
  @ApiResponse({ status: 404, description: 'Exercise not found.' })
  async getById(@Param('id') id: string): Promise<Exercise> {
    return this.exerciseLibrary.getExerciseById(id);
  }
}
