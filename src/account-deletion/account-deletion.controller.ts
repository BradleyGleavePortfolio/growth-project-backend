import {
  Body,
  Controller,
  Get,
  HttpCode,
  Optional,
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

// ─────────────────────────────────────────────────────────────────────────────

/**
 * AccountDeletionController
 *
 * Provides the full GDPR right-to-erasure lifecycle for end users and admins.
 *
 * User-initiated flow (two-phase with 14-day grace):
 *   POST   /me/delete-account              → request deletion, sends email with token
 *   GET    /me/delete-account/confirm      → confirm via one-time link (?token=...)
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
    summary: 'Request account deletion',
    description:
      'Starts the two-phase GDPR right-to-erasure flow. Sends a single-use confirmation link to your registered email address. Calling again while a valid (unexpired) link exists is a no-op that returns the same expiry.',
  })
  @ApiResponse({
    status: 200,
    description: 'Confirmation email sent (or already pending).',
    schema: {
      example: {
        message: 'A confirmation link has been sent to your email. Click it within 24 hours to start the 14-day grace period.',
        expires_at: '2026-01-01T03:00:00.000Z',
      },
    },
  })
  @Post('me/delete-account')
  @HttpCode(200)
  requestDeletion(@Request() req: AuditableRequest & AuthedRequest) {
    return this.deletionService.requestDeletion(req.user.id, auditContext(req));
  }

  @ApiOperation({
    summary: 'Confirm deletion via one-time email token',
    description:
      'Validates the single-use token sent by POST /me/delete-account. On success the 14-day grace period starts. The token is invalidated after first use.',
  })
  @ApiQuery({ name: 'token', required: true, description: '64-char hex token from the confirmation email.' })
  @ApiResponse({
    status: 200,
    description: 'Deletion confirmed. Grace period started.',
    schema: {
      example: {
        message: 'Your account is scheduled for permanent deletion on January 15, 2026. You have 14 days to cancel.',
        purge_after: '2026-01-15T03:00:00.000Z',
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Invalid or expired token.' })
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
  const xff = Array.isArray(xffRaw) ? xffRaw[0] : xffRaw ?? '';
  const fwdIp = (xff as string).split(',')[0]?.trim();
  const ip = fwdIp || req?.ip || req?.socket?.remoteAddress || null;
  const uaRaw = req?.headers?.['user-agent'];
  const userAgent = Array.isArray(uaRaw) ? uaRaw[0] ?? null : (uaRaw as string | undefined) ?? null;
  return { ip: ip ?? null, userAgent: userAgent ?? null };
}
