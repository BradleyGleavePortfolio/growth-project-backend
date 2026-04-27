import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth-request';
import { UsersService } from './users.service';
import { PreferencesService } from './preferences.service';
import { AccountService } from './account.service';
import type { UserPreferencesDto } from './preferences.dto';
import { BadgesService } from '../community/badges.service';
import { AllowDeletionScheduled } from '../common/decorators/allow-deletion-scheduled.decorator';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    private usersService: UsersService,
    private preferencesService: PreferencesService,
    private accountService: AccountService,
    private badgesService: BadgesService,
  ) {}

  /**
   * GET /users/me/preferences
   * Returns current personalization preferences (with defaults filled in).
   */
  @Get('me/preferences')
  getPreferences(@Request() req: AuthedRequest) {
    return this.preferencesService.getPreferences(req.user.id);
  }

  /**
   * PATCH /users/me/preferences
   * Accepts a partial UserPreferencesDto body and merges it into the stored prefs.
   */
  @Patch('me/preferences')
  patchPreferences(
    @Request() req: AuthedRequest,
    @Body() body: Partial<UserPreferencesDto>,
  ) {
    return this.preferencesService.patchPreferences(req.user.id, body);
  }

  /**
   * GET /users/me/badges
   * Returns all badges (earned + locked) for the current user.
   * Earned badges include awardedAt; locked badges have awardedAt = null.
   */
  @Get('me/badges')
  getBadges(@Request() req: AuthedRequest) {
    return this.badgesService.getBadgesForUser(req.user.id);
  }

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
   * GDPR/CCPA personal-data export. Synchronously assembles the user's
   * personal data into a JSON snapshot, persists it to DataExportRequest,
   * and returns a handle the client can poll. The payload itself is
   * available via GET /users/me/data-export/:id.
   */
  @Post('me/data-export')
  requestDataExport(@Request() req: AuthedRequest) {
    return this.accountService.requestDataExport(
      req.user.id,
      auditContext(req as any),
    );
  }

  @Get('me/data-export/:id')
  getDataExport(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.accountService.getDataExport(req.user.id, id);
  }

  /**
   * DELETE /users/me/account
   *
   * Schedules a soft-delete with a 30-day grace period. Idempotent — a
   * second call within the grace window returns the same scheduled_at.
   * Use POST /users/me/account/cancel-deletion to undo.
   *
   * Hard delete (PII scrub) runs out-of-band after the grace window
   * expires; that worker is intentionally out of scope for this PR — see
   * docs/audit-and-gdpr.md for the operator runbook.
   */
  @Delete('me/account')
  deleteAccount(@Request() req: AuthedRequest) {
    return this.accountService.scheduleDeletion(
      req.user.id,
      auditContext(req as any),
    );
  }

  @Post('me/account/cancel-deletion')
  @AllowDeletionScheduled()
  cancelDeletion(@Request() req: AuthedRequest) {
    return this.accountService.cancelDeletion(
      req.user.id,
      auditContext(req as any),
    );
  }

  @Get('me/account/deletion-status')
  @AllowDeletionScheduled()
  deletionStatus(@Request() req: AuthedRequest) {
    return this.accountService.getDeletionStatus(req.user.id);
  }
}

// Best-effort extraction of remote IP + User-Agent. Mirrors the helper in
// admin.controller.ts; kept inline here to avoid an extra util module for
// two callers.
function auditContext(req: any): { ip: string | null; userAgent: string | null } {
  const xff = (req?.headers?.['x-forwarded-for'] || '') as string;
  const fwdIp = xff.split(',')[0]?.trim();
  const ip = fwdIp || req?.ip || req?.socket?.remoteAddress || null;
  const userAgent = (req?.headers?.['user-agent'] || null) as string | null;
  return { ip: ip || null, userAgent: userAgent || null };
}
