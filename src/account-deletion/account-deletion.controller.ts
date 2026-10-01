import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/auth.guard';
import { RecentAuthGuard } from '../auth/recent-auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AllowDeletionScheduled } from '../common/decorators/allow-deletion-scheduled.decorator';
import type { AuthedRequest, AuditableRequest } from '../auth/auth-request';
import { AccountDeletionService } from './account-deletion.service';
import { IsOptional, IsString, MaxLength } from 'class-validator';

// DTOs ────────────────────────────────────────────────────────────────────────

export class AdminForceDeleteDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/**
 * Body for POST /me/delete-account. Optional: Sign in with Apple users send
 * the authorization code from the Apple re-authentication they just did, so
 * the server can revoke the app's Apple tokens (Apple deletion guidance).
 */
export class RequestDeletionDto {
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  apple_authorization_code?: string;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * AccountDeletionController
 *
 * Provides the full GDPR right-to-erasure lifecycle for end users and admins.
 *
 * User-initiated flow (in-app, 14-day grace):
 *   POST /auth/recent-auth-token           → fresh re-auth (password or Apple/Google)
 *   POST   /me/delete-account              → X-Recent-Auth-Token required; deletion
 *                                            is scheduled immediately (grace starts)
 *   GET    /me/delete-account/confirm      → legacy one-time email link (?token=...)
 *   POST   /me/delete-account/cancel       → cancel during grace period
 *   GET    /me/delete-account/status       → machine-readable state
 *
 * Admin-initiated (OWNER role only, audited):
 *   POST   /admin/users/:id/delete         → immediate hard-delete, no grace period
 */
@ApiTags('account-deletion')
@ApiBearerAuth('bearer')
@ApiResponse({ status: 401, description: 'Missing or invalid bearer token.' })
@Controller()
@UseGuards(JwtAuthGuard)
export class AccountDeletionController {
  constructor(private readonly deletionService: AccountDeletionService) {}

  // ── User endpoints ────────────────────────────────────────────────────────

