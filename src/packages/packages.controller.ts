import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachOrOwnerGuard } from '../common/guards/coach-or-owner.guard';
import {
  CreatePackageInput,
  PackagesService,
  UpdatePackageInput,
} from './packages.service';

// Coach-facing CRUD for offers / packages. Coach owns their catalog and
// can list / create / update / archive their own rows. OWNER (platform
// admin) is allowed for support but is not currently scoped to a coach
// (the request must include coach_id in the path/query for owner reads).
//
// Public client-facing reads live in PublicPackagesController below — a
// client can list a coach's active offers without being authed as that
// coach.

@ApiTags('packages')
@Controller('v1/coach/packages')
@UseGuards(JwtAuthGuard, CoachOrOwnerGuard)
export class CoachPackagesController {
  constructor(private packages: PackagesService) {}

  @Get()
  async list(
    @Request() req: AuthedRequest,
    @Query('include_archived') includeArchived?: string,
  ) {
    const rows = await this.packages.listForCoach(req.user.id, {
      includeArchived: includeArchived === 'true' || includeArchived === '1',
    });
    return { packages: rows };
  }

  @Post()
  async create(@Request() req: AuthedRequest, @Body() body: CreatePackageInput) {
    return this.packages.create(req.user.id, body);
  }

  @Patch(':id')
  async update(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: UpdatePackageInput,
  ) {
    return this.packages.update(req.user.id, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async archive(@Request() req: AuthedRequest, @Param('id') id: string) {
    return this.packages.archive(req.user.id, id);
  }
}

// Client-side: GET /v1/clients/me/coach/packages — lists the active
// packages the *current* client's coach has on offer. Authed as a client
// (or any user with a coach assignment). No CoachOrOwnerGuard.
@ApiTags('packages')
@Controller('v1/clients/me/coach')
@UseGuards(JwtAuthGuard)
export class ClientPackagesController {
  constructor(private packages: PackagesService) {}

  @Get('packages')
  async list(@Request() req: AuthedRequest) {
    const coachId = req.user.coach_id;
    if (!coachId) {
      // Returning an empty list rather than 404 — the mobile app expects
      // a list and renders "no offers yet" when empty.
      return { packages: [] };
    }
    const rows = await this.packages.listPublicForCoach(coachId);
    return { packages: rows };
  }

  @Get('packages/:id')
  async detail(@Request() req: AuthedRequest, @Param('id') id: string) {
    const coachId = req.user.coach_id;
    const row = await this.packages.getById(id);
    if (!row || row.coach_id !== coachId || !row.is_active || row.archived_at) {
      throw new NotFoundException({
        error: 'PACKAGE_NOT_FOUND',
        message: 'Package not available',
      });
    }
    return row;
  }
}
