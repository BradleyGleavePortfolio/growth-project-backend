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
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ShareLinkService } from './share-link.service';

// R43 Storefront Phase 1 — coach-only share-link mint endpoint.
//
// Authorization: JwtAuthGuard establishes req.user, RolesGuard reads the
// class-level @Roles('coach') metadata to enforce the role, and CoachGuard
// keeps the legacy ownership check in place for defence-in-depth. The
// roles-enforced contract suite walks @Roles metadata to prove no route
// is silently ungated — see test/roles-enforced.spec.ts.
@ApiTags('packages')
@Controller('v1/coach/packages')
@UseGuards(JwtAuthGuard, RolesGuard, CoachGuard)
@Roles('coach')
export class ShareLinkController {
  constructor(private readonly shareLink: ShareLinkService) {}

  // POST /api/v1/coach/packages/:id/share-link
  // Idempotent: the first successful call mints a token; every subsequent
  // call returns the same token. The endpoint is a POST (not a GET) so it
  // can be safely retried by the mobile client without leaking the token
  // into a URL bar or referer header.
  //
  // IDEMPOTENCY: R39 exception approved.
  // Share-link mint is naturally idempotent: if a token already exists for
  // this package, the same token is returned. No header ledger needed.
  // See mintOrGet() in src/share-link/share-link.service.ts.
  @Post(':id/share-link')
  @HttpCode(HttpStatus.OK)
  async mintShareLink(
    @Request() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) packageId: string,
  ) {
    return this.shareLink.mintOrGet(req.user.id, packageId);
  }
}
