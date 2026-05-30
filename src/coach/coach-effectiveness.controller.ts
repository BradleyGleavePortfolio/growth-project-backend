import { Controller, Get, Request, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/auth-request';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { CoachEffectivenessService } from './coach-effectiveness.service';

// EFF-2 — coach-facing self-service effectiveness surface.
//
// Until now the ONLY way to read an effectiveness score was the OWNER-only
// /admin/coach-effectiveness endpoints (RolesGuard @Roles('owner')). This
// controller exposes a single coach-scoped route so an authenticated coach
// can read THEIR OWN score without owner access.
//
// Scoping / no-leak guarantees:
//   * Mounted under /coach and gated by JwtAuthGuard + CoachGuard (coach OR
//     owner — owner bypasses, identical to the other /coach surfaces).
//   * The handler always resolves the score for `req.user.id` — there is NO
//     path parameter or query that lets a caller name another coach, so a
//     coach can never read a peer's score (no cross-coach leak).
//   * Reuses the existing CoachEffectivenessService scoring/read methods —
//     no algorithm is duplicated here.
@ApiTags('coach')
@Controller('coach')
@UseGuards(JwtAuthGuard, CoachGuard)
export class CoachEffectivenessController {
  constructor(
    private readonly effectiveness: CoachEffectivenessService,
  ) {}

  // GET /coach/my-effectiveness — the calling coach's own latest score.
  // If no score has been persisted yet (e.g. the nightly scheduler has not
  // run for a freshly-promoted coach), compute one on demand by reusing the
  // scoring service so the caller always gets a live answer.
  @Get('my-effectiveness')
  async myEffectiveness(@Request() req: AuthedRequest) {
    const coachId = req.user.id;
    const latest = await this.effectiveness.getLatest(coachId);
    if (latest) return latest;
    return this.effectiveness.score(coachId);
  }
}
