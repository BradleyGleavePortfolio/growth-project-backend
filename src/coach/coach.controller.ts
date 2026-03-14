import { Controller, Get, Post, Body, Param, UseGuards, Request } from '@nestjs/common';
import { CoachService } from './coach.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';

@Controller('coach')
@UseGuards(JwtAuthGuard, CoachGuard)
export class CoachController {
  constructor(private coachService: CoachService) {}

  @Get('clients')
  async getClients(@Request() req) {
    return this.coachService.getClients(req.user.id);
  }

  @Get('clients/:id/timeline')
  async getClientTimeline(@Request() req, @Param('id') id: string) {
    return this.coachService.getClientTimeline(req.user.id, id);
  }

  @Post('guidelines/:client_id')
  async postGuidelines(@Request() req, @Param('client_id') clientId: string, @Body() body: { guidelines: string }) {
    return this.coachService.postGuidelines(req.user.id, clientId, body.guidelines);
  }

  @Get('alerts')
  async getAlerts(@Request() req) {
    return this.coachService.getAlerts(req.user.id);
  }
}
