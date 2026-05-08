import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthedRequest } from '../auth/auth-request';
import { BuildWeekService } from './build-week.service';
import { CompleteDayDto } from './build-week.dto';

// Client-facing Build Week surface. JWT-gated; visible to every
// authenticated user (students, coaches, owners) — coaches and owners hit
// these to walk through the experience themselves before assigning it to
// clients. Tenancy isolation lives in coach-build-week.controller for
// reading another user's enrollment.
@ApiTags('build-week')
@Controller('build-week')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
 BuildWeekController {
  constructor(private readonly buildWeek: BuildWeekService) {}

  @Get('days')
  async getDays() {
    // Catalog read — no user scoping. Returns the 7-day arc.
    return { days: await this.buildWeek.getDays() };
  }

  @Post('enroll')
  async enroll(@Request() req: AuthedRequest) {
    return this.buildWeek.enroll(req.user.id);
  }

  @Get('me')
  async getMyEnrollment(@Request() req: AuthedRequest) {
    return { enrollment: await this.buildWeek.getMyEnrollment(req.user.id) };
  }

  @Get('days/:dayNumber')
  async getDayDetail(
    @Request() req: AuthedRequest,
    @Param('dayNumber', ParseIntPipe) dayNumber: number,
  ) {
    return this.buildWeek.getDayDetail(req.user.id, dayNumber);
  }

  @Post('days/:dayNumber/complete')
  async completeDay(
    @Request() req: AuthedRequest,
    @Param('dayNumber', ParseIntPipe) dayNumber: number,
    @Body() dto: CompleteDayDto,
  ) {
    return this.buildWeek.completeDay(req.user.id, dayNumber, dto);
  }
}
