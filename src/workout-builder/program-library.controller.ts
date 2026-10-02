/**
 * S-MWB Programs — coach program library routes (`/api/v1/coach/programs`).
 *
 * Gated by FEATURE_MWB_TEMPLATES (ProgramLibraryFeatureGuard, 404 with code
 * `programs_unavailable` while off). Coach / owner only; the service re-checks
 * role, tenancy, ownership and client access before every read and write.
 * Every create-style mutation requires an Idempotency-Key (UUID); bulk assign
 * uses it as the per-client exactly-once key.
 */
import {
  Body,
  CanActivate,
  Controller,
  Delete,
  Get,
  Injectable,
  NotFoundException,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RequiredIdempotencyKey } from './workout-builder.controller';
import { isMwbTemplatesEnabled } from './mwb-templates.feature';
import {
  BulkAssignProgramDto,
  CreateProgramDto,
  DuplicateProgramDto,
  SetProgramDayDto,
  UpdateProgramDto,
} from './program-library.dto';
import { ProgramLibraryService } from './program-library.service';

@Injectable()
export class ProgramLibraryFeatureGuard implements CanActivate {
  canActivate(): boolean {
    if (!isMwbTemplatesEnabled()) {
      throw new NotFoundException({
        code: 'programs_unavailable',
        message: 'Programs are not switched on for this server yet.',
      });
    }
    return true;
  }
}

function parseLimit(raw?: string): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

@ApiTags('coach-programs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, ProgramLibraryFeatureGuard)
@Roles('coach', 'owner')
@Controller('v1/coach/programs')
export class ProgramLibraryController {
  constructor(private readonly programs: ProgramLibraryService) {}

  @Get()
  @ApiOperation({
    summary:
      'Program library: search, goal tag, status, weeks x days, assigned and package counts.',
  })
  list(
    @Req() req: AuthedRequest,
    @Query('q') q?: string,
    @Query('goal_tag') goalTag?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.programs.listPrograms(req.user.id, {
      q,
      goal_tag: goalTag,
      status,
      limit: parseLimit(limit),
      cursor: cursor ?? null,
    });
  }

  @Get('saved-workouts')
  @ApiOperation({
    summary: 'Saved-workouts library: the coach standalone workouts (not part of a program).',
  })
  savedWorkouts(
    @Req() req: AuthedRequest,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.programs.listSavedWorkouts(req.user.id, {
      q,
      limit: parseLimit(limit),
      cursor: cursor ?? null,
    });
  }

  @Post()
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({ summary: 'Create an empty master program (weeks x 7 day slots).' })
  create(
    @Req() req: AuthedRequest,
    @Body() dto: CreateProgramDto,
    @RequiredIdempotencyKey() idempotencyKey: string,
  ) {
    return this.programs.createProgram(req.user.id, dto, idempotencyKey);
  }

  @Get(':programId')
  @ApiOperation({
    summary: 'Program detail with the week x day grid and the packages that deliver it.',
  })
  get(@Req() req: AuthedRequest, @Param('programId', new ParseUUIDPipe()) programId: string) {
    return this.programs.getProgram(req.user.id, programId);
  }

  @Patch(':programId')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiResponse({
    status: 409,
    description: 'program_version_conflict | program_days_out_of_range | program_archived',
  })
  update(
    @Req() req: AuthedRequest,
    @Param('programId', new ParseUUIDPipe()) programId: string,
    @Body() dto: UpdateProgramDto,
    @RequiredIdempotencyKey() idempotencyKey: string,
  ) {
    return this.programs.updateProgram(req.user.id, programId, dto, idempotencyKey);
  }

  @Put(':programId/days/:week/:day')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({
    summary: 'Fill an empty day: a blank workout, a saved workout copy, or a copy of another day.',
  })
  @ApiResponse({ status: 409, description: 'program_day_filled | program_archived' })
  setDay(
    @Req() req: AuthedRequest,
    @Param('programId', new ParseUUIDPipe()) programId: string,
    @Param('week', new ParseIntPipe()) week: number,
    @Param('day', new ParseIntPipe()) day: number,
    @Body() dto: SetProgramDayDto,
    @RequiredIdempotencyKey() idempotencyKey: string,
  ) {
    return this.programs.setDay(req.user.id, programId, week, day, dto, idempotencyKey);
  }

  @Delete(':programId/days/:week/:day')
  @ApiOperation({ summary: 'Clear a day (the workout is archived; idempotent).' })
  @ApiResponse({ status: 409, description: 'program_in_package_needs_a_day | program_archived' })
  clearDay(
    @Req() req: AuthedRequest,
    @Param('programId', new ParseUUIDPipe()) programId: string,
    @Param('week', new ParseIntPipe()) week: number,
    @Param('day', new ParseIntPipe()) day: number,
  ) {
    return this.programs.clearDay(req.user.id, programId, week, day);
  }

  @Post(':programId/duplicate')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  duplicate(
    @Req() req: AuthedRequest,
    @Param('programId', new ParseUUIDPipe()) programId: string,
    @Body() dto: DuplicateProgramDto,
    @RequiredIdempotencyKey() idempotencyKey: string,
  ) {
    return this.programs.duplicateProgram(req.user.id, programId, dto, idempotencyKey);
  }

  @Post(':programId/archive')
  @ApiResponse({ status: 409, description: 'program_in_package' })
  archive(@Req() req: AuthedRequest, @Param('programId', new ParseUUIDPipe()) programId: string) {
    return this.programs.archiveProgram(req.user.id, programId);
  }

  @Post(':programId/restore')
  restore(@Req() req: AuthedRequest, @Param('programId', new ParseUUIDPipe()) programId: string) {
    return this.programs.restoreProgram(req.user.id, programId);
  }

  @Get(':programId/revisions')
  revisions(@Req() req: AuthedRequest, @Param('programId', new ParseUUIDPipe()) programId: string) {
    return this.programs.listRevisions(req.user.id, programId);
  }

  @Get(':programId/assignees')
  assignees(@Req() req: AuthedRequest, @Param('programId', new ParseUUIDPipe()) programId: string) {
    return this.programs.listAssignees(req.user.id, programId);
  }

  @Post(':programId/assign')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({
    summary:
      'Bulk assign: copy the program onto each client from start_date. Exactly once per (Idempotency-Key, client); ' +
      'returns one result per client (assigned | already_assigned | failed with code + message).',
  })
  assign(
    @Req() req: AuthedRequest,
    @Param('programId', new ParseUUIDPipe()) programId: string,
    @Body() dto: BulkAssignProgramDto,
    @RequiredIdempotencyKey() idempotencyKey: string,
  ) {
    return this.programs.bulkAssign(req.user.id, programId, dto, idempotencyKey);
  }

  @Delete(':programId/assignees/:clientId')
  @ApiOperation({
    summary:
      'Remove the program from one client: their not-started workouts are removed, finished ones stay in history.',
  })
  unassign(
    @Req() req: AuthedRequest,
    @Param('programId', new ParseUUIDPipe()) programId: string,
    @Param('clientId') clientId: string,
  ) {
    return this.programs.unassignClient(req.user.id, programId, clientId);
  }
}