  @ApiOperation({
    summary: 'Request account deletion (schedules it immediately)',
    description:
      'Requires X-Recent-Auth-Token from POST /auth/recent-auth-token (fresh password or Sign in with Apple/Google). The deletion is scheduled immediately: the grace period (DELETION_GRACE_DAYS, default 14) starts now and the account can be cancelled from the app until purge_after. Idempotent: calling again returns the existing schedule. Apple users may send apple_authorization_code so the server revokes Sign in with Apple tokens.',
  })
  @ApiResponse({
    status: 200,
    description: 'Deletion scheduled (or already scheduled).',
    schema: {
      example: {
        state: 'confirmed',
        already_scheduled: false,
        message:
          'Your account and its data will be permanently deleted after January 15, 2026. You can cancel before then from Settings.',
        requested_at: '2026-01-01T03:00:00.000Z',
        confirmed_at: '2026-01-01T03:00:00.000Z',
        grace_days: 14,
        purge_after: '2026-01-15T03:00:00.000Z',
        cancellable: true,
        apple_revocation: 'not_requested',
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Missing, expired or invalid X-Recent-Auth-Token.' })
  // C5 PR-A audit: GDPR right-to-erasure entrypoint. Any logged-in user must be
  // able to initiate deletion of their own account, regardless of role. Scoped
  // by req.user.id below — a user cannot start another user's deletion.
  // RecentAuthGuard: the fresh, single-use re-auth token is the confirmation
  // factor for this destructive step (Apple 5.1.1(v): deletion must complete
  // in the app, so there is no email round-trip).
  // B-608-7: no @Roles. Every authenticated account (student, coach,
  // sub_coach, owner) may delete itself; JwtAuthGuard authenticates and the
  // service scopes by req.user.id.
  @UseGuards(RecentAuthGuard)
  @Post('me/delete-account')
  @HttpCode(200)
  requestDeletion(
    @Request() req: AuditableRequest & AuthedRequest,
    @Body() body: RequestDeletionDto,
  ) {
    return this.deletionService.requestDeletion(req.user.id, {
      ...auditContext(req),
      appleAuthorizationCode: body?.apple_authorization_code ?? null,
    });
  }

  @ApiOperation({
    summary: 'Confirm deletion via one-time email token',
    description:
      'Validates the single-use token sent by POST /me/delete-account. On success the 14-day grace period starts. The token is invalidated after first use.',
  })
  @ApiQuery({
    name: 'token',
    required: true,
    description: '64-char hex token from the confirmation email.',
  })
  @ApiResponse({
    status: 200,
    description: 'Deletion confirmed. Grace period started.',
    schema: {
      example: {
        message:
          'Your account is scheduled for permanent deletion on January 15, 2026. You have 14 days to cancel.',
        purge_after: '2026-01-15T03:00:00.000Z',
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Invalid or expired token.' })
  // C5 PR-A audit: token-bound confirmation of the deletion request. The
  // one-time email token is the authorising secret; the JWT identity merely
  // gates the endpoint surface so anonymous traffic is rejected before the
  // token check runs. Any logged-in user (student/coach/owner) may confirm
  // their own deletion.
  //
  // confirmDeletion intentionally does NOT carry RecentAuthGuard. The
  // single-use email-token link IS the out-of-band re-auth factor for
  // the destructive step — a CPO Doctrine §4-equivalent strong factor.
  // Adding RecentAuthGuard here would require the user to be freshly
  // logged in in the same browser that opens the email link, which is
  // architecturally hostile to the email-flow UX. Top-tier IAM designs
  // (Google account-deletion, AWS root credential flows) require one
  // strong OOB factor, not both. This decision is intentional.
  // Self-scoped, any authenticated role (B-608-7).
  @Get('me/delete-account/confirm')
  @AllowDeletionScheduled()
  confirmDeletion(@Query('token') token: string) {
    return this.deletionService.confirmDeletion(token);
  }

  @ApiOperation({
    summary: 'Cancel a pending deletion request',
    description:
      'Cancels a deletion that is in REQUESTED or CONFIRMED state, provided the 14-day grace period has not yet expired.',
  })
  @ApiResponse({ status: 200, description: 'Deletion cancelled.' })
  @ApiResponse({ status: 400, description: 'No pending deletion or grace period expired.' })
  // C5 PR-A audit: reversal of a pending deletion. Scoped by req.user.id —
  // a user can only cancel their own pending deletion. Any logged-in role.
  // Self-scoped, any authenticated role (B-608-7).
  @Post('me/delete-account/cancel')
  @HttpCode(200)
  @AllowDeletionScheduled()
  cancelDeletion(@Request() req: AuditableRequest & AuthedRequest) {
    return this.deletionService.cancelDeletion(req.user.id, auditContext(req));
  }

  @ApiOperation({
    summary: 'Get deletion status',
    description: 'Returns current deletion state: none | requested | confirmed | deleted.',
  })
  @ApiResponse({
    status: 200,
    description: 'Deletion status object.',
    schema: {
      example: {
        state: 'confirmed',
        confirmed_at: '2026-01-01T03:00:00.000Z',
        grace_days: 14,
        purge_after: '2026-01-15T03:00:00.000Z',
      },
    },
  })
  // C5 PR-A audit: read-only status of the caller's own deletion lifecycle.
  // Scoped by req.user.id. Any logged-in role.
  // Self-scoped, any authenticated role (B-608-7).
  @Get('me/delete-account/status')
  @AllowDeletionScheduled()
  getStatus(@Request() req: AuthedRequest) {
    return this.deletionService.getDeletionStatus(req.user.id);
  }

  // ── Admin endpoint ────────────────────────────────────────────────────────

  @ApiOperation({
    summary: 'Admin: force-delete a user account (OWNER only)',
    description:
      'Immediately scrubs PII and marks the account deleted. Bypasses the confirmation email and 14-day grace period. Every call is written to both deletion_audit and AuditLog. Returns 200 if already deleted (idempotent).',
  })
  @ApiParam({ name: 'id', description: 'Target user UUID.' })
  @ApiResponse({ status: 200, description: 'User deleted (or already deleted).' })
  @ApiResponse({ status: 403, description: 'Not authorized — OWNER role required.' })
  @ApiResponse({ status: 404, description: 'User not found.' })
  @Post('admin/users/:id/delete')
  @HttpCode(200)
  @Roles('owner')
  @UseGuards(RolesGuard)
  adminForceDelete(
    @Request() req: AuditableRequest & AuthedRequest,
    @Param('id') targetId: string,
    @Body() body: AdminForceDeleteDto,
  ) {
    const ctx = auditContext(req);
    return this.deletionService.adminForceDelete(targetId, {
      actorId: req.user.id,
      actorRole: req.user.role,
      actorEmail: req.user.email ?? null,
      reason: body.reason,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function auditContext(req: AuditableRequest): { ip: string | null; userAgent: string | null } {
  const xffRaw = req?.headers?.['x-forwarded-for'];
  const xff = Array.isArray(xffRaw) ? xffRaw[0] : (xffRaw ?? '');
  const fwdIp = (xff as string).split(',')[0]?.trim();
  const ip = fwdIp || req?.ip || req?.socket?.remoteAddress || null;
  const uaRaw = req?.headers?.['user-agent'];
  const userAgent = Array.isArray(uaRaw)
    ? (uaRaw[0] ?? null)
    : ((uaRaw as string | undefined) ?? null);
  return { ip: ip ?? null, userAgent: userAgent ?? null };
}
