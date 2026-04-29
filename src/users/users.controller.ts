import {
  Body,
  Controller,
  Delete,
  Get,
  GoneException,
  HttpCode,
  Param,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/auth.guard';
import type { AuditableRequest, AuthedRequest } from '../auth/auth-request';
import { UsersService } from './users.service';
import { PreferencesService } from './preferences.service';
import { AccountService } from './account.service';
import type { UserPreferencesDto } from './preferences.dto';
import { AllowDeletionScheduled } from '../common/decorators/allow-deletion-scheduled.decorator';

@ApiTags('users')
@ApiBearerAuth('bearer')
@ApiResponse({ status: 401, description: 'Missing or invalid bearer token.' })
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    private usersService: UsersService,
    private preferencesService: PreferencesService,
    private accountService: AccountService,
  ) {}

  @ApiOperation({
    summary: 'Get personalization preferences',
    description: 'Returns current preferences with defaults filled in.',
  })
  @ApiResponse({ status: 200, description: 'Preferences object.' })
  @Get('me/preferences')
  getPreferences(@Request() req: AuthedRequest) {
    return this.preferencesService.getPreferences(req.user.id);
  }

  @ApiOperation({
    summary: 'Patch personalization preferences',
    description: 'Merges a partial UserPreferencesDto into the stored prefs.',
  })
  @ApiResponse({ status: 200, description: 'Updated preferences object.' })
  @ApiResponse({ status: 400, description: 'Validation error.' })
  @Patch('me/preferences')
  patchPreferences(
    @Request() req: AuthedRequest,
    @Body() body: Partial<UserPreferencesDto>,
  ) {
    return this.preferencesService.patchPreferences(req.user.id, body);
  }

  /**
   * GET /users/me/badges — REMOVED (doctrine cleanup).
   * Returns 410 Gone for one mobile release window before being deleted.
   */
  // TODO: remove route entirely after one mobile release window.
  @ApiOperation({
    summary: 'Removed — returns 410 Gone',
    description: 'Badges are no longer part of the product surface.',
  })
  @ApiResponse({ status: 410, description: 'Endpoint removed.' })
  @Get('me/badges')
  @HttpCode(410)
  async getBadges() {
    throw new GoneException(
      'This endpoint has been removed. Badges are no longer part of the product surface.',
    );
  }

  @ApiOperation({
    summary: 'Founding-member rank',
    description: 'Returns 1-indexed join rank, total user count, and whether the user is a Founding Member (rank ≤ 1000).',
  })
  @ApiResponse({ status: 200, description: 'Founding-member info.' })
  @Get('me/founding-number')
  getFoundingNumber(@Request() req: AuthedRequest) {
    return this.usersService.getFoundingNumber(req.user.id);
  }

  @ApiOperation({
    summary: 'Stats for the caller’s circle',
    description: 'How many users in the caller’s coach→student group trained today, plus group size.',
  })
  @ApiResponse({ status: 200, description: 'Circle stats.' })
  @Get('me/circle-stats')
  getCircleStats(@Request() req: AuthedRequest) {
    return this.usersService.getCircleStats(req.user.id);
  }

  @ApiOperation({
    summary: 'Request a GDPR/CCPA personal-data export',
    description:
      'Synchronously assembles the snapshot, persists a DataExportRequest row, ' +
      'and returns a handle. Fetch the payload at GET /users/me/data-export/:id.',
  })
  @ApiResponse({ status: 201, description: 'Export request handle.' })
  @Post('me/data-export')
  requestDataExport(@Request() req: AuthedRequest) {
    return this.accountService.requestDataExport(
      req.user.id,
      auditContext(req),
    );
  }

  @ApiOperation({ summary: 'Fetch a previously requested data export by id' })
  @ApiResponse({ status: 200, description: 'Data export payload.' })
  @ApiResponse({ status: 404, description: 'Export not found or not owned by caller.' })
  @Get('me/data-export/:id')
  getDataExport(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.accountService.getDataExport(req.user.id, id);
  }

  @ApiOperation({
    summary: 'Schedule account deletion (30-day grace period)',
    description:
      'Idempotent — a second call within the grace window returns the same scheduled_at. ' +
      'Use POST /users/me/account/cancel-deletion to undo.',
  })
  @ApiResponse({ status: 200, description: 'Deletion scheduled (or already scheduled).' })
  @Delete('me/account')
  deleteAccount(@Request() req: AuthedRequest) {
    return this.accountService.scheduleDeletion(
      req.user.id,
      auditContext(req),
    );
  }

  @ApiOperation({ summary: 'Cancel a scheduled account deletion' })
  @ApiResponse({ status: 200, description: 'Deletion canceled.' })
  @ApiResponse({ status: 404, description: 'No deletion scheduled.' })
  @Post('me/account/cancel-deletion')
  @AllowDeletionScheduled()
  cancelDeletion(@Request() req: AuthedRequest) {
    return this.accountService.cancelDeletion(
      req.user.id,
      auditContext(req),
    );
  }

  @ApiOperation({ summary: 'Get deletion status (canonical path)' })
  @ApiResponse({ status: 200, description: 'Deletion status.' })
  @Get('me/account/deletion-status')
  @AllowDeletionScheduled()
  deletionStatus(@Request() req: AuthedRequest) {
    return this.accountService.getDeletionStatus(req.user.id);
  }

  @ApiOperation({
    summary: 'Get deletion status (mobile-friendly alias)',
    description: 'Same body as GET /users/me/account/deletion-status.',
  })
  @ApiResponse({ status: 200, description: 'Deletion status.' })
  @Get('me/account/status')
  @AllowDeletionScheduled()
  accountStatus(@Request() req: AuthedRequest) {
    return this.accountService.getDeletionStatus(req.user.id);
  }
}

// Best-effort extraction of remote IP + User-Agent. Mirrors the helper in
// admin.controller.ts; kept inline here to avoid an extra util module for
// two callers.
function auditContext(req: AuditableRequest): { ip: string | null; userAgent: string | null } {
  const xffRaw = req?.headers?.['x-forwarded-for'];
  const xff = Array.isArray(xffRaw) ? xffRaw[0] : xffRaw || '';
  const fwdIp = xff.split(',')[0]?.trim();
  const ip = fwdIp || req?.ip || req?.socket?.remoteAddress || null;
  const uaRaw = req?.headers?.['user-agent'];
  const userAgent = Array.isArray(uaRaw) ? uaRaw[0] ?? null : uaRaw ?? null;
  return { ip: ip || null, userAgent: userAgent || null };
}
