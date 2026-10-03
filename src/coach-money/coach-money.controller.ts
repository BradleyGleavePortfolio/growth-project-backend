import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Param,
  Query,
  Request,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CoachOrOwnerGuard } from '../common/guards/coach-or-owner.guard';
import { NoActiveSubCoachGuard } from '../common/guards/no-active-sub-coach.guard';
import {
  CHARGE_STATUS_FILTERS,
  type ChargeStatusFilter,
  CoachMoneyService,
  MONEY_CHARGES_PAGE_MAX,
  parseCurrency,
  parseWindow,
} from './coach-money.service';

// S-COACH (agent 111) — TGP Money read routes for the coach Money page.
// Self-only: every handler reads req.user.id and never accepts a coach id.
// Active sub-coaches are blocked (financial surface), matching
// /coach/connect/*.
@ApiTags('coach-money')
@Controller('v1/coach/money')
@UseGuards(JwtAuthGuard, CoachOrOwnerGuard, NoActiveSubCoachGuard)
export class CoachMoneyController {
  constructor(private readonly money: CoachMoneyService) {}

  // GET /v1/coach/money/summary?from&to[&compare_from&compare_to][&currency]
  // The device computes calendar windows (Today / 30d / 90d / YTD) in the
  // coach's own time zone; the server validates and bounds them. Every
  // amount is in the response's `currency` (B-641-3); `currencies` lists
  // the others the coach can switch to.
  @Roles('coach', 'owner')
  @Get('summary')
  @ApiOperation({ summary: 'Net to the coach for a window, with a comparison window' })
  @ApiResponse({
    status: 400,
    description: 'MONEY_WINDOW_INVALID | MONEY_COMPARE_WINDOW_INVALID | MONEY_CURRENCY_INVALID',
  })
  async summary(
    @Request() req: AuthedRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('compare_from') compareFrom?: string,
    @Query('compare_to') compareTo?: string,
    @Query('currency') currencyRaw?: string,
  ) {
    const window = parseWindow(from, to, 'window');
    const currency = parseCurrency(currencyRaw);
    const compare =
      compareFrom !== undefined || compareTo !== undefined
        ? parseWindow(compareFrom, compareTo, 'compare')
        : null;
    return this.money.getSummary(req.user.id, window, compare, new Date(), currency);
  }

  // GET /v1/coach/money/charges?status=all|paid|failed|refunded|disputed&cursor&limit
  @Roles('coach', 'owner')
  @Get('charges')
  @ApiOperation({ summary: "The coach's own charges, newest first, filtered by state" })
  @ApiResponse({ status: 400, description: 'MONEY_FILTER_INVALID' })
  async charges(
    @Request() req: AuthedRequest,
    @Query('status') statusRaw?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const status = (statusRaw ?? 'all') as ChargeStatusFilter;
    if (!CHARGE_STATUS_FILTERS.includes(status)) {
      throw new BadRequestException({
        code: 'MONEY_FILTER_INVALID',
        message: `status must be one of ${CHARGE_STATUS_FILTERS.join(', ')}.`,
      });
    }
    const parsed = limitRaw === undefined ? undefined : Number.parseInt(limitRaw, 10);
    const limit =
      parsed === undefined || Number.isNaN(parsed)
        ? undefined
        : Math.min(Math.max(parsed, 1), MONEY_CHARGES_PAGE_MAX);
    return this.money.listCharges(req.user.id, {
      status,
      cursor: cursor && cursor.trim() ? cursor.trim() : null,
      limit,
    });
  }

  // GET /v1/coach/money/export.csv?from&to[&currency] — C-641-4 "Export CSV for taxes".
  // Same window rules as /summary (max 400 days, so a tax year fits); the
  // net_to_you column sums to the summary's net for the same window.
  @Roles('coach', 'owner')
  @Get('export.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Sales, refunds and chargebacks in a window as CSV, for taxes' })
  @ApiResponse({ status: 200, description: 'text/csv attachment' })
  @ApiResponse({
    status: 400,
    description: 'MONEY_WINDOW_INVALID | MONEY_EXPORT_TOO_LARGE | MONEY_CURRENCY_INVALID',
  })
  async exportCsv(
    @Request() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('currency') currencyRaw?: string,
  ): Promise<string> {
    const window = parseWindow(from, to, 'window');
    const currency = parseCurrency(currencyRaw);
    const csv = await this.money.exportCsv(req.user.id, window, currency);
    const day = (d: Date) => d.toISOString().slice(0, 10);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="tgp-money-${day(window.from)}-to-${day(window.to)}${
        currency ? `-${currency}` : ''
      }.csv"`,
    );
    return csv;
  }

  // GET /v1/coach/money/charges/:id — price - processing - TGP 2% = net for
  // one of the coach's own charges. Another coach's id is a plain 404.
  @Roles('coach', 'owner')
  @Get('charges/:id')
  @ApiOperation({ summary: 'Fee breakdown for one of the coach’s own charges' })
  @ApiResponse({ status: 404, description: 'MONEY_CHARGE_NOT_FOUND' })
  async charge(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.money.getChargeBreakdown(req.user.id, id);
  }

  // GET /v1/coach/money/attention — failed payments with dunning status,
  // open disputes and Stripe requirements due, each with the client to message.
  @Roles('coach', 'owner')
  @Get('attention')
  @ApiOperation({ summary: 'What needs the coach’s attention in Money' })
  async attention(@Request() req: AuthedRequest) {
    return this.money.getAttention(req.user.id);
  }
}
