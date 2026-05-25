import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { ShareLinkService } from './share-link.service';

// R43 Storefront Phase 1 — coach-only share-link mint endpoint. JWT +
// coach role required; ownership is enforced inside the service so the
// guard does not need to load the package.
@ApiTags('packages')
@Controller('v1/coach/packages')
@UseGuards(JwtAuthGuard, CoachGuard)
export class ShareLinkController {
  constructor(private readonly shareLink: ShareLinkService) {}

  // POST /api/v1/coach/packages/:id/share-link
  // Idempotent: the first successful call mints a token; every subsequent
  // call returns the same token. The endpoint is a POST (not a GET) so it
  // can be safely retried by the mobile client without leaking the token
  // into a URL bar or referer header.
  @Post(':id/share-link')
  @HttpCode(HttpStatus.OK)
  async mintShareLink(
    @Request() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) packageId: string,
  ) {
    return this.shareLink.mintOrGet(req.user.id, packageId);
  }
}
