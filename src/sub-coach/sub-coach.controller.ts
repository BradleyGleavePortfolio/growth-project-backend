import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { SubCoachAssignmentService, AssignClientDto } from './sub-coach-assignment.service';
import { SubCoachAnalyticsService } from './sub-coach-analytics.service';
import { SubCoachCapacityService } from './sub-coach-capacity.service';
import { SubCoachReassignService, ReassignClientDto } from './sub-coach-reassign.service';
import { PrismaService } from '../prisma.service';

/**
 * SubCoachController
 *
 * Head-coach–facing endpoints for managing the sub-coach roster:
 *   GET  /sub-coaches                        — list sub-coaches with capacity + score
 *   GET  /sub-coaches/:id                    — single sub-coach detail
 *   POST /sub-coaches/:id/reassign-client    — atomically move a client
 *   GET  /sub-coaches/:id/analytics          — engagement score + breakdown
 *
 * All routes require JwtAuthGuard + CoachGuard (coach or owner role).
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
  @Get()
  @ApiOperation({ summary: 'List all sub-coaches belonging to the calling head coach' })
  @ApiResponse({ status: 200 })
  async listSubCoaches(@Request() req: AuthedRequest) {
    const headCoachId = req.user.id;

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
      orderBy: { name: 'asc' },
    });

    const results = await Promise.all(
      subCoaches.map(async (sc) => {
        const [cap, score] = await Promise.all([
          this.capacity.getCapacity(headCoachId, sc.id),
          this.analytics.getEngagementScore(headCoachId, sc.id),
        ]);
        return { ...sc, capacity: cap, engagement: score };
      }),
    );

    return results;
  }

  // ── GET /sub-coaches/:id ────────────────────────────────────────────────────
  @Get(':id')
  @ApiOperation({ summary: 'Get a single sub-coach including client list and capacity' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404 })
  async getSubCoach(
    @Request() req: AuthedRequest,
    @Param('id') subCoachId: string,
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
      throw new Error('Sub-coach not found');
    }

    const [clients, cap, score] = await Promise.all([
      this.assignment.getAssignedClients(headCoachId, subCoachId),
      this.capacity.getCapacity(headCoachId, subCoachId),
      this.analytics.getEngagementScore(headCoachId, subCoachId),
    ]);

    return { ...subCoach, clients, capacity: cap, engagement: score };
  }

  // ── POST /sub-coaches/:id/reassign-client ───────────────────────────────────
  @Post(':id/reassign-client')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Atomically reassign a client to this sub-coach (or back to head coach)' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 409, description: 'Destination at capacity' })
  async reassignClient(
    @Request() req: AuthedRequest,
    @Param('id') toSubCoachId: string,
    @Body() body: { clientId: string; reason?: string },
  ) {
    const headCoachId = req.user.id;
    const dto: ReassignClientDto = {
      clientId: body.clientId,
      toSubCoachId,
      reason: body.reason,
    };
    return this.reassign.reassignClient(
      headCoachId,
      req.user.id,
      req.user.role,
      dto,
    );
  }

  // ── GET /sub-coaches/:id/analytics ─────────────────────────────────────────
  @Get(':id/analytics')
  @ApiOperation({ summary: 'Get engagement score and breakdown for a sub-coach' })
  @ApiResponse({ status: 200 })
  async getAnalytics(
    @Request() req: AuthedRequest,
    @Param('id') subCoachId: string,
  ) {
    return this.analytics.getEngagementScore(req.user.id, subCoachId);
  }

  // ── POST /sub-coaches/:id/assign-client ─────────────────────────────────────
  @Post(':id/assign-client')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign a client to this sub-coach' })
  async assignClient(
    @Request() req: AuthedRequest,
    @Param('id') subCoachId: string,
    @Body() body: { clientId: string },
  ) {
    const dto: AssignClientDto = { clientId: body.clientId, subCoachId };
    return this.assignment.assignClient(req.user.id, dto);
  }
}
