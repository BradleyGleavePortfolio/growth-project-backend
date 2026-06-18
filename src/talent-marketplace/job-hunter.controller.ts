// TM-9 — Job-hunter dashboard. Applicant-facing /me/* surface: own applications,
// portfolio showcase, profile-strength nudges. JWT-gated, @Roles('student'),
// owner-scoped on user_id. Specialty alerts live in their own controller (TM-9b).

import { Body, Controller, Get, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { MyApplicationsQueryDto, UpdatePortfolioDto } from './job-hunter.dto';
import { JobHunterService } from './job-hunter.service';

@ApiTags('talent-marketplace')
@Controller('talent-marketplace/me')
@Roles('student')
@UseGuards(JwtAuthGuard)
export class JobHunterController {
  constructor(private readonly jobHunter: JobHunterService) {}

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

  @Get('profile-strength')
  async profileStrength(@Req() req: AuthedRequest) {
    return this.jobHunter.profileStrength(req.user.id);
  }
}
