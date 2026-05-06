// Phase 1C — OWNER-only PTM teaching surface for the admin console.
//
// Mobile clients NEVER hit these endpoints. The class-level
// JwtAuthGuard + RolesGuard @Roles('owner') pair returns a clean 403 to
// any coach or student token; the mobile API gateway has no path-rewrite
// onto this surface either. Coaches do not teach the model in 1C — that
// is intentionally a future-phase decision once the weighted v2 engine
// (1D) has graduated.
//
// Doctrine recap:
//   * `notes` on a labelled outcome is persisted but NEVER returned over
//     the API. The service select clauses omit the column on every read.
//   * The audit row is awaited before the response so the AuditLog write
//     is durable for the operator's compliance review.
//   * Recompute is awaited to populate the response payload but its
//     failure is caught — the outcome stays persisted regardless.
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthedRequest } from '../../auth/auth-request';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { AdminPtmService } from './admin-ptm.service';
import {
  LabelOutcomeDto,
  OutcomeHistoryQueryDto,
  RiskBoardQueryDto,
} from './admin-ptm.dto';

@ApiTags('admin-ptm')
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner')
export class AdminPtmController {
  constructor(private readonly ptmAdmin: AdminPtmService) {}

  @Post('clients/:id/outcome')
  @ApiOperation({
    summary: 'Label a client outcome and trigger an immediate PTM recompute.',
  })
  @ApiResponse({
    status: 201,
    description: 'Outcome labelled. Returns the public outcome (no notes) and the freshly recomputed prediction.',
  })
  @ApiResponse({ status: 400, description: 'Validation error.' })
  @ApiResponse({ status: 403, description: 'Caller is not an OWNER.' })
  @ApiResponse({ status: 404, description: 'Target user is not a known student.' })
  async labelOutcome(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: LabelOutcomeDto,
  ) {
    return this.ptmAdmin.labelOutcome(id, body, {
      actorId: req.user.id,
      actorRole: req.user.role ?? null,
      actorEmail: req.user.email ?? null,
    });
  }

  @Get('clients/:id/ptm')
  @ApiOperation({
    summary: 'Per-client PTM teaching detail: latest score, last-30 history, current outcome (no notes), recent signal aggregates.',
  })
  @ApiResponse({ status: 200, description: 'Detail envelope.' })
  @ApiResponse({ status: 403, description: 'Caller is not an OWNER.' })
  @ApiResponse({ status: 404, description: 'Client not found.' })
  async getClientPtm(@Param('id') id: string) {
    return this.ptmAdmin.getClientPtm(id);
  }

  @Get('ptm/risk-board')
  @ApiOperation({
    summary: 'Risk board: most-recent prediction per student sorted by risk_score DESC. Cursor-paginated by computed_at.',
  })
  @ApiResponse({ status: 200, description: 'Page of risk-board rows.' })
  @ApiResponse({ status: 403, description: 'Caller is not an OWNER.' })
  async getRiskBoard(@Query() query: RiskBoardQueryDto) {
    return this.ptmAdmin.getRiskBoard({
      bucket: query.bucket,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Get('ptm/outcome-history')
  @ApiOperation({
    summary: 'Labelled-outcome training set, newest-first. Notes are never returned.',
  })
  @ApiResponse({ status: 200, description: 'Page of outcome-history rows.' })
  @ApiResponse({ status: 403, description: 'Caller is not an OWNER.' })
  async getOutcomeHistory(@Query() query: OutcomeHistoryQueryDto) {
    return this.ptmAdmin.getOutcomeHistory({
      outcome_type: query.outcome_type,
      before: query.before,
      limit: query.limit,
    });
  }
}
