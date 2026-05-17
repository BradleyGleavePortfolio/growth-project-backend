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
import { SubscriptionGuard } from '../billing/subscription.guard';
import { SkipClientEntitlement } from '../common/decorators/skip-client-entitlement.decorator';
import { PrismaService } from '../prisma.service';
import {
  CreatePackageInput,
  PackagesService,
  UpdatePackageInput,
} from './packages.service';
import { CreatePackageDto, UpdatePackageDto } from './packages.dto';

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
@UseGuards(JwtAuthGuard, CoachOrOwnerGuard, SubscriptionGuard)
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
  async create(@Request() req: AuthedRequest, @Body() body: CreatePackageDto) {
    return this.packages.create(req.user.id, {
      name: body.name,
      description: body.description,
      amount_cents: body.amount_cents,
      currency: body.currency,
      billing_type: body.billing_type as 'one_time' | 'recurring',
      interval: body.billing_interval as 'month' | 'year' | null | undefined,
      interval_count: body.billing_interval_count,
    });
  }

  @Patch(':id')
  async update(
    @Request() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: UpdatePackageDto,
  ) {
    return this.packages.update(req.user.id, id, {
      name: body.name,
      description: body.description,
      amount_cents: body.amount_cents,
      currency: body.currency,
      is_active: body.is_active,
    });
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
  constructor(
    private packages: PackagesService,
    private prisma: PrismaService,
  ) {}

  // GET /v1/clients/me/coach — returns the current client's coach profile.
  // Used by CoachIntroductionBanner on the client HomeScreen to display
  // the coach's name and avatar on day one.
  // 404 when the client has no coach assigned (expected — banner shows
  // the "waiting for coach" state instead).
  @Get()
  async coachProfile(@Request() req: AuthedRequest) {
    const coachId = req.user.coach_id;
    if (!coachId) {
      throw new NotFoundException({
        error: 'COACH_NOT_ASSIGNED',
        message: 'No coach assigned to this client',
      });
    }
    const coach = await this.prisma.user.findUnique({
      where: { id: coachId },
      select: {
        id: true,
        name: true,
        profile: { select: { avatar_url: true } },
      },
    });
    if (!coach) {
      throw new NotFoundException({
        error: 'COACH_NOT_FOUND',
        message: 'Assigned coach not found',
      });
    }
    return {
      id: coach.id,
      name: coach.name ?? 'Your coach',
      avatar_url: coach.profile?.avatar_url ?? null,
    };
  }

  @Get('packages')
  @SkipClientEntitlement()
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
  @SkipClientEntitlement()
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
