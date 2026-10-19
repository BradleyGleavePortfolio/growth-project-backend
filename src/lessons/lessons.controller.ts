import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards, Request, HttpCode } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { LessonsService } from './lessons.service';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { OpenToCoachlessClient } from '../common/decorators/open-to-coachless-client.decorator';
import { CreateLessonDto, UpdateLessonDto } from './lessons.dto';

// #LEARN-LOCK op 1: the client's lesson reads never lock (no package guard
// here; the marker keeps them open through a Day-10 dunning lock too). Every
// read is scoped to the client's current coach in the service, plus the single
// lessons a client completed and kept when that coach deleted their account.
@ApiTags('lessons')
@Controller('lessons')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class LessonsController {
  constructor(private lessonsService: LessonsService) {}

  @Get()
  @OpenToCoachlessClient()
  async getLessons(@Request() req: AuthedRequest) {
    return this.lessonsService.getLessons(req.user.id);
  }

  @Post()
  async createLesson(@Request() req: AuthedRequest, @Body() body: CreateLessonDto) {
    return this.lessonsService.createLesson(req.user.id, body);
  }

  @Put(':id')
  async updateLesson(@Request() req: AuthedRequest, @Param('id') id: string, @Body() body: UpdateLessonDto) {
    return this.lessonsService.updateLesson(req.user.id, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async deleteLesson(@Request() req: AuthedRequest, @Param('id') id: string): Promise<void> {
    await this.lessonsService.deleteLesson(req.user.id, id);
  }

  @Post(':id/complete')
  @OpenToCoachlessClient()
  async completeLesson(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.lessonsService.completeLesson(req.user.id, id);
  }

  @Get('recommended')
  @OpenToCoachlessClient()
  async getRecommended(@Request() req: AuthedRequest) {
    return this.lessonsService.getRecommended(req.user.id);
  }
}
