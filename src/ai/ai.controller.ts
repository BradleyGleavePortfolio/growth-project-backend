import { Controller, Post, Get, Body, UseGuards, Request, GoneException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { Throttle } from '@nestjs/throttler';
import { AiService } from './ai.service';
import { ChatRequestDto } from './ai.dto';
import { JwtAuthGuard } from '../auth/auth.guard';
import { ClientEntitlementGuard } from '../common/guards/client-entitlement.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

/** Structured code for the retired AI Guide chat route (ENGINEERING_RULES §3). */
export const AI_GUIDE_RETIRED_CODE = 'AI_GUIDE_RETIRED';
export const AI_GUIDE_RETIRED_MESSAGE =
  'AI Guide chat has been retired. Please use Roman from the app home screen.';

@ApiTags('ai')
@Controller('ai')
@UseGuards(JwtAuthGuard, RolesGuard, ClientEntitlementGuard)
@Roles('student')
export class AiController {
  constructor(private aiService: AiService) {}

  // R2 (Sol audit of #601, finding A1): AI Guide is RETIRED on this surface.
  // The route used to send the assembled client context (including coach
  // private notes and other clients' community wins) to a second, non-Anthropic
  // AI provider under a consent that names Anthropic as the only processor. No consent
  // grant authorises that, so the handler is a deterministic 410 and NEVER
  // reaches AiService.chat. Roman (/roman/*) is the consented AI surface.
  // The handler body is intentionally unreachable by any provider code.
  @Post('chat')
  @Throttle({ default: { ttl: 3600000, limit: 20 } })
  chat(@Request() _req: AuthedRequest, @Body() _body: ChatRequestDto): never {
    throw new GoneException({
      code: AI_GUIDE_RETIRED_CODE,
      message: AI_GUIDE_RETIRED_MESSAGE,
    });
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
