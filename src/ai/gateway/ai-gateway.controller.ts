import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsEnum, isUUID } from 'class-validator';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthedRequest } from '../../auth/auth-request';
import { AiGatewayService } from './ai-gateway.service';
import { AiApprovalService } from './ai-approval.service';
import { CHECK_IN_CANNOT_DRAFT, PrivateContextService } from './private-context.service';
import { COACH_MESSAGE_CAPABILITY } from './materialisers/coach-message.materialiser';
import { REPORT_REASONS, type ReportReason } from '../../messages-safety/dto/report-message.dto';
import { ClientEntitlementGuard } from '../../common/guards/client-entitlement.guard';
import { SkipClientEntitlement } from '../../common/decorators/skip-client-entitlement.decorator';
import { RomanRequiresCoachGuard } from '../../roman/roman-requires-coach';

// Thin HTTP surface for the gateway. Two intentional split-points:
//
//   - POST /ai/gateway/invoke — generic capability invocation. The body
//     declares the capability; the gateway picks provider, redacts,
//     audits, and (when applicable) opens an approval draft. Output
//     ALWAYS returns `draft_mode` so clients display it correctly.
//
//   - GET/PATCH /ai/gateway/drafts — human approval queue. Coaches see
//     pending drafts in their tenant; owners see everything; nobody can
//     decide a draft they themselves authored.
//
// Real production capabilities will mostly invoke the gateway server-
// side from feature services. This generic endpoint is here so the
// console / mobile can drive the v1 chat-with-approval surface
// without each capability requiring its own controller.
//
// A client with no coach has no Roman (139-15): 403 ROMAN_REQUIRES_COACH on
// every route here, before the paywall, the context load or the model.
/** The body of a draft report: the DM report's reason list; no text. */
export class ReportAiDraftDto {
  @IsEnum(REPORT_REASONS)
  reason!: ReportReason;
}

@ApiTags('ai-gateway')
@Controller('ai/gateway')
@UseGuards(JwtAuthGuard, RomanRequiresCoachGuard, ClientEntitlementGuard)
export class AiGatewayController {
  constructor(
    private gateway: AiGatewayService,
    private approvals: AiApprovalService,
    private context: PrivateContextService,
  ) {}

  @Get('status')
  @SkipClientEntitlement()
  async getStatus(@Request() req: AuthedRequest) {
    // Return the gateway provider/capability status
    return this.gateway.getStatus();
  }

  // ROMAN-HOURLY-SCOPE: 60/hour for coaches; other roles stay at 20.
  @Post('invoke')
  @Throttle({ default: {
    ttl: 3600000,
    limit: (ctx) => ctx.switchToHttp().getRequest<AuthedRequest>().user?.role === 'coach' ? 60 : 20,
  } })
  async invoke(
    @Request() req: AuthedRequest,
    @Body()
    body: InvokeBody,
  ) {
    const cap = (body.capability ?? '').trim();
    if (!cap) {
      throw new ForbiddenException('capability is required');
    }
    const fromCheckIn = body.check_in_id !== undefined;
    if (fromCheckIn) assertCheckInDraftRequest(body, cap, req.user.role);
    // Resolve permissioned context. For self-only capabilities the
    // subject defaults to the caller; the context service enforces the
    // boundary either way.
    const subjectId = body.subject_user_id ?? req.user.id;
    const ctx = await this.context.loadClientContext(
      { id: req.user.id, role: req.user.role, coach_id: req.user.coach_id ?? null },
      subjectId,
      { capability: cap },
    );
    // CHECKIN-DRAFT-BE: only a coach who has just passed the check above reaches a check-in; the words come from the
    // server, never the request. A client's token goes on to the gateway's 403 without any read.
    const checkIn = fromCheckIn && req.user.role === 'coach'
      ? await this.context.loadCheckInDraft(
          { id: req.user.id, role: req.user.role, coach_id: req.user.coach_id ?? null },
          subjectId,
          String(body.check_in_id),
        )
      : null;
    const result = await this.gateway.invoke({
      capability: cap,
      requester: { id: req.user.id, role: req.user.role },
      subjectUserId: subjectId,
      tenantCoachId: req.user.role === 'coach' ? req.user.id : undefined,
      userMessage: checkIn ? checkIn.userMessage : body.message ?? '',
      systemPrompt: ctx.systemPrompt,
      conversationHistory: body.conversation_history,
      provenance: checkIn ? [...ctx.provenance, checkIn.provenance] : ctx.provenance,
      proposedActionPayload: body.proposed_action,
      ip: extractIp(req),
      userAgent: extractUserAgent(req),
    });

    return {
      request_id: result.requestId,
      audit_id: result.auditId,
      approval: {
        required: result.approvalRequired,
        status: result.approvalStatus,
        draft_id: result.approvalDraftId,
      },
      enabled: result.enabled,
      provider: result.provider,
      model: result.model,
      reply: result.reply,
      // Caller MUST display the response as draft when this is true.
      draft_mode: result.draftMode,
      provenance: result.provenance,
      redactions_applied: result.redactionsApplied,
    };
  }

