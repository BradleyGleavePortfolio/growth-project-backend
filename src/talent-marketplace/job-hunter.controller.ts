// TM-9 — Job-hunter tooling. Applicant-facing /me/* surface: own applications +
// statuses, portfolio showcase, specialty-matched alerts, profile-strength
// nudges. Every route is JWT-gated with @Roles('student') and reads/writes the
// caller's OWN data only (service-layer owner-scope on user_id + TM-1 RLS).

import {
  Body,
  Controller,
  Get,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import {
  AlertPreferencesDto,
  MyApplicationsQueryDto,
  UpdatePortfolioDto,
} from './job-hunter.dto';
import { JobHunterService } from './job-hunter.service';
import { SpecialtyAlertsService } from './specialty-alerts.service';

@ApiTags('talent-marketplace')
@Controller('talent-marketplace/me')
@Roles('student')
@UseGuards(JwtAuthGuard)
export class JobHunterController {
  constructor(
    private readonly jobHunter: JobHunterService,
    private readonly alerts: SpecialtyAlertsService,
  ) {}

  @Get('applications')
  async myApplications(
    @Req() req: AuthedRequest,
    @Query() query: MyApplicationsQueryDto,
  ) {
    return this.jobHunter.myApplications(req.user.id, query);
  }

  @Get('portfolio')
  async getPortfolio(@Req() req: AuthedRequest) {
    return this.jobHunter.getPortfolio(req.user.id);
  }

  @Put('portfolio')
  async updatePortfolio(
    @Req() req: AuthedRequest,
    @Body() dto: UpdatePortfolioDto,
  ) {
    return this.jobHunter.updatePortfolio(req.user.id, dto);
  }

  @Get('alerts')
  async myAlerts(@Req() req: AuthedRequest) {
    return this.alerts.listForApplicant(req.user.id);
  }

  @Post('alerts/preferences')
  async setAlertPreferences(
    @Req() req: AuthedRequest,
    @Body() dto: AlertPreferencesDto,
  ) {
    return this.alerts.savePreferences(req.user.id, dto.specialties);
  }

  @Get('profile-strength')
  async profileStrength(@Req() req: AuthedRequest) {
    return this.jobHunter.profileStrength(req.user.id);
  }
}
