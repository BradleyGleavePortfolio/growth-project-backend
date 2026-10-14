import { Controller, ForbiddenException, Get, Header, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth-request';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { PrismaService } from '../prisma.service';
import { RomanFeatureGuard } from './roman-feature.guard';
import { assertRomanHasCoach } from './roman-requires-coach';
import { romanUsageToday } from './roman-usage';

/**
 * ROMANCOUNT: GET /me/roman/usage, the client's own Roman counts today, the
 * limits and the reset. Clients only: coaches and the owner are never counted,
 * and RolesGuard lets them through @Roles('student'), so they are refused here.
 */
@Controller('me/roman')
@UseGuards(JwtAuthGuard, RolesGuard, RomanFeatureGuard)
export class RomanUsageController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('usage')
  @Roles('student')
  @Header('Cache-Control', 'no-store')
  async usage(@Req() req: AuthedRequest) {
    if (req.user.role !== 'student') throw new ForbiddenException('Insufficient role');
    assertRomanHasCoach(req.user);
    return romanUsageToday(this.prisma, req.user.id);
  }
}
