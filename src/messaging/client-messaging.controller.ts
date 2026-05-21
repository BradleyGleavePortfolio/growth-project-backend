import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { ClientEntitlementGuard } from '../common/guards/client-entitlement.guard';
import {
  CreateMessageDto,
  ListThreadQueryDto,
  VoiceUploadRequestDto,
} from './messaging.dto';
import { MessagingService } from './messaging.service';

// Client-authenticated messaging endpoints. The client's thread is always with
// their assigned coach (resolved from user.coach_id), so no path param is
// needed. When a client has no coach assigned the service throws 409 with
// { error: 'NO_COACH_ASSIGNED' } — except on /messages/unread-count which
// returns { total: 0 } since the mobile app polls that endpoint aggressively.
//
// Entitlement model — explicit per-route decisions (audit P0 fix):
//   - GET /messages, POST /messages, POST /messages/read, GET /messages/unread-count:
//       intentionally free. Basic text DM with the assigned coach is part of
//       the onboarding/retention path; gating it would block clients whose
//       package lapsed from reading or replying to coach outreach.
//   - POST /messages/voice-upload: paid. Voice notes are a first-class
//       Phase 6C feature (storage + transcription costs scale with usage)
//       and the brief flags them as a paid surface. Guarded with
//       ClientEntitlementGuard at the handler level (402 for unentitled
//       students; coaches/owners short-circuit through the guard).
@ApiTags('messaging')
@Controller('messages')
@UseGuards(JwtAuthGuard)
export class ClientMessagingController {
  constructor(private messaging: MessagingService) {}

  @Get()
  async listThread(
    @Request() req: AuthedRequest,
    @Query() query: ListThreadQueryDto,
  ) {
    return this.messaging.listThreadForClient(req.user.id, query);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post()
  async send(
    @Request() req: AuthedRequest,
    @Body() body: CreateMessageDto,
  ) {
    return this.messaging.sendAsClient(req.user.id, {
      body: body.body,
      voice: body.voice,
    });
  }

  // Phase 6C — pre-signed upload URL for client-side voice attachments. The
  // client must already have a coach (the upload endpoint shares the same
  // 409 NO_COACH_ASSIGNED contract as send).
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @Post('voice-upload')
  @UseGuards(JwtAuthGuard, ClientEntitlementGuard)
  async voiceUpload(
    @Request() req: AuthedRequest,
    @Body() body: VoiceUploadRequestDto,
  ) {
    return this.messaging.createVoiceUpload(req.user.id, body);
  }

  @Post('read')
  async markRead(@Request() req: AuthedRequest) {
    return this.messaging.markReadByClient(req.user.id);
  }

  @Get('unread-count')
  async unreadCount(@Request() req: AuthedRequest) {
    return this.messaging.unreadCountForClient(req.user.id);
  }
}
