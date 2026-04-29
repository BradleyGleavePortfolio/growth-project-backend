import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachOrOwnerGuard } from '../common/guards/coach-or-owner.guard';
import { SubscriptionGuard } from '../billing/subscription.guard';
import { V1SaveDraftDto, V1SendMessageDto } from './v1-coach.dto';
import { V1CoachService } from './v1-coach.service';

// V1 Backend-For-Frontend for the tgp-coach-console. The path layout matches
// the contracts in tgp-coach-console/INTEGRATION_NOTES.md exactly so the
// console can be pointed at this origin without a translation shim.
//
// Auth: every route requires a JWT and a coach-or-owner role. SubscriptionGuard
// gates write paths so a coach whose subscription is canceled or past_due
// cannot continue sending messages; OWNER bypasses both checks.
@ApiTags('coach-v1')
@Controller('v1/coach/me')
@UseGuards(JwtAuthGuard, CoachOrOwnerGuard)
export class V1CoachController {
  constructor(private v1: V1CoachService) {}

  @Get()
  async getMe(@Request() req: AuthedRequest) {
    return this.v1.getMe(req.user);
  }

  @Get('clients')
  async listClients(@Request() req: AuthedRequest) {
    return this.v1.listClients(req.user);
  }

  @Get('threads')
  async listThreads(@Request() req: AuthedRequest) {
    return this.v1.listThreads(req.user);
  }

  @Get('threads/:clientId')
  async getThread(
    @Request() req: AuthedRequest,
    @Param('clientId') clientId: string,
  ) {
    return this.v1.getThread(req.user, clientId);
  }

  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @UseGuards(SubscriptionGuard)
  @Post('threads/:clientId/messages')
  async sendMessage(
    @Request() req: AuthedRequest,
    @Param('clientId') clientId: string,
    @Body() body: V1SendMessageDto,
  ) {
    return this.v1.sendMessage(req.user, clientId, body.body, body.snippetId);
  }

  @Get('threads/:clientId/draft')
  async getDraft(
    @Request() req: AuthedRequest,
    @Param('clientId') clientId: string,
  ) {
    return this.v1.getDraft(req.user, clientId);
  }

  // Drafts are write-heavy (autosaved on every keystroke debounce), so the
  // throttle ceiling is generous. SubscriptionGuard applies so a canceled
  // coach cannot accumulate compose-state for messages they will never be
  // able to send.
  @Throttle({ default: { ttl: 60_000, limit: 120 } })
  @UseGuards(SubscriptionGuard)
  @Post('threads/:clientId/draft')
  async saveDraft(
    @Request() req: AuthedRequest,
    @Param('clientId') clientId: string,
    @Body() body: V1SaveDraftDto,
  ) {
    return this.v1.saveDraft(req.user, clientId, body.body, body.snippetId);
  }
}