  @Get('drafts')
  @Roles('coach', 'owner')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async listDrafts(
    @Request() req: AuthedRequest,
    @Query('limit') limit?: string,
    @Query('clientId') clientId?: string,
    @Query('status') status?: string,
    @Query('order') order?: string,
    @Query('after') after?: string,
  ) {
    const limitNum = limit ? Math.max(1, Math.min(parseInt(limit, 10) || 50, 200)) : 50;
    // COPILOT-BE: `order=oldest` is the paged queue ({ items, total, next_cursor }); without it the list stays an array.
    if (order === 'oldest') {
      return this.approvals.pageQueue({ tenantCoachId: req.user.role === 'coach' ? req.user.id : undefined, limit: limitNum, after, readerId: req.user.id });
    }
    return this.approvals.listPending({
      tenantCoachId: req.user.role === 'coach' ? req.user.id : undefined,
      limit: limitNum,
      subjectUserId: clientId,
      status: status,
      readerId: req.user.id,
    });
  }

  @Patch('drafts/:id')
  @Roles('coach', 'owner')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async decide(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: { decision: 'approved' | 'rejected'; note?: string; accepted_change_ids?: unknown; payload?: unknown },
  ) {
    const decision = body.decision === 'rejected' ? 'rejected' : 'approved';
    // B-AIB2-126 — optional subset of an AI workout-builder draft (`c<i>` ids).
    const ids = body.accepted_change_ids;
    if (
      ids !== undefined &&
      (!Array.isArray(ids) || ids.length > 400 || !ids.every((v) => typeof v === 'string' && /^c\d{1,3}$/.test(v)))
    ) {
      throw new BadRequestException({
        code: 'INVALID_ACCEPTED_CHANGES',
        message: 'accepted_change_ids must be a list of change ids from the proposal.',
      });
    }
    return this.approvals.decide({
      draftId: id,
      decider: { id: req.user.id, role: req.user.role },
      decision,
      note: body.note,
      acceptedChangeIds: ids as string[] | undefined,
      editedPayload: body.payload,
      ip: extractIp(req),
      userAgent: extractUserAgent(req),
    });
  }

  // CHECKIN-DRAFT-BE: Report this draft. The draft stays pending and nothing is sent.
  @Post('drafts/:id/report')
  @Roles('coach')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Throttle({ default: { ttl: 3_600_000, limit: 20 } })
  async reportDraft(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: ReportAiDraftDto,
  ) {
    return this.approvals.reportDraft({
      draftId: id,
      reporter: { id: req.user.id, role: req.user.role },
      reason: body.reason,
      ip: extractIp(req),
      userAgent: extractUserAgent(req),
    });
  }
}

interface InvokeBody {
  capability: string;
  message: string;
  subject_user_id?: string;
  conversation_history?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  proposed_action?: Record<string, unknown>;
  // CHECKIN-DRAFT-BE: draft a reply to this check-in of subject_user_id. Everything else comes from the server.
  check_in_id?: unknown;
}

/** A check-in draft is a coach's, for one named client, with no caller context. A client's token stays today's 403. */
function assertCheckInDraftRequest(body: InvokeBody, cap: string, role: string): void {
  if (cap === COACH_MESSAGE_CAPABILITY && role !== 'coach' && role !== 'owner') return;
  const valid =
    cap === COACH_MESSAGE_CAPABILITY &&
    role === 'coach' &&
    typeof body.check_in_id === 'string' &&
    isUUID(body.check_in_id) &&
    !!body.subject_user_id &&
    body.conversation_history === undefined &&
    body.proposed_action === undefined;
  if (!valid) throw new BadRequestException({ code: 'CHECK_IN_DRAFT_INVALID', message: CHECK_IN_CANNOT_DRAFT });
}

function extractIp(req: AuthedRequest): string | null {
  const xff = (req.headers?.['x-forwarded-for'] as string) ?? '';
  if (xff) return xff.split(',')[0].trim();
  return req.ip ?? null;
}

function extractUserAgent(req: AuthedRequest): string | null {
  const ua = req.headers?.['user-agent'];
  if (!ua) return null;
  return Array.isArray(ua) ? ua[0] ?? null : ua;
}
