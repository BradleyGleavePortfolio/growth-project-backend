import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { Roles } from '../common/decorators/roles.decorator';
import {
  CreateMessageDto,
  EditMessageDto,
  InboxPinDto,
  InboxQueryDto,
  ListThreadQueryDto,
  MarkReadDto,
  MuteThreadDto,
  VoiceUploadRequestDto,
} from './messaging.dto';
import { MessagingService } from './messaging.service';
import { MessageActionsService } from './message-actions.service';
import { MessagingInboxService } from './messaging-inbox.service';
import { MessagingCoreV2Guard } from './messaging-core.feature';
import { resolveIdempotencyKey } from './messaging-idempotency';
import { THROTTLER_NAMES } from '../throttler/throttler.config';

// Coach-authenticated messaging endpoints. Mounted under /coach so they sit
// next to the existing coach routes. NOTE: we must NOT register this on the
// existing CoachController — doing so would re-order its guards/metadata and
// risk regressions to the already-shipped coach endpoints (see PRs #16, #17,
// #19). Keeping a separate controller keeps the surface area small and
// isolates throttle rules to writes only.
@ApiTags('messaging')
@Controller('coach')
@Roles('coach')
@UseGuards(JwtAuthGuard, CoachGuard)
export class CoachMessagingController {
  constructor(
    private messaging: MessagingService,
    private actions: MessageActionsService,
    private inbox: MessagingInboxService,
  ) {}

  @Get('clients/:client_id/messages')
  async listThread(
    @Request() req: AuthedRequest,
    @Param('client_id') clientId: string,
    @Query() query: ListThreadQueryDto,
  ) {
    return this.messaging.listThreadForCoach(req.user.id, clientId, query);
  }

  // 30/min per user (coach-id keyed by UserThrottlerGuard). Named throttler
  // `coach-messages` keeps this separate from the default bucket so it can be
  // adjusted independently without touching the global default. Coach sends are
  // always authenticated so the tracker key is user-id.
  @Throttle({ [THROTTLER_NAMES.COACH_MESSAGES]: { ttl: 60_000, limit: 30 } })
  @Post('clients/:client_id/messages')
  async send(
    @Request() req: AuthedRequest,
    @Param('client_id') clientId: string,
    @Body() body: CreateMessageDto,
    @Headers('idempotency-key') idemHeader?: string,
  ) {
    const key = resolveIdempotencyKey(idemHeader, body.client_message_id);
    return this.messaging.sendAsCoach(req.user.id, clientId, {
      body: body.body,
      voice: body.voice,
      ...(key ? { client_message_id: key } : {}),
      ...(body.reply_to_id ? { reply_to_id: body.reply_to_id } : {}),
    });
  }

  // Phase 6C — pre-signed upload URL for voice attachments. Tighter throttle
  // than the send endpoint so a runaway client can't pin storage. The URL
  // expires in 10 minutes; the client must POST /messages within that window
  // attaching the returned public_url + duration + size + content_type.
  @Throttle({ [THROTTLER_NAMES.COACH_MESSAGES]: { ttl: 60_000, limit: 20 } })
  @Post('clients/:client_id/messages/voice-upload')
  async voiceUpload(
    @Request() req: AuthedRequest,
    @Param('client_id') clientId: string,
    @Body() body: VoiceUploadRequestDto,
  ) {
    // Object path is namespaced by the SENDER (coach) so a coach cannot
    // overwrite another coach's pending uploads. The clientId path param
    // exists for symmetry with the send endpoint and lets the controller
    // verify the coach actually has this client (defence-in-depth before we
    // burn a signed URL).
    await this.messaging.listThreadForCoach(req.user.id, clientId, {
      limit: 1,
    });
    return this.messaging.createVoiceUpload(req.user.id, body);
  }

  // A3-MSG-CORE: optional { up_to_message_id } marks read up to that message
  // (v2); an empty body keeps the legacy mark-everything behaviour.
  @Post('clients/:client_id/messages/read')
  async markRead(
    @Request() req: AuthedRequest,
    @Param('client_id') clientId: string,
    @Body() body: MarkReadDto = {},
  ) {
    return this.messaging.markReadByCoach(req.user.id, clientId, {
      upToMessageId: body?.up_to_message_id,
    });
  }

