import { Controller, Get, Post, Put, Body, Param, UseGuards, Request } from '@nestjs/common';
import type { AuthedRequest } from '../auth/auth-request';
import { LessonsService } from './lessons.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@Controller('lessons')
@UseGuards(JwtAuthGuard)
export class LessonsController {
  constructor(private lessonsService: LessonsService) {}

  @Get()
  async getLessons(@Request() req: AuthedRequest) {
    return this.lessonsService.getLessons(req.user.id);
  }

  @Post()
  async createLesson(@Request() req: AuthedRequest, @Body() body: any) {
    return this.lessonsService.createLesson(req.user.id, body);
  }

  @Put(':id')
  async updateLesson(@Request() req: AuthedRequest, @Param('id') id: string, @Body() body: any) {
    return this.lessonsService.updateLesson(req.user.id, id, body);
  }

  @Post(':id/complete')
  async completeLesson(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.lessonsService.completeLesson(req.user.id, id);
  }

  @Get('recommended')
  async getRecommended(@Request() req: AuthedRequest) {
    return this.lessonsService.getRecommended(req.user.id);
  }
}
