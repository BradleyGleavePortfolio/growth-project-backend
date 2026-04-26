import {
  Controller,
  Delete,
  Get,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth-request';
import { UsersService } from './users.service';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private usersService: UsersService) {}

  /**
   * GET /users/me/founding-number
   * Returns the user's 1-indexed join rank, total user count,
   * and whether they are a "Founding Member" (rank ≤ 1000).
   */
  @Get('me/founding-number')
  getFoundingNumber(@Request() req: AuthedRequest) {
    return this.usersService.getFoundingNumber(req.user.id);
  }

  /**
   * GET /users/me/circle-stats
   * Returns how many users in the caller's "circle" (coach→student group,
   * or global if no relationship) trained today, plus the total member count.
   */
  @Get('me/circle-stats')
  getCircleStats(@Request() req: AuthedRequest) {
    return this.usersService.getCircleStats(req.user.id);
  }

  /**
   * POST /users/me/data-export
   *
   * Kicks off a GDPR/CCPA-style personal data export.  Currently a stub
   * that acknowledges the request — a background job / email pipeline should
   * be wired here when the export feature is fully built.
   *
   * TODO: enqueue an async job that packages the user's data and emails it
   *       within the 24-hour SLA window stated in the response.
   */
  @Post('me/data-export')
  requestDataExport(@Request() req: AuthedRequest) {
    void req.user.id; // Will be used once real export job is wired
    return {
      requested: true,
      eta: 'within 24h',
      note: 'Stub — async export job not yet wired. Wire to a queue + email step.',
    };
  }

  /**
   * DELETE /users/me/account
   *
   * Initiates a soft-delete / grace-period account deletion.
   * Currently a stub — production implementation should:
   *   1. Mark the account as `deletionScheduledAt = now + 30 days`
   *   2. Revoke all active sessions
   *   3. Send a confirmation email with a cancellation link
   *
   * TODO: check for existing soft-delete field on User model; if absent,
   *       add a migration adding `deletion_scheduled_at DateTime?`.
   */
  @Delete('me/account')
  deleteAccount(@Request() req: AuthedRequest) {
    void req.user.id; // Will be used once real soft-delete is wired
    return {
      scheduled: true,
      gracePeriodDays: 30,
      note: 'Stub — soft-delete not yet wired to DB. Add deletion_scheduled_at field and session revocation.',
    };
  }
}
