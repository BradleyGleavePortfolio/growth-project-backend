import {
  Body,
  Controller,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { THROTTLER_ROUTE_LIMITS } from '../../throttler/throttler.config';
import { PrismaService } from '../../prisma.service';
import { recordVoiceErasures } from '../voice/voice-erasure';
import { CommunityAccessService } from '../community-access.service';
import { CommunityFeatureFlagGuard } from '../community-feature-flag.guard';
import { ImageUploadUrlDto } from '../dto/community-message.dto';
import { CommunityImageStore, communityImagesEnabled } from './community-image-store';

const COHORT_NOT_FOUND = { error: 'not_found', code: 'community.cohort.not_found' } as const;

/**
 * SC-BE3: one signed upload for a photo in a space chat. FEATURE_COMMUNITY_IMAGES
 * off is 404 (the route does not exist). SPACE-404-CLASS (operator ruling
 * 6353734516 on b#1137): a space the caller cannot open, a missing one and a
 * ban all read the same 404 community.cohort.not_found, so the answer never
 * says whether a space exists. The DTO allows JPEG up to 10 MB; the bucket
 * enforces both again and the send route checks the stored object. FX-1139:
 * the upload object's erasure is recorded, due when the link dies, before the
 * link is returned.
 */
@ApiTags('community')
@Controller('community')
export class CommunityImagesController {
  constructor(
    private readonly access: CommunityAccessService,
    private readonly store: CommunityImageStore,
    private readonly prisma: PrismaService,
  ) {}

  @Post('cohorts/:cohortId/images/upload-url')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('student', 'coach', 'owner')
  @Throttle({ default: { ttl: 60_000, limit: THROTTLER_ROUTE_LIMITS.COMMUNITY_POSTS_PER_MIN } })
  async uploadUrl(
    @Request() req: AuthedRequest,
    @Param('cohortId', new ParseUUIDPipe()) cohortId: string,
    @Body() _body: ImageUploadUrlDto,
  ): Promise<{ upload_url: string; key: string; expires_at: string }> {
    if (!communityImagesEnabled()) throw new NotFoundException();
    const cohort = await this.access.findCohort(cohortId);
    if (!cohort || !(await this.access.canAccessCohort(cohort, req.user))) {
      throw new NotFoundException(COHORT_NOT_FOUND);
    }
    const { sweep_at, ...link } = await this.store.signUpload(req.user.id, cohort.id);
    await recordVoiceErasures(this.prisma, [{ kind: 'image_upload', target: link.key }], 'upload_expiry', sweep_at);
    return link;
  }
}
