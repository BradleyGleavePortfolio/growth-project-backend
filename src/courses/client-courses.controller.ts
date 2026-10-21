import { Body, Controller, Get, HttpCode, Param, Put, Request, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { OpenToCoachlessClient } from '../common/decorators/open-to-coachless-client.decorator';
import { ClientCoursesService } from './client-courses.service';
import { LessonPositionDto } from './client-courses.dto';

// Like the lessons routes (#LEARN-LOCK op 1), course reads never lock: no
// package guard here, and the marker keeps them open for a client with no coach
// and through a Day-10 dunning lock. Everything is scoped to the caller's own enrolment.
@ApiTags('client-courses')
@Controller('v1/client')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
@OpenToCoachlessClient()
export class ClientCoursesController {
  constructor(private readonly courses: ClientCoursesService) {}

  @Get('courses')
  list(@Request() req: AuthedRequest) {
    return this.courses.list(req.user.id);
  }

  @Get('courses/:id')
  detail(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.courses.detail(req.user.id, id);
  }

  @Put('lessons/:id/position')
  @HttpCode(204)
  async savePosition(@Request() req: AuthedRequest, @Param('id') id: string, @Body() body: LessonPositionDto): Promise<void> {
    await this.courses.savePosition(req.user.id, id, body.position_seconds);
  }

  @Get('lessons/:id/video')
  video(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.courses.video(req.user.id, id);
  }
}
