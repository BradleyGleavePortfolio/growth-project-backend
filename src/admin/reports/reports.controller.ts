import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { ReportsService } from './reports.service';
import {
  TransformationScorecardService,
  TRANSFORMATION_SCORECARD_COLUMNS,
} from './transformation-scorecard.service';
import { buildScorecardPdf } from './scorecard-pdf';
import { objectToKeyValueCsv, rowsToCsv } from './csv';

// OWNER-only operational reports. The class-level guard pair is the same
// one /admin/* uses; coach and student tokens get a clean 403 from
// RolesGuard.
//
// Every report supports `?format=csv` to download a flat CSV and falls
// back to JSON for ad-hoc inspection in the console. CSV output sets
// Content-Disposition with a deterministic filename so a browser download
// lands as `<report>-<YYYYMMDD>.csv`.
//
// The transformation-scorecard report additionally supports `?format=pdf`
// which returns a branded A4 PDF (application/pdf, streaming). The PDF
// renders all rows in the result set (one client per page). Unknown or
// misspelled format values return HTTP 400.

// Allowed format values for endpoints that support PDF.
const ALLOWED_SCORECARD_FORMATS = new Set(['json', 'csv', 'pdf']);

@ApiTags('admin-reports')
@Controller('admin/reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner')
export class ReportsController {
  constructor(
    private reports: ReportsService,
    private scorecard: TransformationScorecardService,
  ) {}

  @Get('metrics-overview')
  async metricsOverview(
    @Query('format') format: string | undefined,
    @Query('since_days') sinceDaysRaw: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const sinceDays = parsePositiveInt(sinceDaysRaw);
    const envelope = await this.reports.metricsOverview({ sinceDays });
    if (isCsv(format)) {
      writeCsvHeaders(res, 'metrics-overview');
      return objectToKeyValueCsv(envelope as unknown as Record<string, unknown>);
    }
    return envelope;
  }

  @Get('coaches')
  async coaches(
    @Query('format') format: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const envelope = await this.reports.coaches();
    if (isCsv(format)) {
      writeCsvHeaders(res, 'coaches');
      return rowsToCsv(
        [
          'id',
          'email',
          'name',
          'created_at',
          'business_name',
          'invite_code',
          'subscription_status',
          'plan_tier',
          'client_count',
          'active_client_count',
        ],
        envelope.data,
      );
    }
    return envelope;
  }

  @Get('clients')
  async clients(
    @Query('format') format: string | undefined,
    @Query('limit') limitRaw: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const limit = parsePositiveInt(limitRaw);
    const envelope = await this.reports.clients({ limit });
    if (isCsv(format)) {
      writeCsvHeaders(res, 'clients');
      return rowsToCsv(
        [
          'id',
          'email',
          'name',
          'created_at',
          'archived_at',
          'coach_id',
          'coach_email',
          'deletion_scheduled_at',
        ],
        envelope.data,
      );
    }
    return envelope;
  }

  @Get('billing-past-due')
  async billingPastDue(
    @Query('format') format: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const envelope = await this.reports.billingPastDue();
    if (isCsv(format)) {
      writeCsvHeaders(res, 'billing-past-due');
      return rowsToCsv(
        [
          'coach_id',
          'coach_email',
          'status',
          'current_period_end',
          'last_payment_failed_at',
          'failed_payments_this_month',
          'cancel_at_period_end',
          'billing_email',
        ],
        envelope.data,
      );
    }
    return envelope;
  }

  @Get('product-usage')
  async productUsage(
    @Query('format') format: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const envelope = await this.reports.productUsage();
    if (isCsv(format)) {
      writeCsvHeaders(res, 'product-usage');
      return objectToKeyValueCsv(envelope as unknown as Record<string, unknown>);
    }
    return envelope;
  }

  @Get('federation-health')
  async federationHealth(
    @Query('format') format: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const envelope = await this.reports.federationHealth();
    if (isCsv(format)) {
      writeCsvHeaders(res, 'federation-health');
      return objectToKeyValueCsv(envelope as unknown as Record<string, unknown>);
    }
    return envelope;
  }

  @Get('audit-summary')
  async auditSummary(
    @Query('format') format: string | undefined,
    @Query('action') action: string | undefined,
    @Query('target_user_id') targetUserId: string | undefined,
    @Query('tenant_coach_id') tenantCoachId: string | undefined,
    @Query('since_days') sinceDaysRaw: string | undefined,
    @Query('limit') limitRaw: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const envelope = await this.reports.auditSummary({
      action,
      targetUserId,
      tenantCoachId,
      sinceDays: parsePositiveInt(sinceDaysRaw),
      limit: parsePositiveInt(limitRaw),
    });
    if (isCsv(format)) {
      writeCsvHeaders(res, 'audit-summary');
      return rowsToCsv(
        [
          'id',
          'created_at',
          'action',
          'actor_id',
          'actor_role',
          'actor_email',
          'target_user_id',
          'target_type',
          'target_id',
          'tenant_coach_id',
          'ip',
        ],
        envelope.data,
      );
    }
    return envelope;
  }

