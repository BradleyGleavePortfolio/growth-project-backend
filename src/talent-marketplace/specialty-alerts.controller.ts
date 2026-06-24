// TM-9b — Specialty alerts. Applicant-facing /me/alerts/* surface: list
// specialty-matched published listings and save the matching preference (the
// applicant's own specialties column). Owner-scoped on the JWT subject.

import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { Roles } from '../common/decorators/roles.decorator';
import {
  AlertPreferencesDto,
  AlertsQueryDto,
  type AlertsListResponseDto,
} from './specialty-alerts.dto';
import { SpecialtyAlertsService } from './specialty-alerts.service';

// JwtAuthGuard + RolesGuard are global APP_GUARDs (app.module.ts), so @Roles
// alone enforces the student tier — no per-controller @UseGuards needed.
@ApiTags('talent-marketplace')
@Controller('talent-marketplace/me/alerts')
@Roles('student')
export class SpecialtyAlertsController {
  constructor(private readonly alerts: SpecialtyAlertsService) {}

  @Get()
  async myAlerts(
    @Req() req: AuthedRequest,
    @Query() query: AlertsQueryDto,
  ): Promise<AlertsListResponseDto> {
    return this.alerts.listForApplicant(req.user.id, query.cursor);
  }

  @Post('preferences')
  async setPreferences(
    @Req() req: AuthedRequest,
    @Body() dto: AlertPreferencesDto,
  ): Promise<{ specialties: string[] }> {
    return this.alerts.savePreferences(req.user.id, dto.specialties);
  }
}
