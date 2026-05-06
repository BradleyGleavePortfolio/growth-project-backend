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
