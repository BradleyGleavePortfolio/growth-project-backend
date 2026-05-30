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

  @Roles('coach', 'owner')
  @Post()
  async attach(
    @Request() req: AuthedRequest,
    @Param('id') packageId: string,
    @Body() body: unknown,
  ) {
    const coachId = await this.packages.resolveEffectiveCoachId(req.user.id);
    return this.contents.attach(coachId, packageId, body);
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
