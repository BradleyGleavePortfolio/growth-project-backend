import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { CreateMessageDto, ListThreadQueryDto } from './messaging.dto';
import { MessagingService } from './messaging.service';

// Coach-authenticated messaging endpoints. Mounted under /coach so they sit
// next to the existing coach routes. NOTE: we must NOT register this on the
// existing CoachController — doing so would re-order its guards/metadata and
// risk regressions to the already-shipped coach endpoints (see PRs #16, #17,
// #19). Keeping a separate controller keeps the surface area small and
// isolates throttle rules to writes only.
@Controller('coach')
@UseGuards(JwtAuthGuard, CoachGuard)
export class CoachMessagingController {
  constructor(private messaging: MessagingService) {}

  @Get('clients/:client_id/messages')
  async listThread(
    @Request() req: AuthedRequest,
    @Param('client_id') clientId: string,
    @Query() query: ListThreadQueryDto,
  ) {
    return this.messaging.listThreadForCoach(req.user.id, clientId, query);
  }

  // 30/min per caller matches the spec. ThrottlerGuard is registered globally
  // (see AppModule) so this decorator is actually enforced.
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post('clients/:client_id/messages')
  async send(
    @Request() req: AuthedRequest,
    @Param('client_id') clientId: string,
    @Body() body: CreateMessageDto,
  ) {
    return this.messaging.sendAsCoach(req.user.id, clientId, body.body);
  }

  @Post('clients/:client_id/messages/read')
  async markRead(
    @Request() req: AuthedRequest,
    @Param('client_id') clientId: string,
  ) {
    return this.messaging.markReadByCoach(req.user.id, clientId);
  }

  @Get('messages/unread-count')
  async unreadCount(@Request() req: AuthedRequest) {
    return this.messaging.unreadCountForCoach(req.user.id);
  }
}
