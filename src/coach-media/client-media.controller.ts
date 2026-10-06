/**
 * Buyer-side media delivery (B-DELIV-125, B3).
 *
 * A client who bought a package with a PDF or video receives a
 * ClientAssetGrant when that drop is delivered (MediaAssetResolver). This
 * route turns that grant into a short-lived signed URL so the client can
 * open what was paid for.
 *
 * Route:
 *   GET /v1/client/media/:id/signed-url — `:id` is the CoachMediaAsset id
 *   (the drop's `asset_id`).
 *
 * Access is decided entirely by CoachMediaService.getBuyerSignedUrl: the
 * caller must hold a live (not revoked) grant for that asset, the asset
 * must not be archived, and the grant's purchase must belong to the coach
 * who owns the asset. Every refusal is the same 404 so an asset id cannot
 * be probed. The URL uses the default signed TTL; the caller cannot pick a
 * longer one.
 */

import { Controller, Get, Param, Request, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CoachMediaService } from './coach-media.service';

@ApiTags('client-media')
@Controller('v1/client/media')
@UseGuards(JwtAuthGuard)
export class ClientMediaController {
  constructor(private readonly media: CoachMediaService) {}

  // RolesGuard is a global APP_GUARD. The roles mirror
  // GET /v1/checkout/purchases/:purchaseId/drops: whoever can see a
  // delivered drop can open it, and only with their own grant.
  @Roles('student', 'coach', 'owner')
  @Get(':id/signed-url')
  async signedUrl(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.media.getBuyerSignedUrl(req.user.id, id);
  }
}
