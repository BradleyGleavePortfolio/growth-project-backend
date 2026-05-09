import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Put,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CoachPracticeType } from '@prisma/client';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { CoachGuard } from '../../auth/coach.guard';
import { PracticeTypeService } from './practice-type.service';

const ALLOWED: CoachPracticeType[] = ['fitness_only', 'finance_only', 'both'];

/**
 * Stage-3 coach practice-selection endpoints.
 *
 *   GET  /api/coach/practice   — current value or `null`
 *   PUT  /api/coach/practice   — set or change; body `{ practice_type }`
 *
 * Auth: JWT + CoachGuard. The CrossPillarPracticeGuard is intentionally
 * NOT applied here — a coach who has not yet selected (or who picked
 * single-pillar) must still be able to read and update this field.
 *
 * Practice type is also surfaced on `GET /auth/me` (existing endpoint;
 * the column flows through automatically via the Prisma include) so
 * the mobile app routes coaches through the practice-selection flow on
 * first login when the value is `null`.
 */
@ApiTags('coach-practice-type')
@Controller('coach/practice')
@UseGuards(JwtAuthGuard, CoachGuard)
export class PracticeTypeController {
  constructor(private readonly service: PracticeTypeService) {}

  @Get()
  async get(@Request() req: AuthedRequest) {
    return this.service.get(req.user.id);
  }

  @Put()
  async set(
    @Request() req: AuthedRequest,
    @Body() body: { practice_type?: string } | undefined,
  ) {
    const v = body?.practice_type;
    if (!v || !(ALLOWED as string[]).includes(v)) {
      throw new BadRequestException({
        error: `practice_type must be one of: ${ALLOWED.join(', ')}`,
        code: 'INVALID_PRACTICE_TYPE',
      });
    }
    return this.service.set(req.user.id, v as CoachPracticeType);
  }
}
