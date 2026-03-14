import { Controller, Get, Post, Put, Body, Param, UseGuards, Request } from '@nestjs/common';
import { LessonsService } from './lessons.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@Controller('lessons')
@UseGuards(JwtAuthGuard)
export class LessonsController {
  constructor(private lessonsService: LessonsService) {}

  @Get()
  async getLessons(@Request() req) {
    return this.lessonsService.getLessons(req.user.id);
  }

  @Post()
  async createLesson(@Request() req, @Body() body: any) {
    return this.lessonsService.createLesson(req.user.id, body);
  }

  @Put(':id')
  async updateLesson(@Request() req, @Param('id') id: string, @Body() body: any) {
    return this.lessonsService.updateLesson(req.user.id, id, body);
  }

  @Post(':id/complete')
  async completeLesson(@Request() req, @Param('id') id: string) {
    return this.lessonsService.completeLesson(req.user.id, id);
  }

  @Get('recommended')
  async getRecommended(@Request() req) {
    return this.lessonsService.getRecommended(req.user.id);
  }
}
