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
import { ClientEntitlementGuard } from '../common/guards/client-entitlement.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import {
  CreateMessageDto,
  EditMessageDto,
  InboxPinDto,
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
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class ClientMessagingController {
  constructor(
    private messaging: MessagingService,
    private actions: MessageActionsService,
    private inbox: MessagingInboxService,
  ) {}

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
    @Headers('idempotency-key') idemHeader?: string,
  ) {
    const key = resolveIdempotencyKey(idemHeader, body.client_message_id);
    return this.messaging.sendAsClient(req.user.id, {
      body: body.body,
      voice: body.voice,
      ...(key ? { client_message_id: key } : {}),
      ...(body.reply_to_id ? { reply_to_id: body.reply_to_id } : {}),
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

  // A3-MSG-CORE: optional { up_to_message_id } (v2); empty body = legacy.
  @Post('read')
  async markRead(@Request() req: AuthedRequest, @Body() body: MarkReadDto = {}) {
    return this.messaging.markReadByClient(req.user.id, {
      upToMessageId: body?.up_to_message_id,
    });
  }

  @Get('unread-count')
  async unreadCount(@Request() req: AuthedRequest) {
    return this.messaging.unreadCountForClient(req.user.id);
  }

  // ED.6 — coach-review marker for the client's thread. Returns
  // { coachReviewedAt: ISO | null } off the additive ConversationReview marker.
  // Additive read — the existing GET /messages array contract is untouched so
  // no consumer breaks. The mobile CompetencePill reads this and renders
  // nothing on null (no coach review yet, or the backend flag is OFF). Free
  // like the rest of the basic DM surface (see controller header).
  @Get('coach-review')
  async coachReview(@Request() req: AuthedRequest) {
    return this.messaging.coachReviewForClient(req.user.id);
  }

  // ---- A3-MSG-CORE (FEATURE_MESSAGING_CORE_V2, default OFF → 503) ----
  // Free like the rest of the basic DM surface (see controller header).
  // Static segments ('inbox', 'pins', 'mute', 'inbox-pin') never collide with
  // the UUID-validated :message_id routes.

  // The one inbox: the client's coach thread (empty when coachless).
  @Get('inbox')
  @UseGuards(MessagingCoreV2Guard)
  async inboxList(@Request() req: AuthedRequest) {
    return this.inbox.inboxForClient(req.user.id);
  }

  @Get('pins')
  @UseGuards(MessagingCoreV2Guard)
  async listPins(@Request() req: AuthedRequest) {
    const thread = await this.messaging.resolveThreadForClient(req.user.id);
    return this.actions.listPins(thread);
  }

  @Put('mute')
  @UseGuards(MessagingCoreV2Guard)
  async mute(@Request() req: AuthedRequest, @Body() body: MuteThreadDto) {
    const thread = await this.messaging.resolveThreadForClient(req.user.id);
    return this.actions.setMute(thread, body.duration);
  }

  @Put('inbox-pin')
  @UseGuards(MessagingCoreV2Guard)
  async inboxPin(@Request() req: AuthedRequest, @Body() body: InboxPinDto) {
    const thread = await this.messaging.resolveThreadForClient(req.user.id);
    return this.actions.setInboxPin(thread, body.pinned);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Patch(':message_id')
  @UseGuards(MessagingCoreV2Guard)
  async edit(
    @Request() req: AuthedRequest,
    @Param('message_id', new ParseUUIDPipe()) messageId: string,
    @Body() body: EditMessageDto,
  ) {
    const thread = await this.messaging.resolveThreadForClient(req.user.id);
    return this.actions.edit(thread, messageId, body.body);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Delete(':message_id')
  @UseGuards(MessagingCoreV2Guard)
  async remove(
    @Request() req: AuthedRequest,
    @Param('message_id', new ParseUUIDPipe()) messageId: string,
  ) {
    const thread = await this.messaging.resolveThreadForClient(req.user.id);
    return this.actions.delete(thread, messageId);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post(':message_id/pin')
  @UseGuards(MessagingCoreV2Guard)
  async pin(
    @Request() req: AuthedRequest,
    @Param('message_id', new ParseUUIDPipe()) messageId: string,
  ) {
    const thread = await this.messaging.resolveThreadForClient(req.user.id);
    return this.actions.pin(thread, messageId);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Delete(':message_id/pin')
  @UseGuards(MessagingCoreV2Guard)
  async unpin(
    @Request() req: AuthedRequest,
    @Param('message_id', new ParseUUIDPipe()) messageId: string,
  ) {
    const thread = await this.messaging.resolveThreadForClient(req.user.id);
    return this.actions.unpin(thread, messageId);
  }
}
