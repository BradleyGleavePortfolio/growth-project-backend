import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { CoachGuard } from '../../auth/coach.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CoachConsultationAnswersDto } from './coach-consultation.dto';
import { CoachConsultationService } from './coach-consultation.service';

// COACH-CONSULT-BE-134 — the coach consultation K0-K8 (prototype 77-85).
// JwtAuthGuard + CoachGuard; no path params: every handler passes the
// caller's own id, so a coach only reads and writes their own profile. No
// subscription, Stripe or package guard: the consultation never needs money.
@ApiTags('coach-consultation')
@Controller('coach/consultation')
@Roles('coach')
@UseGuards(JwtAuthGuard, CoachGuard)
export class CoachConsultationController {
  constructor(private readonly consultation: CoachConsultationService) {}

  // The saved draft (or a prefill from the account) and the coach's link.
  @Get()
  async get(@Request() req: AuthedRequest) {
    return this.consultation.get(req.user.id);
  }

  // Save a partial draft and the step to resume on. 409 once complete.
  @Put()
  async save(@Request() req: AuthedRequest, @Body() body: CoachConsultationAnswersDto) {
    return this.consultation.save(req.user.id, body);
  }

  // Finish (K8): validate, write the card, mark onboarding complete. Idempotent.
  @Post('complete')
  @HttpCode(HttpStatus.OK)
  async complete(@Request() req: AuthedRequest, @Body() body: CoachConsultationAnswersDto) {
    return this.consultation.complete(req.user.id, body);
  }
}
