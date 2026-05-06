import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { DiagnosticService } from './diagnostic.service';
import {
  DiagnosticCatalogResponse,
  ResultResponse,
  SubmissionResponse,
  SubmitDiagnosticDto,
} from './diagnostic.dto';
import { getCatalogResponse } from './question-catalog';
import { THROTTLER_NAMES } from '../throttler/throttler.config';

/**
 * Phase 3 — public 40-point diagnostic endpoints.
 *
 *   GET  /diagnostic/questions    — public catalog (no PII).
 *   POST /diagnostic/submit       — public lead capture; returns submission_id immediately,
 *                                   AI roadmap generated async.
 *   GET  /diagnostic/:id          — fetches submission + roadmap (poll until status='ready'|'failed').
 *
 * Auth posture: all three are @Public(). The submit endpoint is rate-limited
 * by the named throttler `diagnostic-submit` (default 5/hour/IP via
 * UserThrottlerGuard). DIAGNOSTIC_RATE_LIMIT_PER_HOUR can override at boot.
 */
@ApiTags('diagnostic')
@Controller('diagnostic')
export class DiagnosticController {
  constructor(private readonly svc: DiagnosticService) {}

  @Public()
  @Get('questions')
  @ApiOperation({
    summary: 'Public 40-question diagnostic catalog',
    description:
      'Returns the question catalog (id, section, text), section metadata, and the Likert ' +
      'scale label. No PII. Safe to call without authentication. Cacheable; the ' +
      'catalog is hand-curated and only changes when prompt_version bumps.',
  })
  @ApiResponse({ status: 200, description: 'Catalog payload.' })
  getQuestions(): DiagnosticCatalogResponse {
    return getCatalogResponse();
  }

  @Public()
  @Post('submit')
  @HttpCode(HttpStatus.OK)
  // Named throttler `diagnostic-submit`: 5/hour/IP by default. Tracker is
  // IP because this endpoint is unauthenticated by definition (it predates
  // signup). The actual limit is read from the throttler config which is
  // built from DIAGNOSTIC_RATE_LIMIT_PER_HOUR at module init.
  @Throttle({
    [THROTTLER_NAMES.DIAGNOSTIC_SUBMIT]: {
      ttl: 3_600_000,
      limit: Number(process.env.DIAGNOSTIC_RATE_LIMIT_PER_HOUR ?? 5),
    },
  })
  @ApiOperation({
    summary: 'Submit 40 answers; returns scores + bucket immediately',
    description:
      'Validates exactly 40 answers, computes per-section + overall scores, persists ' +
      'a DiagnosticSubmission row, and kicks off async AI roadmap generation. The roadmap ' +
      'lands on the same submission via GET /diagnostic/:id when ready.',
  })
  @ApiResponse({ status: 200, description: 'Submission persisted; roadmap generating.' })
  @ApiResponse({ status: 400, description: 'Validation error (≠40 answers, out-of-range value).' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded.' })
  async submit(
    @Body() body: SubmitDiagnosticDto,
    @Req() req: Request,
  ): Promise<SubmissionResponse> {
    const xff = (req.headers['x-forwarded-for'] || '') as string;
    const ip = xff.split(',')[0]?.trim() || req.ip;
    const userAgent = (req.headers['user-agent'] || '') as string;
    return this.svc.submit(body, { ip: ip || undefined, user_agent: userAgent || undefined });
  }

  @Public()
  @Get(':submissionId')
  @ApiOperation({
    summary: 'Fetch submission + roadmap (poll until status=ready|failed)',
    description:
      'Returns the full submission summary plus the AI roadmap when it has been ' +
      'generated. Clients should poll this endpoint with a small backoff (e.g. 2s) ' +
      'until roadmap_status is ready or failed. 404 only if the submission_id is ' +
      'unknown — a missing roadmap is reported as roadmap_status=generating.',
  })
  @ApiResponse({ status: 200, description: 'Submission + roadmap (when ready).' })
  @ApiResponse({ status: 404, description: 'Unknown submission id.' })
  async get(@Param('submissionId') submissionId: string): Promise<ResultResponse> {
    return this.svc.getResult(submissionId);
  }
}
