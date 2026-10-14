import { Controller, Post, Get, Body, UseGuards, Request } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { Throttle } from '@nestjs/throttler';
import { AiService } from './ai.service';
import { ChatRequestDto } from './ai.dto';
import { JwtAuthGuard } from '../auth/auth.guard';
import { ClientEntitlementGuard } from '../common/guards/client-entitlement.guard';
import { OpenToCoachlessClient } from '../common/decorators/open-to-coachless-client.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AI_GUIDE_CRISIS_REPLIES, classifyAiGuideCrisis } from './ai-crisis-router';
import { assertRomanHasCoach } from '../roman/roman-requires-coach';

// R2 (audit MED-01, MED-02): Guidance is retired, so Roman is the only AI
// chat. App builds already in users' hands still call POST /ai/chat until
// the app update ships, so the route stays and answers with this fixed text
// in the same response shape. No model is called and nothing is stored.
export const AI_GUIDE_RETIRED_REPLY =
  'Guidance is now part of Roman. Tap Roman at the top of your Home screen to keep chatting.';
export const AI_GUIDE_RETIRED_CODE = 'AI_GUIDE_RETIRED';

@ApiTags('ai')
@Controller('ai')
@UseGuards(JwtAuthGuard, RolesGuard, ClientEntitlementGuard)
@Roles('student')
// B23 + owner 10-08 23:5x: AI guidance answers every client, package or not.
// A coached client draws on the coach credit pool, a client with no coach on
// none (ai.service checkCoachPool); the per-user daily cap always applies.
@OpenToCoachlessClient()
export class AiController {
  constructor(private aiService: AiService) {}

  // ROMAN-HOURLY-SCOPE: 60/hour for coaches; other roles stay at 20.
  @Post('chat')
  @Throttle({ default: {
    ttl: 3600000,
    limit: (ctx) => ctx.switchToHttp().getRequest<AuthedRequest>().user?.role === 'coach' ? 60 : 20,
  } })
  async chat(@Request() req: AuthedRequest, @Body() body: ChatRequestDto) {
    // Owner 10-09 00:0x: the guide is Roman, so a client with no coach gets
    // 403 ROMAN_REQUIRES_COACH before any AI call, quota or pool check. A
    // crisis message still gets the fixed 988 / 911 reply.
    const crisis = classifyAiGuideCrisis(body.message);
    if (!crisis) assertRomanHasCoach(req.user);
    // R2: never AiService.chat. A crisis message keeps the fixed 988 / 911
    // reply; anything else gets the fixed retirement reply.
    const result = crisis
      ? {
          reply: AI_GUIDE_CRISIS_REPLIES[crisis],
          guardrails_applied: [`crisis:${crisis}`],
          model_used: 'safety',
        }
      : {
          reply: AI_GUIDE_RETIRED_REPLY,
          guardrails_applied: ['guidance_retired'],
          model_used: 'retired',
          code: AI_GUIDE_RETIRED_CODE,
        };
    const contextGeneratedAt = new Date().toISOString();
    const includeDebug = process.env.NODE_ENV !== 'production';
    return {
      reply: result.reply,
      timestamp: contextGeneratedAt,
      // A7 — `model` names the upstream provider (perplexity/anthropic/
      // fallback). It is debug-only: leaking it in prod tells an attacker
      // which provider (and which fallback state) backs the request. Keep
      // the buyer-facing `degraded` flag, but gate the provider name behind
      // the dev/debug block.
      degraded: false,
      // A fixed non-model reply carries its machine code so the app can
      // recognise it (R2: AI_GUIDE_RETIRED).
      ...('code' in result ? { code: result.code } : {}),
      ...(includeDebug
        ? {
            model: result.model_used,
            debug: {
              guardrails_applied: result.guardrails_applied,
              context_generated_at: contextGeneratedAt,
              model_used: result.model_used,
            },
          }
        : {}),
    };
  }

  // A8 — heavy multi-join context build. Throttle the abuse vector
  // (60 requests/hour/user) so a client can't hammer the join. Same
  // @Throttle envelope as /ai/chat, just a higher limit for a read.
  @Get('context')
  @Throttle({ default: { ttl: 3600000, limit: 60 } })
  async getContext(@Request() req: AuthedRequest) {
    // 139-15: a client with no coach has no Roman, so no AI context is built
    // or read for them: 403 ROMAN_REQUIRES_COACH first.
    assertRomanHasCoach(req.user);
    return this.aiService.getUserContext(req.user.id);
  }

  // Typed ClientAIContext for the authenticated user. Surfaces the same
  // shape the AI sees so mobile can render a "what GP knows about you"
  // disclosure screen and QA can verify end-to-end without inspecting
  // server logs.
  @Get('structured-context')
  @Throttle({ default: { ttl: 3600000, limit: 60 } })
  async getStructuredContext(@Request() req: AuthedRequest) {
    // 139-15: same 403 ROMAN_REQUIRES_COACH as /ai/context, before the read.
    assertRomanHasCoach(req.user);
    return this.aiService.getStructuredContext(req.user.id);
  }
}
