import { Controller, Post, Get, Body, UseGuards, Request } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { Throttle } from '@nestjs/throttler';
import { AiService } from './ai.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@ApiTags('ai')
@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(private aiService: AiService) {}

  // Rate limited: 20 requests per hour per user (anti-abuse)
  @Post('chat')
  @Throttle({ default: { ttl: 3600000, limit: 20 } })
  async chat(
    @Request() req: AuthedRequest,
    @Body()
    body: {
      message: string;
      conversation_history?: Array<{ role: string; content: string }>;
    },
  ) {
    const result = await this.aiService.chat(
      req.user.id,
      body.message,
      body.conversation_history || [],
    );
    const includeDebug = process.env.NODE_ENV !== 'production';
    return {
      reply: result.reply,
      timestamp: new Date().toISOString(),
      ...(includeDebug
        ? {
            debug: {
              guardrails_applied: result.guardrails_applied,
              context_generated_at: result.context_generated_at,
              model_used: result.model_used,
            },
          }
        : {}),
    };
  }

  @Get('context')
  async getContext(@Request() req: AuthedRequest) {
    return this.aiService.getUserContext(req.user.id);
  }

  // Typed ClientAIContext for the authenticated user. Surfaces the same
  // shape the AI sees so mobile can render a "what GP knows about you"
  // disclosure screen and QA can verify end-to-end without inspecting
  // server logs.
  @Get('structured-context')
  async getStructuredContext(@Request() req: AuthedRequest) {
    return this.aiService.getStructuredContext(req.user.id);
  }
}
