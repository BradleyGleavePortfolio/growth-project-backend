import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
  NotFoundException,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { SubCoachAssignmentService } from './sub-coach-assignment.service';
import { SubCoachAnalyticsService } from './sub-coach-analytics.service';
import { SubCoachCapacityService } from './sub-coach-capacity.service';
import { SubCoachReassignService } from './sub-coach-reassign.service';
import { PrismaService } from '../prisma.service';
import {
  AssignClientDto,
  ListSubCoachesQueryDto,
  ReassignClientDto,
} from './dto/sub-coach.dto';

/**
 * SubCoachController
 *
 * Head-coach–facing endpoints for managing the sub-coach roster:
 *   GET  /sub-coaches                        — list sub-coaches with capacity + score
 *   GET  /sub-coaches/:id                    — single sub-coach detail
 *   POST /sub-coaches/:id/assign-client      — assign client to sub-coach
 *   POST /sub-coaches/:id/reassign-client    — atomically move a client
 *   GET  /sub-coaches/:id/analytics          — engagement score + breakdown
 *
 * All routes require JwtAuthGuard + CoachGuard (coach or owner role).
 * Mutations require a client-generated UUID `idempotency_key` (R19).
 */
@ApiTags('sub-coaches')
@Controller('sub-coaches')
@UseGuards(JwtAuthGuard, CoachGuard)
export class SubCoachController {
  constructor(
    private readonly assignment: SubCoachAssignmentService,
    private readonly analytics: SubCoachAnalyticsService,
    private readonly capacity: SubCoachCapacityService,
    private readonly reassign: SubCoachReassignService,
    private readonly prisma: PrismaService,
  ) {}

  // ── GET /sub-coaches ────────────────────────────────────────────────────────
  // Lists the requesting head coach's roster. Prisma filter (coach_id =
  // headCoachId) scopes to the caller; a sub-coach calling this returns
  // an empty page. Students have no roster and must not enumerate.
  // OWNER included for platform admin reads.
  @Roles('coach', 'owner')
  @Get()
  @ApiOperation({ summary: 'List sub-coaches belonging to the calling head coach (paginated)' })
  @ApiResponse({ status: 200 })
  async listSubCoaches(
    @Request() req: AuthedRequest,
    @Query() query: ListSubCoachesQueryDto,
  ) {
    const headCoachId = req.user.id;
    const limit = Math.min(query.limit ?? 20, 50);

    const subCoaches = await this.prisma.user.findMany({
      where: { coach_id: headCoachId, role: 'coach', deleted_at: null },
      select: {
        id: true,
        name: true,
        email: true,
        created_at: true,
        coach_profile: {
          select: { plan_tier: true, business_name: true },
        },
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
      ...(query.cursor
        ? { cursor: { id: query.cursor }, skip: 1 }
        : {}),
    });

    const hasMore = subCoaches.length > limit;
    const page = hasMore ? subCoaches.slice(0, limit) : subCoaches;
    const nextCursor = hasMore ? page[page.length - 1].id : null;

    const results = await Promise.all(
      page.map(async (sc) => {
        const [cap, score] = await Promise.all([
          this.capacity.getCapacity(headCoachId, sc.id),
          this.analytics.getEngagementScore(headCoachId, sc.id),
        ]);
        return { ...sc, capacity: cap, engagement: score };
      }),
    );

    return {
      items: results,
      nextCursor,
      hasMore,
    };
  }

  // ── GET /sub-coaches/:id ────────────────────────────────────────────────────
  // Detail view. Prisma `findFirst` is scoped to (id = subCoachId,
  // coach_id = headCoachId) so a peer sub-coach (or any non-owning
  // coach) gets 404. Students must not resolve sub-coach UUIDs.
  @Roles('coach', 'owner')
  @Get(':id')
  @ApiOperation({ summary: 'Get a single sub-coach including client list and capacity' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404 })
  async getSubCoach(
    @Request() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) subCoachId: string,
  ) {
    const headCoachId = req.user.id;

    const subCoach = await this.prisma.user.findFirst({
      where: { id: subCoachId, coach_id: headCoachId, role: 'coach', deleted_at: null },
      select: {
        id: true,
        name: true,
        email: true,
        created_at: true,
        coach_profile: {
          select: { plan_tier: true, business_name: true, bio: true },
        },
      },
    });

    if (!subCoach) {
      throw new NotFoundException('Sub-coach not found');
    }

    const [clients, cap, score] = await Promise.all([
      this.assignment.getAssignedClients(headCoachId, subCoachId),
      this.capacity.getCapacity(headCoachId, subCoachId),
      this.analytics.getEngagementScore(headCoachId, subCoachId),
    ]);

    return { ...subCoach, clients, capacity: cap, engagement: score };
  }

  // ── POST /sub-coaches/:id/reassign-client ───────────────────────────────────
  // Atomic client reassignment. SubCoachReassignService.reassignClient
  // takes (headCoachId, callerId, callerRole) and asserts the caller
  // owns both the client and the source/target sub-coach. A peer sub-
  // coach calling this would fail the (head_coach_id = req.user.id)
  // ownership check inside the service. Sub-coaches CANNOT reassign
  // their peers' clients. Students have no clients to reassign.
  @Roles('coach', 'owner')
  @Post(':id/reassign-client')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Atomically reassign a client to another sub-coach (or back to head coach)' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 409, description: 'Destination at capacity' })
  async reassignClient(
    @Request() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) _subCoachIdInPath: string,
    @Body() body: ReassignClientDto,
  ) {
    const headCoachId = req.user.id;
    return this.reassign.reassignClient(
      headCoachId,
      req.user.id,
      req.user.role,
      {
        clientId: body.clientId,
        targetSubCoachId: body.targetSubCoachId,
        idempotency_key: body.idempotency_key,
        reason: body.reason,
      },
    );
  }

  // ── GET /sub-coaches/:id/analytics ─────────────────────────────────────────
  // Engagement-score breakdown. Service-side analytics resolves the score
  // for (headCoachId = req.user.id, subCoachId); a non-owning coach gets
  // a zero/empty result. Students have no semantic interpretation.
  @Roles('coach', 'owner')
  @Get(':id/analytics')
  @ApiOperation({ summary: 'Get engagement score and breakdown for a sub-coach' })
  @ApiResponse({ status: 200 })
  async getAnalytics(
    @Request() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) subCoachId: string,
  ) {
    return this.analytics.getEngagementScore(req.user.id, subCoachId);
  }

  // ── POST /sub-coaches/:id/assign-client ─────────────────────────────────────
  // Routes through SubCoachReassignService so capacity + audit +
  // idempotency are enforced identically to /reassign-client.
  //
  // Service asserts the caller owns the destination sub-coach by
  // (head_coach_id = req.user.id, sub_coach_id = :id). A peer sub-coach
  // calling this 404s on the ownership check. Sub-coaches CANNOT assign
  // clients to their peers.
  @Roles('coach', 'owner')
  @Post(':id/assign-client')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign a client to this sub-coach' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 409, description: 'Sub-coach at capacity' })
  async assignClient(
    @Request() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) subCoachId: string,
    @Body() body: AssignClientDto,
  ) {
    const headCoachId = req.user.id;
    return this.reassign.assignClient(
      headCoachId,
      req.user.id,
      req.user.role,
      {
        clientId: body.clientId,
        subCoachId,
        idempotency_key: body.idempotency_key,
        reason: body.reason,
      },
    );
  }
}