  @Get('messages/unread-count')
  async unreadCount(@Request() req: AuthedRequest) {
    return this.messaging.unreadCountForCoach(req.user.id);
  }

  // ---- A3-MSG-CORE (FEATURE_MESSAGING_CORE_V2, default OFF → 503) ----

  // The one inbox: every client thread, pinned first, then newest activity.
  @Get('messages/inbox')
  @UseGuards(MessagingCoreV2Guard)
  async inboxList(@Request() req: AuthedRequest, @Query() query: InboxQueryDto) {
    return this.inbox.inboxForCoach(req.user.id, query);
  }

  @Get('clients/:client_id/messages/pins')
  @UseGuards(MessagingCoreV2Guard)
  async listPins(@Request() req: AuthedRequest, @Param('client_id') clientId: string) {
    const thread = await this.messaging.resolveThreadForCoach(req.user.id, clientId);
    return this.actions.listPins(thread);
  }

  @Throttle({ [THROTTLER_NAMES.COACH_MESSAGES]: { ttl: 60_000, limit: 30 } })
  @Patch('clients/:client_id/messages/:message_id')
  @UseGuards(MessagingCoreV2Guard)
  async edit(
    @Request() req: AuthedRequest,
    @Param('client_id') clientId: string,
    @Param('message_id', new ParseUUIDPipe()) messageId: string,
    @Body() body: EditMessageDto,
  ) {
    const thread = await this.messaging.resolveThreadForCoach(req.user.id, clientId);
    return this.actions.edit(thread, messageId, body.body);
  }

  @Throttle({ [THROTTLER_NAMES.COACH_MESSAGES]: { ttl: 60_000, limit: 30 } })
  @Delete('clients/:client_id/messages/:message_id')
  @UseGuards(MessagingCoreV2Guard)
  async remove(
    @Request() req: AuthedRequest,
    @Param('client_id') clientId: string,
    @Param('message_id', new ParseUUIDPipe()) messageId: string,
  ) {
    const thread = await this.messaging.resolveThreadForCoach(req.user.id, clientId);
    return this.actions.delete(thread, messageId);
  }

  @Throttle({ [THROTTLER_NAMES.COACH_MESSAGES]: { ttl: 60_000, limit: 30 } })
  @Post('clients/:client_id/messages/:message_id/pin')
  @UseGuards(MessagingCoreV2Guard)
  async pin(
    @Request() req: AuthedRequest,
    @Param('client_id') clientId: string,
    @Param('message_id', new ParseUUIDPipe()) messageId: string,
  ) {
    const thread = await this.messaging.resolveThreadForCoach(req.user.id, clientId);
    return this.actions.pin(thread, messageId);
  }

  @Throttle({ [THROTTLER_NAMES.COACH_MESSAGES]: { ttl: 60_000, limit: 30 } })
  @Delete('clients/:client_id/messages/:message_id/pin')
  @UseGuards(MessagingCoreV2Guard)
  async unpin(
    @Request() req: AuthedRequest,
    @Param('client_id') clientId: string,
    @Param('message_id', new ParseUUIDPipe()) messageId: string,
  ) {
    const thread = await this.messaging.resolveThreadForCoach(req.user.id, clientId);
    return this.actions.unpin(thread, messageId);
  }

  @Put('clients/:client_id/messages/mute')
  @UseGuards(MessagingCoreV2Guard)
  async mute(
    @Request() req: AuthedRequest,
    @Param('client_id') clientId: string,
    @Body() body: MuteThreadDto,
  ) {
    const thread = await this.messaging.resolveThreadForCoach(req.user.id, clientId);
    return this.actions.setMute(thread, body.duration);
  }

  @Put('clients/:client_id/messages/inbox-pin')
  @UseGuards(MessagingCoreV2Guard)
  async inboxPin(
    @Request() req: AuthedRequest,
    @Param('client_id') clientId: string,
    @Body() body: InboxPinDto,
  ) {
    const thread = await this.messaging.resolveThreadForCoach(req.user.id, clientId);
    return this.actions.setInboxPin(thread, body.pinned);
  }
}
