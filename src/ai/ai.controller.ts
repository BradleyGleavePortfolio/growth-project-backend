import { Controller, Post, Get, Body, UseGuards, Request } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AiService } from './ai.service';
import { JwtAuthGuard } from '../auth/auth.guard';

@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(private aiService: AiService) {}

  // Rate limited: 20 requests per hour per user (anti-abuse)
  @Post('chat')
  @Throttle({ default: { ttl: 3600000, limit: 20 } })
  async chat(
    @Request() req,
    @Body() body: { message: string; conversation_history?: Array<{ role: string; content: string }> },
  ) {
    const reply = await this.aiService.chat(
      req.user.id,
      body.message,
      body.conversation_history || [],
    );
    return { reply, timestamp: new Date().toISOString() };
  }

  @Get('context')
  async getContext(@Request() req) {
    return this.aiService.getUserContext(req.user.id);
  }
}
