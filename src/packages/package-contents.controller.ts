import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachOrOwnerGuard } from '../common/guards/coach-or-owner.guard';
import { SubscriptionGuard } from '../billing/subscription.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { PackagesService } from './packages.service';
import { PackageContentsService } from './package-contents.service';
import {
  IDEMPOTENCY_KEY_UUID_RE,
  PackagePushService,
} from './package-push.service';
import {
  PushPreviewQuerySchema,
  PushRequestSchema,
} from './package-contents.dto';

// PR-8 — Coach package CONTENTS authoring endpoints.
//
// Mirrors the controller conventions of CoachPackagesController:
//   - same guards (JwtAuthGuard, CoachOrOwnerGuard, SubscriptionGuard)
//   - same role allow-list ('coach', 'owner')
//   - sub-coach scope via PackagesService.resolveEffectiveCoachId
//   - IDOR check via PackagesService.requireOwnedPackage (inside the
//     service methods)
//
// Body validation is intentionally NOT class-validator here: we accept
// the raw body as `unknown` and let the service parse it with zod. The
// global ValidationPipe with `forbidNonWhitelisted` would strip unknown
// keys silently before the controller ever sees them — and silently
// accepting an unknown cadence_payload key is precisely the failure
// mode the brief asks us to prevent. Using zod in the service gives us
// per-cadence-kind strictness with a clear 400.

@ApiTags('packages')
@Controller('v1/coach/packages/:id/contents')
@UseGuards(JwtAuthGuard, CoachOrOwnerGuard, SubscriptionGuard)
export class CoachPackageContentsController {
  constructor(
    private packages: PackagesService,
    private contents: PackageContentsService,
    private push: PackagePushService,
  ) {}

  @Roles('coach', 'owner')
  @Get()
  async list(@Request() req: AuthedRequest, @Param('id') packageId: string) {
    const coachId = await this.packages.resolveEffectiveCoachId(req.user.id);
    const rows = await this.contents.listForPackage(coachId, packageId);
    return { contents: rows };
  }

  // PR-18 B2 (#5) — pass BOTH the raw actor id AND the resolved tenant
  // (head) coach id into attach. resolveEffectiveCoachId promotes a
  // sub-coach → head; passing ONLY that promoted id (the pre-PR-18
  // behaviour) let a sub-coach attach a head-owned asset without proving
  // sub-coach scope. The service re-derives the actor's scope from
  // actorUserId via SubCoachScopeService and 404s on an out-of-scope
  // attach (no existence leak).
  @Roles('coach', 'owner')
  @Post()
  async attach(
    @Request() req: AuthedRequest,
    @Param('id') packageId: string,
    @Body() body: unknown,
  ) {
    const actorUserId = req.user.id;
    const tenantCoachId = await this.packages.resolveEffectiveCoachId(
      actorUserId,
    );
    return this.contents.attach(actorUserId, tenantCoachId, packageId, body);
  }

  // Bulk reorder — set display_order = index for each id in the payload.
  // Lives at /reorder so the static route is matched before :contentId.
  @Roles('coach', 'owner')
  @Put('reorder')
  @HttpCode(HttpStatus.OK)
  async reorder(
    @Request() req: AuthedRequest,
    @Param('id') packageId: string,
    @Body() body: unknown,
  ) {
    const coachId = await this.packages.resolveEffectiveCoachId(req.user.id);
    const rows = await this.contents.reorder(coachId, packageId, body);
    return { contents: rows };
  }

  @Roles('coach', 'owner')
  @Patch(':contentId')
  async patch(
    @Request() req: AuthedRequest,
    @Param('id') packageId: string,
    @Param('contentId') contentId: string,
    @Body() body: unknown,
  ) {
    const coachId = await this.packages.resolveEffectiveCoachId(req.user.id);
    return this.contents.patch(coachId, packageId, contentId, body);
  }

  // PR-17A — explicit, opt-in "push to existing" action. Default
  // behavior remains snapshot-at-purchase (only NEW purchases get the
  // edited content config). This endpoint additionally propagates the
  // edit to every CURRENT buyer's UNDELIVERED (status='pending') drops.
  // Same ownership + sub-coach scope as the other contents endpoints
  // (resolveEffectiveCoachId → requireOwnedPackage → 404 on cross-coach).
  // Body shape + per-cadence validation lives in
  // PackageContentsService.pushToExisting.
  @Roles('coach', 'owner')
  @Post(':contentId/push-to-existing')
  // Bulk mutation: a single call can issue up to DEFENSIVE_PUSH_CAP
  // (10k) per-row UPDATEs inside a locked transaction. An explicit, tight
  // bucket (10 calls / 60s per user) prevents a coach from chaining
  // back-to-back bulk pushes; the global authed default (300/min) is far
  // too loose for this cost profile.
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  async pushToExistingDrops(
    @Request() req: AuthedRequest,
    @Param('id') packageId: string,
    @Param('contentId') contentId: string,
    @Body() body: unknown,
  ) {
    const coachId = await this.packages.resolveEffectiveCoachId(req.user.id);
    return this.contents.pushToExisting(coachId, packageId, contentId, body);
  }

