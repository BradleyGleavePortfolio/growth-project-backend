import {
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
import { JwtAuthGuard } from '../../auth/auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthedRequest } from '../../auth/auth-request';
import { AiGatewayService } from './ai-gateway.service';
import { AiApprovalService } from './ai-approval.service';
import { PrivateContextService } from './private-context.service';

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
@ApiTags('ai-gateway')
@Controller('ai/gateway')
@UseGuards(JwtAuthGuard)
export class AiGatewayController {
  constructor(
    private gateway: AiGatewayService,
    private approvals: AiApprovalService,
    private context: PrivateContextService,
  ) {}

  // 20 calls / hour / user — same envelope as /ai/chat.
  @Post('invoke')
  @Throttle({ default: { ttl: 3600000, limit: 20 } })
  async invoke(
    @Request() req: AuthedRequest,
    @Body()
    body: {
      capability: string;
      message: string;
      subject_user_id?: string;
      conversation_history?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
      proposed_action?: Record<string, unknown>;
    },
  ) {
    const cap = (body.capability ?? '').trim();
    if (!cap) {
      throw new ForbiddenException('capability is required');
    }
    // Resolve permissioned context. For self-only capabilities the
    // subject defaults to the caller; the context service enforces the
    // boundary either way.
    const subjectId = body.subject_user_id ?? req.user.id;
    const ctx = await this.context.loadClientContext(
      { id: req.user.id, role: req.user.role, coach_id: req.user.coach_id ?? null },
      subjectId,
    );
    const result = await this.gateway.invoke({
      capability: cap,
      requester: { id: req.user.id, role: req.user.role },
      subjectUserId: subjectId,
      tenantCoachId: req.user.role === 'coach' ? req.user.id : undefined,
      userMessage: body.message ?? '',
      systemPrompt: ctx.systemPrompt,
      conversationHistory: body.conversation_history,
      provenance: ctx.provenance,
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
  async listDrafts(@Request() req: AuthedRequest, @Query('limit') limit?: string) {
    const limitNum = limit ? Math.max(1, Math.min(parseInt(limit, 10) || 50, 200)) : 50;
    return this.approvals.listPending({
      tenantCoachId: req.user.role === 'coach' ? req.user.id : undefined,
      limit: limitNum,
    });
  }

  @Patch('drafts/:id')
  @Roles('coach', 'owner')
  @UseGuards(JwtAuthGuard, RolesGuard)
  async decide(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: { decision: 'approved' | 'rejected'; note?: string },
  ) {
    const decision = body.decision === 'rejected' ? 'rejected' : 'approved';
    return this.approvals.decide({
      draftId: id,
      decider: { id: req.user.id, role: req.user.role },
      decision,
      note: body.note,
      ip: extractIp(req),
      userAgent: extractUserAgent(req),
    });
  }
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
