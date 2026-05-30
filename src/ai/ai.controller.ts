import { Controller, Post, Get, Body, UseGuards, Request } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { Throttle } from '@nestjs/throttler';
import { AiService } from './ai.service';
import { ChatRequestDto } from './ai.dto';
import { JwtAuthGuard } from '../auth/auth.guard';
import { ClientEntitlementGuard } from '../common/guards/client-entitlement.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('ai')
@Controller('ai')
@UseGuards(JwtAuthGuard, RolesGuard, ClientEntitlementGuard)
@Roles('student')
export class AiController {
  constructor(private aiService: AiService) {}

  // Rate limited: 20 requests per hour per user (anti-abuse)
  @Post('chat')
  @Throttle({ default: { ttl: 3600000, limit: 20 } })
  async chat(@Request() req: AuthedRequest, @Body() body: ChatRequestDto) {
    const result = await this.aiService.chat(
      req.user.id,
      body.message,
      body.conversation_history || [],
    );
    const includeDebug = process.env.NODE_ENV !== 'production';
    const isFallback = result.model_used === 'fallback';
    return {
      reply: result.reply,
      timestamp: new Date().toISOString(),
      // A7 — `model` names the upstream provider (perplexity/anthropic/
      // fallback). It is debug-only: leaking it in prod tells an attacker
      // which provider (and which fallback state) backs the request. Keep
      // the buyer-facing `degraded` flag, but gate the provider name behind
      // the dev/debug block.
      degraded: isFallback,
      ...(includeDebug
        ? {
            model: result.model_used,
            debug: {
              guardrails_applied: result.guardrails_applied,
              context_generated_at: result.context_generated_at,
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
    return this.aiService.getUserContext(req.user.id);
  }

  // Typed ClientAIContext for the authenticated user. Surfaces the same
  // shape the AI sees so mobile can render a "what GP knows about you"
  // disclosure screen and QA can verify end-to-end without inspecting
  // server logs.
  @Get('structured-context')
  @Throttle({ default: { ttl: 3600000, limit: 60 } })
  async getStructuredContext(@Request() req: AuthedRequest) {
    return this.aiService.getStructuredContext(req.user.id);
  }
}
