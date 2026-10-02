import {
  Body,
  ConflictException,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuditableRequest, AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { SkipClientEntitlement } from '../common/decorators/skip-client-entitlement.decorator';
import {
  InviteCodeParamDto,
  PackageIdParamDto,
  RevokeGrantDto,
  SetInviteCodeBindingDto,
} from './invite-grant.dto';
import { InviteGrantService, type GrantOutcome } from './invite-grant.service';

/** A refused re-claim of a revoked grant is a 409, not a 200 with a status flag (Grok C2). */
function grantResponse(outcome: GrantOutcome) {
  if (outcome.status === 'revoked_not_regranted') {
    throw new ConflictException({
      error: 'GRANT_REVOKED',
      message: 'This grant was revoked by your coach; ask them to restore it',
      ...outcome,
    });
  }
  // `pending_consent` is a 200 with active:false + recovery (the client ticks
  // the in-app agreement and the grant activates automatically).
  return { active: outcome.status === 'created' || outcome.status === 'already_active', ...outcome };
}

function auditContext(req: AuditableRequest): { ip: string | null; userAgent: string | null } {
  const xffRaw = req?.headers?.['x-forwarded-for'];
  const xff = Array.isArray(xffRaw) ? xffRaw[0] : xffRaw || '';
  const fwdIp = xff.split(',')[0]?.trim();
  const ip = fwdIp || req?.ip || req?.socket?.remoteAddress || null;
  const uaRaw = req?.headers?.['user-agent'];
  const userAgent = Array.isArray(uaRaw) ? (uaRaw[0] ?? null) : (uaRaw ?? null);
  return { ip: ip || null, userAgent: userAgent || null };
}

// Clinic launch C01 — API surface for invite-code → package grants.
// Mobile/web UI comes later; these three routes are what it will call.
@ApiTags('entitlement-grants')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard)
export class InviteGrantController {
  constructor(private readonly grants: InviteGrantService) {}

  @ApiOperation({
    summary: 'Bind (or clear) a package grant on an invite code',
    description:
      'Coach binds one of their invite codes — a per-row code or the permanent coach link code — to one of ' +
      'their packages. grant_mode "free" or "prepaid" makes a successful attach via that code create a $0 ' +
      'entitlement for the package; "none" (or package_id null) clears the binding. Owner may act on any code.',
  })
  @ApiResponse({ status: 200, description: 'Current binding.' })
  @ApiResponse({ status: 404, description: 'Code or package not found / not yours.' })
  @Roles('coach', 'owner')
  @Put('v1/invite-codes/:code/package-binding')
  @HttpCode(HttpStatus.OK)
  async setBinding(
    @Request() req: AuthedRequest,
    @Param() params: InviteCodeParamDto,
    @Body() body: SetInviteCodeBindingDto,
  ) {
    const binding = await this.grants.setBinding(
      { id: req.user.id, role: req.user.role, email: req.user.email },
      {
        code: params.code.trim().toUpperCase(),
        package_id: body.package_id,
        grant_mode: body.grant_mode,
      },
      auditContext(req),
    );
    return {
      code: binding.code,
      code_kind: binding.kind,
      package_id: binding.package_id,
      grant_mode: binding.grant_mode,
      join_link: `/join/${binding.code}`,
    };
  }

  @ApiOperation({
    summary: 'Claim a $0 package (no Stripe)',
    description:
      'A client of the package’s coach claims a package priced at $0. Creates the same entitlement record a ' +
      'purchase would (amount 0, source free_package_claim). Idempotent. Non-free packages return 400 ' +
      'PACKAGE_NOT_FREE and must go through checkout.',
  })
  @ApiResponse({ status: 200, description: 'Grant created or already active.' })
  @ApiResponse({ status: 400, description: 'Package is not free.' })
  @ApiResponse({ status: 404, description: 'Package not available to this client.' })
  @Roles('student')
  @SkipClientEntitlement()
  @Post('v1/packages/:id/claim-free')
  @HttpCode(HttpStatus.OK)
  async claimFree(@Request() req: AuthedRequest, @Param() params: PackageIdParamDto) {
    const outcome = await this.grants.claimFreePackage(
      { id: req.user.id, role: req.user.role, coach_id: req.user.coach_id ?? null },
      params.id,
    );
    return grantResponse(outcome);
  }

  @ApiOperation({
    summary: 'Claim the package a bound invite code carries (existing client)',
    description:
      'A client who is ALREADY attached to the code’s coach claims the grant the code is bound to — the web ' +
      '/join page for existing clients, or a retry after signing the platform waiver. Same idempotent record ' +
      'as the attach path. Runs the same contract gate as checkout (409 CONTRACT_SIGNATURE_REQUIRED).',
  })
  @ApiResponse({ status: 200, description: 'Grant created or already active.' })
  @ApiResponse({ status: 400, description: 'Code carries no package.' })
  @ApiResponse({ status: 404, description: 'Code is not your coach’s.' })
  @ApiResponse({ status: 409, description: 'Contract signature required, or grant was revoked.' })
  @Roles('student')
  @SkipClientEntitlement()
  @Post('v1/invite-codes/:code/claim-grant')
  @HttpCode(HttpStatus.OK)
  async claimGrant(@Request() req: AuthedRequest, @Param() params: InviteCodeParamDto) {
    const outcome = await this.grants.claimGrantForCode(
      { id: req.user.id, role: req.user.role, coach_id: req.user.coach_id ?? null },
      params.code,
    );
    return grantResponse(outcome);
  }

  @ApiOperation({
    summary: 'Revoke $0 grants for a client (audited)',
    description:
      'Coach revokes grants for a client on their roster (owner: any client). Only grant rows are affected; ' +
      'Stripe purchases are never touched. Idempotent.',
  })
  @ApiResponse({ status: 200, description: '{ revoked: n, purchase_ids }' })
  @ApiResponse({ status: 404, description: 'Client not on your roster.' })
  @Roles('coach', 'owner')
  @Post('v1/entitlements/grants/revoke')
  @HttpCode(HttpStatus.OK)
  async revoke(@Request() req: AuthedRequest, @Body() body: RevokeGrantDto) {
    return this.grants.revoke(
      { id: req.user.id, role: req.user.role, email: req.user.email },
      body,
      auditContext(req),
    );
  }
}