  // Soft-delete: sets removed_at. List excludes removed rows. PR-9's
  // snapshots already reference content rows by id so existing buyers'
  // ScheduledDrops are unaffected by the removal.
  @Roles('coach', 'owner')
  @Delete(':contentId')
  @HttpCode(HttpStatus.OK)
  async remove(
    @Request() req: AuthedRequest,
    @Param('id') packageId: string,
    @Param('contentId') contentId: string,
  ) {
    const coachId = await this.packages.resolveEffectiveCoachId(req.user.id);
    return this.contents.softDelete(coachId, packageId, contentId);
  }

  // ── PR-17 B2 — push / backfill endpoints (FROZEN contract, §2.1) ──────
  //
  // Both reuse this controller's guards + roles + the resolveEffectiveCoachId
  // + requireOwnedPackage IDOR pattern (the requireOwnedPackage check lives
  // inside PackagePushService, mirroring the authoring service above). Body
  // / query are parsed with zod in-controller so an invalid shape is a clean
  // 400 (the global ValidationPipe would otherwise strip unknown keys).

  // GET .../:contentId/push/preview?audience=&mode= — pure read, confirm
  // modal buyer count (#10). Returns { count, audience, already_delivered }.
  @Roles('coach', 'owner')
  @Get(':contentId/push/preview')
  async pushPreview(
    @Request() req: AuthedRequest,
    @Param('id') packageId: string,
    @Param('contentId') contentId: string,
    @Query() query: unknown,
  ) {
    const parsed = PushPreviewQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'INVALID_PUSH_PREVIEW_QUERY',
        message: parsed.error.issues.map((i) => i.message).join('; '),
      });
    }
    const coachId = await this.packages.resolveEffectiveCoachId(req.user.id);
    const res = await this.push.previewPush(coachId, packageId, contentId, {
      audience: parsed.data.audience,
      mode: parsed.data.mode,
      cohortPurchaseIds: parsed.data.cohort_purchase_ids,
    });
    return {
      count: res.count,
      audience: parsed.data.audience,
      already_delivered: res.already_delivered,
    };
  }

  // POST .../:contentId/push — schedule the push/backfill. REQUIRES a valid
  // UUID Idempotency-Key header (#8, R19): this is a mutation that can mint a
  // fresh delivery, so the key is enforced (validated + deduped) here and in
  // PackagePushService.claimAndRun. A missing/invalid key is a 400. Returns
  // { scheduled, skipped, fire_at, audience, notify }.
  @Roles('coach', 'owner')
  @Post(':contentId/push')
  async pushToExisting(
    @Request() req: AuthedRequest,
    @Param('id') packageId: string,
    @Param('contentId') contentId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    // (R2 P0) Require + validate the Idempotency-Key before doing any work.
    // A push is a mutation (R19) — reject a missing or non-UUID key with 400
    // so a client bug can't bypass request-level dedup.
    if (!idempotencyKey || !IDEMPOTENCY_KEY_UUID_RE.test(idempotencyKey)) {
      throw new BadRequestException({
        error: 'INVALID_IDEMPOTENCY_KEY',
        message:
          'A valid UUID Idempotency-Key header is required for the push endpoint',
      });
    }
    const parsed = PushRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'INVALID_PUSH_REQUEST',
        message: parsed.error.issues.map((i) => i.message).join('; '),
      });
    }
    const coachId = await this.packages.resolveEffectiveCoachId(req.user.id);
    const fireAt = new Date(parsed.data.fire_at);
    const res = await this.push.pushContentToExistingBuyers(
      coachId,
      packageId,
      contentId,
      {
        audience: parsed.data.audience,
        cohortPurchaseIds: parsed.data.cohort_purchase_ids,
        fireAt,
        mode: parsed.data.mode,
        notify: parsed.data.notify,
      },
      idempotencyKey,
    );
    return {
      scheduled: res.scheduled,
      skipped: res.skipped,
      fire_at: parsed.data.fire_at,
      audience: parsed.data.audience,
      notify: parsed.data.notify,
    };
  }
}
