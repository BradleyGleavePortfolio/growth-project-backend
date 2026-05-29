/**
 * PR-12 — coach-media authoring endpoints.
 *
 * Mirrors the convention of CoachPackageContentsController:
 *   - same guards (JwtAuthGuard, CoachOrOwnerGuard, SubscriptionGuard)
 *   - role-gated to 'coach' / 'owner'
 *   - sub-coach scope via CoachMediaService.resolveEffectiveCoachId
 *   - body validation in the service via zod (not class-validator) so
 *     unknown keys are rejected loudly instead of silently stripped
 *
 * Routes:
 *   POST   /v1/coach/media/pdf/upload-url        — create PDF upload
 *   POST   /v1/coach/media/:id/pdf/confirm       — finalize PDF (status=ready)
 *   POST   /v1/coach/media/video/upload-url      — create video upload (Mux)
 *   GET    /v1/coach/media                       — list owned media
 *   GET    /v1/coach/media/:id                   — get one
 *   GET    /v1/coach/media/:id/signed-url        — owner signed URL
 *   PATCH  /v1/coach/media/:id                   — patch metadata
 *   DELETE /v1/coach/media/:id                   — soft-delete (archive)
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachOrOwnerGuard } from '../common/guards/coach-or-owner.guard';
import { SubscriptionGuard } from '../billing/subscription.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CoachMediaService } from './coach-media.service';

@ApiTags('coach-media')
@Controller('v1/coach/media')
@UseGuards(JwtAuthGuard, CoachOrOwnerGuard, SubscriptionGuard)
export class CoachMediaController {
  constructor(private readonly media: CoachMediaService) {}

  // ── PDF ────────────────────────────────────────────────────────────────

  @Roles('coach', 'owner')
  @Post('pdf/upload-url')
  async createPdfUpload(
    @Request() req: AuthedRequest,
    @Body() body: unknown,
  ) {
    const coachId = await this.media.resolveEffectiveCoachId(req.user.id);
    return this.media.createPdfUpload(coachId, body);
  }

  @Roles('coach', 'owner')
  @Post(':id/pdf/confirm')
  async confirmPdfUpload(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const coachId = await this.media.resolveEffectiveCoachId(req.user.id);
    return this.media.confirmPdfUpload(coachId, id, body);
  }

  // ── Video ──────────────────────────────────────────────────────────────

  @Roles('coach', 'owner')
  @Post('video/upload-url')
  async createVideoUpload(
    @Request() req: AuthedRequest,
    @Body() body: unknown,
  ) {
    const coachId = await this.media.resolveEffectiveCoachId(req.user.id);
    return this.media.createVideoUpload(coachId, body);
  }

  // ── Reads ──────────────────────────────────────────────────────────────

  @Roles('coach', 'owner')
  @Get()
  async list(
    @Request() req: AuthedRequest,
    @Query('kind') kind?: string,
  ) {
    const coachId = await this.media.resolveEffectiveCoachId(req.user.id);
    const kindFilter: 'pdf' | 'video' | undefined =
      kind === 'pdf' || kind === 'video' ? kind : undefined;
    const rows = await this.media.list(coachId, { kind: kindFilter });
    return { media: rows };
  }

  @Roles('coach', 'owner')
  @Get(':id')
  async getOne(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
  ) {
    const coachId = await this.media.resolveEffectiveCoachId(req.user.id);
    return this.media.getOne(coachId, id);
  }

  @Roles('coach', 'owner')
  @Get(':id/signed-url')
  async signedUrl(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Query('expires_in_seconds') expiresInSeconds?: string,
    @Query('download') download?: string,
  ) {
    const coachId = await this.media.resolveEffectiveCoachId(req.user.id);
    const parsedExpires = expiresInSeconds
      ? Number.parseInt(expiresInSeconds, 10)
      : undefined;
    return this.media.getOwnerSignedUrl(coachId, id, {
      expiresInSeconds:
        parsedExpires && Number.isFinite(parsedExpires)
          ? parsedExpires
          : undefined,
      download: download === '1' || download === 'true',
    });
  }

  // ── Patch ──────────────────────────────────────────────────────────────

  @Roles('coach', 'owner')
  @Patch(':id')
  async patch(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const coachId = await this.media.resolveEffectiveCoachId(req.user.id);
    return this.media.patch(coachId, id, body);
  }

  // ── Soft-delete ────────────────────────────────────────────────────────

  @Roles('coach', 'owner')
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async remove(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
  ) {
    const coachId = await this.media.resolveEffectiveCoachId(req.user.id);
    return this.media.softDelete(coachId, id);
  }
}
