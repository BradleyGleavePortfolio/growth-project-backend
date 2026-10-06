import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
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
import { THROTTLER_NAMES } from '../throttler/throttler.config';
import {
  BroadcastPreviewDto,
  CardValidateDto,
  ClientTagsDto,
  ListBroadcastsQueryDto,
  ListSavedRepliesQueryDto,
  SavedReplyDto,
  SavedReplyPatchDto,
  UpsertBroadcastDto,
} from './broadcasts.dto';
import { CoachBroadcastsEnabledGuard } from './broadcasts.feature';
import { BroadcastsService } from './broadcasts.service';
import { ClientTagsService } from './client-tags.service';
import { SavedRepliesService } from './saved-replies.service';

/**
 * A4 coach routes. Coach-only (JwtAuthGuard + CoachGuard), behind the
 * FEATURE_COACH_BROADCASTS kill switch. Every service call keys on
 * req.user.id; no route accepts a coach or tenant id from the client.
 */
@ApiTags('broadcasts')
@Controller('coach')
@Roles('coach')
@UseGuards(JwtAuthGuard, CoachGuard, CoachBroadcastsEnabledGuard)
export class BroadcastsController {
  constructor(
    private readonly broadcasts: BroadcastsService,
    private readonly savedReplies: SavedRepliesService,
    private readonly tags: ClientTagsService,
  ) {}

  // ---- broadcasts -------------------------------------------------------

  @Get('broadcasts/segment-options')
  segmentOptions(@Request() req: AuthedRequest) {
    return this.broadcasts.segmentOptions(req.user.id);
  }

  @Throttle({ [THROTTLER_NAMES.COACH_MESSAGES]: { ttl: 60_000, limit: 60 } })
  @Post('broadcasts/preview')
  @HttpCode(200)
  preview(@Request() req: AuthedRequest, @Body() dto: BroadcastPreviewDto) {
    return this.broadcasts.preview(req.user.id, dto.segment);
  }

  @Post('cards/validate')
  @HttpCode(200)
  validateCard(@Request() req: AuthedRequest, @Body() dto: CardValidateDto) {
    return this.broadcasts.validateCard(req.user.id, dto.card);
  }

  @Throttle({ [THROTTLER_NAMES.COACH_MESSAGES]: { ttl: 60_000, limit: 10 } })
  @Post('broadcasts')
  create(
    @Request() req: AuthedRequest,
    @Body() dto: UpsertBroadcastDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.broadcasts.create(req.user.id, dto, idempotencyKey);
  }

  @Get('broadcasts')
  list(@Request() req: AuthedRequest, @Query() q: ListBroadcastsQueryDto) {
    return this.broadcasts.list(req.user.id, q);
  }

  @Get('broadcasts/:id')
  get(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.broadcasts.get(req.user.id, id);
  }

  @Patch('broadcasts/:id')
  update(@Request() req: AuthedRequest, @Param('id') id: string, @Body() dto: UpsertBroadcastDto) {
    return this.broadcasts.update(req.user.id, id, dto);
  }

  @Post('broadcasts/:id/pause')
  @HttpCode(200)
  pause(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.broadcasts.transition(req.user.id, id, 'pause');
  }

  @Post('broadcasts/:id/resume')
  @HttpCode(200)
  resume(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.broadcasts.transition(req.user.id, id, 'resume');
  }

  @Post('broadcasts/:id/cancel')
  @HttpCode(200)
  cancel(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.broadcasts.transition(req.user.id, id, 'cancel');
  }

  // ---- saved replies --------------------------------------------------------

  @Get('saved-replies')
  listReplies(@Request() req: AuthedRequest, @Query() q: ListSavedRepliesQueryDto) {
    return this.savedReplies.list(req.user.id, q.q);
  }

  @Post('saved-replies')
  createReply(@Request() req: AuthedRequest, @Body() dto: SavedReplyDto) {
    return this.savedReplies.create(req.user.id, dto);
  }

  @Patch('saved-replies/:id')
  updateReply(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() dto: SavedReplyPatchDto,
  ) {
    return this.savedReplies.update(req.user.id, id, dto);
  }

  @Delete('saved-replies/:id')
  removeReply(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.savedReplies.remove(req.user.id, id);
  }

  @Post('saved-replies/:id/use')
  @HttpCode(200)
  useReply(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.savedReplies.markUsed(req.user.id, id);
  }

  // ---- client tags ------------------------------------------------------------

  @Get('client-tags')
  listTags(@Request() req: AuthedRequest) {
    return this.tags.listAll(req.user.id);
  }

  @Get('clients/:client_id/tags')
  clientTags(@Request() req: AuthedRequest, @Param('client_id') clientId: string) {
    return this.tags.listForClient(req.user.id, clientId);
  }

  @Put('clients/:client_id/tags')
  replaceTags(
    @Request() req: AuthedRequest,
    @Param('client_id') clientId: string,
    @Body() dto: ClientTagsDto,
  ) {
    return this.tags.replace(req.user.id, clientId, dto.tags);
  }
}
