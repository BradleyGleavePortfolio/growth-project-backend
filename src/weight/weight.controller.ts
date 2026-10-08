import { Controller, Post, Get, Patch, Delete, Body, Param, Query, UseGuards, Request, HttpCode } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { WeightService } from './weight.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { LogWeightDto, UpdateWeightDto } from './weight.dto';

@ApiTags('weight')
@Controller('weight')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class WeightController {
  constructor(private weightService: WeightService) {}

  @Post()
  async logWeight(@Request() req: AuthedRequest, @Body() body: LogWeightDto) {
    return this.weightService.logWeight(req.user.id, body);
  }

  @Get('history')
  async getHistory(@Request() req: AuthedRequest, @Query('days') days?: string) {
    return this.weightService.getHistory(req.user.id, days ? parseInt(days) : 30);
  }

  // Fix a weigh-in's number or note. 404 unless it is the caller's own.
  @Patch(':id')
  async updateWeight(@Request() req: AuthedRequest, @Param('id') id: string, @Body() body: UpdateWeightDto) {
    return this.weightService.updateWeight(req.user.id, id, body);
  }

  // Remove a weigh-in. 404 unless it is the caller's own.
  @Delete(':id')
  @HttpCode(204)
  async deleteWeight(@Request() req: AuthedRequest, @Param('id') id: string): Promise<void> {
    await this.weightService.deleteWeight(req.user.id, id);
  }
}
