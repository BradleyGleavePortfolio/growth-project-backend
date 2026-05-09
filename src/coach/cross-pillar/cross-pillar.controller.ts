import {
  Controller,
  Get,
  Param,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { CoachGuard } from '../../auth/coach.guard';
import { CrossPillarPracticeGuard } from './cross-pillar-practice.guard';
import { CrossPillarService } from './cross-pillar.service';

/**
 * CrossPillarController — Stage-3 coach-facing federation surface.
 *
 * Mounts under `/api/coach/cross-pillar/*`. Three guards in series, in
 * order:
 *
 *   1. `JwtAuthGuard` — Supabase JWT verified locally, populates
 *      `req.user` with the Prisma User row (including
 *      `coach_practice_type`).
 *   2. `CoachGuard` — `role` must be `coach` or `owner`.
 *   3. `CrossPillarPracticeGuard` — `coach_practice_type` must be
 *      `'both'`. Single-pillar coaches are rejected with a typed
 *      `403 PRACTICE_NOT_BOTH` so the mobile app routes them through
 *      the practice-selection flow rather than rendering an empty
 *      cross-pillar screen.
 *
 * The service layer reuses the OWNER federation primitives
 * (`FederationService.unifiedSearch` / `unifiedClient`) and the
 * low-level `FinanceAdminClient`. The only orchestration that lives
 * here is "for THIS coach's roster, fan out to finance and tag the
 * pillars".
 */
@ApiTags('coach-cross-pillar')
@Controller('coach/cross-pillar')
@UseGuards(JwtAuthGuard, CoachGuard, CrossPillarPracticeGuard)
export class CrossPillarController {
  constructor(private readonly service: CrossPillarService) {}

  /** Combined dashboard counters for the cross-pillar home screen. */
  @Get('analytics')
  analytics(@Request() req: AuthedRequest) {
    return this.service.getAnalytics(req.user.id, req.user.role ?? null);
  }

  /**
   * Coach roster with finance-block enrichment per row. Up to 50
   * fitness clients; each enriched in parallel via the existing
   * FinanceAdminClient. Per-row `finance.status` carries the failure
   * mode when the finance call was not 'ok'.
   */
  @Get('clients')
  clients(@Request() req: AuthedRequest) {
    return this.service.getClients(req.user.id, req.user.role ?? null);
  }

  /**
   * Single client by email — fans out to both products and returns the
   * full unified profile shape (same as OWNER admin console). The
   * mobile detail screen renders three tabs from this payload.
   *
   * `:identityKey` is documented as `email` today; an opaque key would
   * land here when a durable shared identity does. Decoded once at the
   * boundary.
   */
  @Get('clients/:identityKey')
  client(@Param('identityKey') identityKey: string) {
    return this.service.getClient(decodeURIComponent(identityKey));
  }

  /**
   * Universal search across both products. Reuses
   * `FederationService.unifiedSearch` directly. The mobile component
   * `<UniversalClientSearch />` calls this with a 200ms debounce.
   */
  @Get('search')
  search(@Query('q') q?: string, @Query('limit') limit?: string) {
    const parsedLimit = limit ? Number.parseInt(limit, 10) : undefined;
    return this.service.search(
      q ?? '',
      Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    );
  }
}
