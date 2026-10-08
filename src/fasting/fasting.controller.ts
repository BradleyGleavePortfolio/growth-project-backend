import { Controller, Post, Get, Delete, Body, Param, Query, UseGuards, Request } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { FastingService } from './fasting.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { StartFastDto, EndFastDto } from './fasting.dto';
import { ClientEntitlementGuard } from '../common/guards/client-entitlement.guard';

@ApiTags('fasting')
@Controller('fasting')
@UseGuards(JwtAuthGuard, ClientEntitlementGuard, RolesGuard)
@Roles('student')
export class FastingController {
  constructor(private fastingService: FastingService) {}

  @Post('start')
  async startFast(@Request() req: AuthedRequest, @Body() body: StartFastDto) {
    return this.fastingService.startFast(req.user.id, body);
  }

  @Post('end')
  async endFast(@Request() req: AuthedRequest, @Body() body: EndFastDto) {
    return this.fastingService.endFast(req.user.id, body.notes);
  }

  @Get('history')
  async getHistory(@Request() req: AuthedRequest, @Query('limit') limit?: string) {
    return this.fastingService.getHistory(req.user.id, limit ? parseInt(limit) : 10);
  }

  // U10 (FW-FOOD-128): remove a fast logged by mistake, ended or in progress.
  // The caller's own fast only; any other id is a 404.
  @Delete(':id')
  async deleteFast(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.fastingService.deleteFast(req.user.id, id);
  }
}
