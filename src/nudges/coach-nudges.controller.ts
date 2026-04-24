import {
  Body,
  Controller,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { CreateNudgeDto } from './nudges.dto';
import { NudgesService } from './nudges.service';

// Coach-authenticated endpoint for sending a nudge to one of the coach's
// clients. Mounted under /coach so it sits next to the existing coach routes
// without modifying CoachController (same reasoning as CoachMessagingController
// — a separate controller isolates throttle rules and avoids reordering the
// already-shipped coach-endpoint guards/metadata).
@Controller('coach')
@UseGuards(JwtAuthGuard, CoachGuard)
export class CoachNudgesController {
  constructor(private nudges: NudgesService) {}

  // 10/min per coach per spec. ThrottlerGuard is registered globally
  // (see AppModule) so this decorator is actually enforced.
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post('clients/:client_id/nudges')
  async create(
    @Request() req: AuthedRequest,
    @Param('client_id') clientId: string,
    @Body() body: CreateNudgeDto,
  ) {
    return this.nudges.createForClient(req.user.id, clientId, body.title, body.body);
  }
}
