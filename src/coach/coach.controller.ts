import { Controller, Get, Post, Body, Param, Query, UseGuards, Request } from '@nestjs/common';
import type { AuthedRequest } from '../auth/auth-request';
import { CoachService } from './coach.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';

@Controller('coach')
@UseGuards(JwtAuthGuard, CoachGuard)
export class CoachController {
  constructor(private coachService: CoachService) {}

  @Get('dashboard')
  async getDashboard(@Request() req: AuthedRequest) {
    return this.coachService.getDashboard(req.user.id);
  }

  @Get('clients')
  async getClients(@Request() req: AuthedRequest, @Query('status') status?: string) {
    return this.coachService.getClients(req.user.id, status as any);
  }

  @Get('clients/:id/timeline')
  async getClientTimeline(@Request() req: AuthedRequest, @Param('id') id: string, @Query('days') days?: string) {
    const daysNum = days ? parseInt(days, 10) : 90;
    return this.coachService.getClientTimeline(req.user.id, id, daysNum);
  }

  @Get('clients/:id/summary')
  async getClientSummary(@Request() req: AuthedRequest, @Param('id') clientId: string, @Query('date') date?: string) {
    return this.coachService.getClientSummary(req.user.id, clientId, date);
  }

  @Get('my-guidelines')
  async getMyGuidelines(@Request() req: AuthedRequest) {
    return this.coachService.getGuidelines(req.user.id);
  }

  @Get('guidelines/:client_id')
  async getGuidelines(@Request() req: AuthedRequest, @Param('client_id') clientId: string) {
    return this.coachService.getGuidelines(req.user.id, clientId);
  }

  @Post('guidelines/:client_id')
  async postGuidelines(@Request() req: AuthedRequest, @Param('client_id') clientId: string, @Body() body: { guidelines: string }) {
    return this.coachService.postGuidelines(req.user.id, clientId, body.guidelines);
  }

  @Get('alerts')
  async getAlerts(@Request() req: AuthedRequest) {
    return this.coachService.getAlerts(req.user.id);
  }
}
