import {
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import * as Sentry from '@sentry/node';
import { DataExportDownload, DataExportService } from './data-export.service';
import { SUPPORT_EMAIL } from '../public-pages/trust-pages.html';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';

/**
 * DataExportController — GDPR Article 20 right to data portability.
 *
 * All routes except /download are covered by the global JwtAuthGuard
 * (registered as APP_GUARD in AppModule). The /download endpoint is
 * marked @Public() because the app opens the download link in the phone's
 * browser — there is no Bearer token in that context. Authentication is the
 * short-lived signed download token in the query string, minted for the
 * authenticated owner by POST /download-link.
 */
@Controller('v1/me/data-export')
export class DataExportController {
  private readonly logger = new Logger(DataExportController.name);

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
   * POST /v1/me/data-export/download-link
   *
   * Mint a short-lived (5 minute) download link for the caller's latest
   * export. The export is looked up by req.user.id only; there is no id
   * parameter, so a caller can never get a link to someone else's archive.
   * Errors: 404 DATA_EXPORT_NOT_FOUND, 409 DATA_EXPORT_NOT_READY,
   * 410 DATA_EXPORT_EXPIRED / DATA_EXPORT_FILE_MISSING.
   */
  @Roles('student', 'coach', 'owner')
  @Post('download-link')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async createDownloadLink(@Req() req: Request) {
    const userId = (req.user as { id: string }).id;
    return this.dataExportService.createDownloadLink(userId);
  }

  /**
   * GET /v1/me/data-export/download?token=<jwt>
   *
   * @Public() — the app opens this URL in the phone's browser, which has no
   * Bearer token. The query-string token is the credential: HS256, its own
   * audience and type, bound to the user and the export, 5 minutes by
   * default. Every check runs before a byte is read.
   *
   * On success: 200 with the archive streamed from private storage as an
   * attachment. The storage URL never leaves the server.
   * Errors: 401 DATA_EXPORT_LINK_INVALID / DATA_EXPORT_LINK_EXPIRED,
   * 409 DATA_EXPORT_NOT_READY, 410 DATA_EXPORT_EXPIRED / DATA_EXPORT_FILE_MISSING,
   * 503 DATA_EXPORT_STORAGE_UNAVAILABLE. A browser (Accept: text/html) gets a
   * plain page that says what happened and what to do; API clients get the
   * standard JSON error envelope.
   */
  @Get('download')
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  async download(
    @Query('token') token: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    let download: DataExportDownload;
    try {
      download = await this.dataExportService.openDownload(token);
    } catch (err) {
      if (err instanceof HttpException && wantsHtml(req)) {
        sendHtmlError(res, err, requestIdOf(req));
        return;
      }
      throw err;
    }
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${download.fileName}"`);
    setPrivateHeaders(res);
    if (download.size !== null) res.setHeader('Content-Length', String(download.size));
    try {
      // pipeline destroys the source when the browser disconnects, which ends
      // the archive iterator and cancels the upstream storage read (C-636-1).
      await pipeline(Readable.from(download.chunks), res);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === 'ERR_STREAM_PREMATURE_CLOSE') {
        // The person closed the page or lost signal; nothing is wrong on our side.
        this.logger.warn(`Download of export ${download.exportId} ended early (client closed).`);
      } else {
        // Headers are gone; the only honest signal left is a broken transfer.
        this.logger.error(
          `Streaming export ${download.exportId} failed: ${(err as Error).message}`,
        );
        Sentry.captureMessage('data export download stream failed', {
          level: 'error',
          extra: { export_id: download.exportId },
        });
      }
      res.destroy();
    }
  }
}

function setPrivateHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
}

function wantsHtml(req: Request): boolean {
  const accept = req.headers.accept ?? '';
  return /text\/html/i.test(accept);
}

function requestIdOf(req: Request): string | null {
  const id: unknown = Reflect.get(req, 'requestId');
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const HTML_TITLES: Record<string, string> = {
  DATA_EXPORT_LINK_EXPIRED: 'This download link has expired',
  DATA_EXPORT_LINK_INVALID: 'This download link is not valid',
  DATA_EXPORT_EXPIRED: 'This export has expired',
  DATA_EXPORT_FILE_MISSING: 'This file is no longer available',
  DATA_EXPORT_NOT_READY: 'Your export is not ready yet',
  DATA_EXPORT_STORAGE_UNAVAILABLE: 'We could not reach your file just now',
};

/** A small self-contained page: no scripts, no external assets. */
export function renderDownloadErrorPage(
  code: string | null,
  message: string,
  requestId: string | null,
): string {
  const title = (code && HTML_TITLES[code]) || 'We could not start your download';
  const reference = requestId ? `<p class="ref">Reference: ${escapeHtml(requestId)}</p>` : '';
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    `<title>${escapeHtml(title)}</title>`,
    '<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:32rem;',
    'margin:3rem auto;padding:0 1.25rem;color:#1a1a1a;background:#faf9f6;line-height:1.5}',
    'h1{font-size:1.4rem;font-weight:600}.ref{color:#555;font-size:.9rem}</style>',
    '</head><body>',
    `<h1>${escapeHtml(title)}</h1>`,
    `<p>${escapeHtml(message)}</p>`,
    `<p>If this keeps happening, email ${escapeHtml(SUPPORT_EMAIL)} and quote the reference below.</p>`,
    reference,
    '</body></html>',
  ].join('');
}

function sendHtmlError(res: Response, err: HttpException, requestId: string | null): void {
  const body = err.getResponse();
  let code: string | null = null;
  let message = err.message;
  if (body && typeof body === 'object') {
    const c: unknown = Reflect.get(body, 'code');
    const m: unknown = Reflect.get(body, 'message');
    if (typeof c === 'string') code = c;
    if (typeof m === 'string') message = m;
  }
  setPrivateHeaders(res);
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  res
    .status(err.getStatus())
    .type('html')
    .send(renderDownloadErrorPage(code, message, requestId));
}
