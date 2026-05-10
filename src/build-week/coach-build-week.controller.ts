import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { PrismaService } from '../prisma.service';
import { BuildWeekService } from './build-week.service';

// Coach-scoped read of a client's Build Week. Mounted under /coach so it
// lives next to the rest of the coach surface (matches the
// CoachCheckInsController pattern). CoachGuard pins the actor to coach
// or owner; the explicit tenancy check below ensures a coach can ONLY
// see their own clients (owners bypass via the OWNER role on
// CoachGuard).
@ApiTags('build-week')
@Controller('coach')
@UseGuards(JwtAuthGuard, CoachGuard)
export class CoachBuildWeekController {
  constructor(
    private readonly buildWeek: BuildWeekService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('clients/:clientId/build-week')
  async getForClient(
    @Request() req: AuthedRequest,
    @Param('clientId') clientId: string,
  ) {
    const isOwner = req.user.role === 'owner';
    if (!isOwner) {
      // Tenancy assertion: the requested client must be a student of the
      // requesting coach. We return NotFound (not Forbidden) so a coach
      // probing other coaches' rosters cannot enumerate user IDs.
      const link = await this.prisma.user.findFirst({
        where: { id: clientId, coach_id: req.user.id, role: 'student' },
        select: { id: true },
      });
      if (!link) throw new NotFoundException('Client not found');
    }
    const enrollment = await this.buildWeek.getEnrollmentForCoach(clientId);
    return { enrollment };
  }
}
