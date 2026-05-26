import {
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { DataExportService } from './data-export.service';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';

/**
 * DataExportController — GDPR Article 20 right to data portability.
 *
 * All routes except /download are covered by the global JwtAuthGuard
 * (registered as APP_GUARD in AppModule). The /download endpoint is
 * marked @Public() because the download link is sent via email and opened
 * in a browser — there is no Bearer token in that context. Authentication
 * is performed by the signed download token in the query string instead.
 */
@Controller('v1/me/data-export')
export class DataExportController {
  constructor(private readonly dataExportService: DataExportService) {}

  /**
   * POST /v1/me/data-export/request
   *
   * Enqueue a new export. Rate-limited to one request per user per 24 h.
   * Returns 409 when the user already has a non-terminal request (PENDING,
   * RUNNING, or READY) within the window. Returns 202 Accepted immediately;
   * the export runs async and the client should poll /status for completion.
   */
  // C5 PR-A audit (corrected R2 — audit A1-C5-P2-1):
  // GDPR Article 20 (right to data portability). Every logged-in user must be
  // able to request an export of their own data. The userId is taken from
  // req.user.id — it is NEVER read from body / query / param. A user can
  // therefore never trigger another user's export.
  //
  // Service-layer rate limit (DataExportService.requestExport): any
  // non-terminal export — PENDING, RUNNING, or READY — created within the
  // current RATE_LIMIT_HRS window (default 24h) for the same user causes a
  // 409 Conflict. RUNNING is intentionally included so concurrent GDPR jobs
  // cannot be triggered during a long-running export (audit A1-C5-INF-2;
  // regression test in test/data-export.service.spec.ts).
  //
  // This durable DB-state check is preferred over an HTTP-layer @Throttle
  // because it survives process restarts and horizontal scale-out, and it
  // matches the semantics of the legal/GDPR commitment we make to users.
  // GDPR Art. 12(3) ("without undue delay and in any event within one month")
  // does not require us to permit multiple parallel exports per user.
  @Roles('student', 'coach', 'owner')
  @Post('request')
  @HttpCode(HttpStatus.ACCEPTED)
  async requestExport(@Req() req: Request) {
    const userId = (req.user as { id: string }).id;
    const record = await this.dataExportService.requestExport(userId);
    return {
      id: record.id,
      status: record.status,
      created_at: record.created_at,
      message:
        'Export queued. Your file will be available to download from this screen when ready. This usually takes under 60 seconds.',
    };
  }

  /**
   * GET /v1/me/data-export/status
   *
   * Returns the most recent export request for the authenticated user.
   * Returns 404 when no export has ever been requested.
   */
  // C5 PR-A audit: read-only status of the caller's own most recent export.
  // Scoped by req.user.id; never accepts a userId parameter. Any logged-in role.
  @Roles('student', 'coach', 'owner')
  @Get('status')
  async getStatus(@Req() req: Request) {
    const userId = (req.user as { id: string }).id;
    return this.dataExportService.getLatestStatus(userId);
  }

  /**
   * GET /v1/me/data-export/download?token=<jwt>
   *
   * @Public() — this route is opened in a browser from an email link, so
   * there is no Bearer token. The query-string token carries its own user
   * binding (signed with DATA_EXPORT_TOKEN_SECRET).
   *
   * On success: 302 redirect to the S3 presigned URL. Files are NEVER served
   * through this API process — the redirect is to S3 directly.
   * On invalid / expired token: 401.
   * On expired export: 410.
   */
  @Get('download')
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async download(
    @Query('token') token: string,
    @Res() res: Response,
  ) {
    const url = await this.dataExportService.resolveDownloadUrl(token);
    return res.redirect(302, url);
  }
}
