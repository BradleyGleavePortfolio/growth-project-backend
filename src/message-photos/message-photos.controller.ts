import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { THROTTLER_NAMES } from '../throttler/throttler.config';
import { MessagingService } from '../messaging/messaging.service';
import { photoError } from './message-photos.errors';
import { PhotoReportActionDto, PhotoUploadRequestDto } from './message-photos.dto';
import { MessagePhotosService, type PhotoThread } from './message-photos.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed id is answered like a missing photo (specific copy, no generic 400). */
function photoIdParam(raw: string): string {
  if (typeof raw !== 'string' || !UUID_RE.test(raw)) throw photoError('message_photo.not_found');
  return raw.toLowerCase();
}

/**
 * Client photo routes (thread = the client's assigned coach). Upload intents
 * and finalize are throttled per user; reads and deletes are not gated by the
 * kill switch (see message-photos.flag.ts).
 */
@ApiTags('messaging')
@Controller('messages/photos')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class ClientMessagePhotosController {
  constructor(
    private readonly messaging: MessagingService,
    private readonly photos: MessagePhotosService,
  ) {}

  private async thread(req: AuthedRequest): Promise<PhotoThread> {
    const t = await this.messaging.resolveClientThread(req.user.id);
    return { ...t, actorId: req.user.id, actorRole: 'student' };
  }

  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @Post()
  async createUpload(@Request() req: AuthedRequest, @Body() body: PhotoUploadRequestDto) {
    return this.photos.createUpload(await this.thread(req), body);
  }

  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @Post(':photoId/finalize')
  @HttpCode(200)
  async finalize(@Request() req: AuthedRequest, @Param('photoId') photoId: string) {
    return this.photos.finalize(await this.thread(req), photoIdParam(photoId));
  }

  @Get(':photoId')
  async view(@Request() req: AuthedRequest, @Param('photoId') photoId: string) {
    return this.photos.viewUrl(await this.thread(req), photoIdParam(photoId));
  }

  @Delete(':photoId')
  async remove(@Request() req: AuthedRequest, @Param('photoId') photoId: string) {
    return this.photos.deleteBySender(await this.thread(req), photoIdParam(photoId));
  }
}

/** Coach (head coach or assigned sub-coach) photo routes for one client's thread. */
@ApiTags('messaging')
@Controller('coach/clients/:client_id/messages/photos')
@Roles('coach')
@UseGuards(JwtAuthGuard, CoachGuard)
export class CoachMessagePhotosController {
  constructor(
    private readonly messaging: MessagingService,
    private readonly photos: MessagePhotosService,
  ) {}

  private async thread(req: AuthedRequest, clientId: string): Promise<PhotoThread> {
    const t = await this.messaging.resolveCoachThread(req.user.id, clientId);
    return { ...t, actorId: req.user.id, actorRole: 'coach' };
  }

  @Throttle({ [THROTTLER_NAMES.COACH_MESSAGES]: { ttl: 60_000, limit: 60 } })
  @Post()
  async createUpload(
    @Request() req: AuthedRequest,
    @Param('client_id') clientId: string,
    @Body() body: PhotoUploadRequestDto,
  ) {
    return this.photos.createUpload(await this.thread(req, clientId), body);
  }

  @Throttle({ [THROTTLER_NAMES.COACH_MESSAGES]: { ttl: 60_000, limit: 60 } })
  @Post(':photoId/finalize')
  @HttpCode(200)
  async finalize(
    @Request() req: AuthedRequest,
    @Param('client_id') clientId: string,
    @Param('photoId') photoId: string,
  ) {
    return this.photos.finalize(await this.thread(req, clientId), photoIdParam(photoId));
  }

  @Get(':photoId')
  async view(
    @Request() req: AuthedRequest,
    @Param('client_id') clientId: string,
    @Param('photoId') photoId: string,
  ) {
    return this.photos.viewUrl(await this.thread(req, clientId), photoIdParam(photoId));
  }

  @Delete(':photoId')
  async remove(
    @Request() req: AuthedRequest,
    @Param('client_id') clientId: string,
    @Param('photoId') photoId: string,
  ) {
    return this.photos.deleteBySender(await this.thread(req, clientId), photoIdParam(photoId));
  }
}

/**
 * TGP team review queue for reported photos (report -> review -> action, the
 * #610 loop for 1:1 threads, where the coach is a party and cannot review).
 * Platform owner only.
 */
@ApiTags('admin')
@Controller('admin/message-photos/reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner')
export class AdminMessagePhotosController {
  constructor(private readonly photos: MessagePhotosService) {}

  @Get()
  async queue() {
    return { items: await this.photos.reportQueue() };
  }

  @Patch(':reportId')
  async act(
    @Request() req: AuthedRequest,
    @Param('reportId') reportId: string,
    @Body() body: PhotoReportActionDto,
  ) {
    if (!UUID_RE.test(reportId)) throw photoError('message_photo.report_not_found');
    return this.photos.actOnReport(req.user.id, reportId, body.action, body.notes);
  }
}
