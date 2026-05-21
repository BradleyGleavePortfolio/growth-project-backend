import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth-request';
import { MessagesSafetyService } from './messages-safety.service';
import { ReportMessageDto } from './dto/report-message.dto';

/**
 * MessagesSafetyController — Apple App Review 1.2 safety surface.
 *
 *   POST   /messages/report     — report an abusive message
 *   POST   /users/:id/block     — block another user (silent, one-way)
 *   DELETE /users/:id/block     — unblock (idempotent)
 *   GET    /users/blocks        — list current user's blocks
 *
 * Auth: JwtAuthGuard only. These are *safety* endpoints — they MUST be
 * reachable by every authenticated user regardless of subscription / paywall
 * state. They are intentionally absent from PAID_ROUTES in
 * test/entitlement-guards-mounted.spec.ts.
 *
 * Rate-limit: the report endpoint is throttled at 20 reports per hour per
 * user via @nestjs/throttler's named "default" tracker. Block / unblock are
 * not throttled separately — they are cheap idempotent writes and the unique
 * constraint absorbs storms.
 */
@ApiTags('safety')
@ApiBearerAuth('bearer')
@ApiResponse({ status: 401, description: 'Missing or invalid bearer token.' })
@Controller()
@UseGuards(JwtAuthGuard)
export class MessagesSafetyController {
  constructor(private readonly safety: MessagesSafetyService) {}

  // ─── Reports ──────────────────────────────────────────────────────────────

  @ApiOperation({
    summary: 'Report a message',
    description:
      'File an abuse report against a specific CoachMessage the caller has access to. Idempotent: re-reporting the same message returns the existing reportId with status="already_reported". Rate-limited to 20 reports / hour / user.',
  })
  @ApiResponse({
    status: 201,
    description: 'Report received. { reportId, status }.',
  })
  @ApiResponse({ status: 400, description: 'CANNOT_REPORT_OWN_MESSAGE' })
  @ApiResponse({ status: 404, description: 'MESSAGE_NOT_FOUND' })
  @ApiResponse({ status: 429, description: 'Too many reports — try later.' })
  @Throttle({ default: { ttl: 3_600_000, limit: 20 } })
  @Post('messages/report')
  reportMessage(
    @Request() req: AuthedRequest,
    @Body() dto: ReportMessageDto,
  ): Promise<{ reportId: string; status: 'received' | 'already_reported' }> {
    return this.safety.reportMessage(req.user.id, dto);
  }

  // ─── Blocks ───────────────────────────────────────────────────────────────

  @ApiOperation({
    summary: 'Block a user',
    description:
      'Adds the target user to the caller\'s blocklist. Idempotent. The blocked user is never informed; messaging list, unread counts, and push fanout all suppress them server-side.',
  })
  @ApiResponse({
    status: 201,
    description: 'Block recorded. { blockId, blockedUserId }.',
  })
  @ApiResponse({ status: 400, description: 'CANNOT_BLOCK_SELF' })
  @ApiResponse({ status: 404, description: 'USER_NOT_FOUND' })
  @Post('users/:id/block')
  blockUser(
    @Request() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<{ blockId: string; blockedUserId: string }> {
    return this.safety.blockUser(req.user.id, id);
  }

  @ApiOperation({
    summary: 'Unblock a user',
    description:
      'Removes the target from the caller\'s blocklist. Idempotent — returns 200 even when no row existed.',
  })
  @ApiResponse({
    status: 200,
    description: 'Unblock recorded. { blockedUserId, unblocked: true }.',
  })
  @HttpCode(200)
  @Delete('users/:id/block')
  unblockUser(
    @Request() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<{ blockedUserId: string; unblocked: true }> {
    return this.safety.unblockUser(req.user.id, id);
  }

  @ApiOperation({
    summary: 'List blocked users',
    description:
      'Returns the caller\'s current blocklist for the mobile Settings → Blocked Users screen.',
  })
  @ApiResponse({
    status: 200,
    description: 'Array of { blockedId, displayName, blockedAt }.',
  })
  @Get('users/blocks')
  listBlocks(@Request() req: AuthedRequest): Promise<
    Array<{ blockedId: string; displayName: string; blockedAt: string }>
  > {
    return this.safety.listBlocks(req.user.id);
  }
}