  @Get('ptm-signal-weights')
  async ptmSignalWeights(
    @Query('format') format: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const envelope = await this.reports.ptmSignalWeights();
    if (isCsv(format)) {
      writeCsvHeaders(res, 'ptm-signal-weights');
      // CSV columns match the documented row shape. When the engine is
      // not active (basis=heuristic_v1) the rows array is empty — the
      // file is still valid CSV with just the header line, which the
      // operator reads as "no trained weights yet".
      return rowsToCsv(
        [
          'signal_type',
          'weight',
          'training_count',
          'training_max',
          'success_avg',
          'failure_avg',
          'basis',
        ],
        envelope.data,
      );
    }
    return envelope;
  }

  // Phase 5 — Transformation scorecard. Per-client (or per-coach rollup)
  // composition off live data: identity, latest check-in, weight delta,
  // 30-day workout / meal / messaging engagement, latest PTM scores +
  // outcome, optional Phase-3 diagnostic and Phase-4 build-week status,
  // and finance federation columns (wealth_velocity_score, net_worth_delta,
  // milestones_hit — null when FINANCE_API_BASE_URL is unset).
  //
  // OWNER-only by class-level guard. With no `user_id` / `coach_id` the
  // report walks the OWNER's full client list, clamped to 1000.
  //
  // Supported formats: json (default), csv, pdf.
  // Unknown format values are rejected with 400.
  @Get('transformation-scorecard')
  async transformationScorecard(
    @Query('format') format: string | undefined,
    @Query('user_id') userId: string | undefined,
    @Query('coach_id') coachId: string | undefined,
    @Query('since_days') sinceDaysRaw: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Validate format value early so a typo returns a clear 400 rather than
    // silently falling back to JSON.
    if (
      format !== undefined &&
      !ALLOWED_SCORECARD_FORMATS.has(format.toLowerCase())
    ) {
      throw new BadRequestException(
        `format must be one of: ${Array.from(ALLOWED_SCORECARD_FORMATS).join(', ')}`,
      );
    }

    const envelope = await this.scorecard.build({
      userId,
      coachId,
      sinceDays: parsePositiveInt(sinceDaysRaw),
    });

    if (isCsv(format)) {
      writeCsvHeaders(res, 'transformation-scorecard');
      return rowsToCsv(TRANSFORMATION_SCORECARD_COLUMNS, envelope.data);
    }

    if (isPdf(format)) {
      writePdfHeaders(res, 'transformation-scorecard');
      const clientName = envelope.data[0]?.name ?? undefined;
      const since = envelope.window?.since ?? undefined;
      const pdfStream = buildScorecardPdf(envelope.data, {
        clientName,
        since,
        generatedAt: envelope.generated_at,
      });
      // Pipe the PDFDocument stream directly into the Express response.
      // passthrough: true is required so NestJS does not attempt to JSON-
      // serialize the stream itself.
      pdfStream.pipe(res);
      // Return undefined; NestJS passthrough mode hands off to the pipe.
      return;
    }

    return envelope;
  }

  // Manifest of available reports. Useful for the console to render a
  // dynamic export menu without hard-coding the list.
  @Get()
  index() {
    return {
      reports: [
        { name: 'metrics-overview', formats: ['json', 'csv'] },
        { name: 'coaches', formats: ['json', 'csv'] },
        { name: 'clients', formats: ['json', 'csv'] },
        { name: 'billing-past-due', formats: ['json', 'csv'] },
        { name: 'product-usage', formats: ['json', 'csv'] },
        { name: 'federation-health', formats: ['json', 'csv'] },
        { name: 'audit-summary', formats: ['json', 'csv'] },
        { name: 'ptm-signal-weights', formats: ['json', 'csv'] },
        { name: 'transformation-scorecard', formats: ['json', 'csv', 'pdf'] },
      ],
    };
  }
}

function isCsv(format: string | undefined): boolean {
  return typeof format === 'string' && format.toLowerCase() === 'csv';
}

function isPdf(format: string | undefined): boolean {
  return typeof format === 'string' && format.toLowerCase() === 'pdf';
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function writeCsvHeaders(res: Response, reportName: string): void {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${reportName}-${stamp}.csv"`,
  );
  // Defense in depth — a CSV downloaded into Excel should not be cached by
  // an intermediary, since these are tied to a point-in-time snapshot.
  res.setHeader('Cache-Control', 'no-store');
}

function writePdfHeaders(res: Response, reportName: string): void {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${reportName}-${stamp}.pdf"`,
  );
  res.setHeader('Cache-Control', 'no-store');
}
