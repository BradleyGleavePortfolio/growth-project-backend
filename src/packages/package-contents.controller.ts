import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
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
}
