import { Controller, Get, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth-request';
import { UsersService } from './users.service';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private usersService: UsersService) {}

  /**
   * GET /users/me/founding-number
   * Returns the user's 1-indexed join rank, total user count,
   * and whether they are a "Founding Member" (rank ≤ 1000).
   */
  @Get('me/founding-number')
  getFoundingNumber(@Request() req: AuthedRequest) {
    return this.usersService.getFoundingNumber(req.user.id);
  }

  /**
   * GET /users/me/circle-stats
   * Returns how many users in the caller's "circle" (coach→student group,
   * or global if no relationship) trained today, plus the total member count.
   */
  @Get('me/circle-stats')
  getCircleStats(@Request() req: AuthedRequest) {
    return this.usersService.getCircleStats(req.user.id);
  }
}
