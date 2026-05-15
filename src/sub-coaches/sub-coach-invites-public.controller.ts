import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { SubCoachesService } from './sub-coaches.service';

// Phase 8 — UNAUTHENTICATED invite-token preview.
//
// Kept on a separate controller from the main /sub-coaches surface
// because the class-level `@UseGuards(JwtAuthGuard, CoachGuard)` on
// SubCoachesController would reject the anonymous deep-link landing
// caller. The mobile flow:
//
//   1. Invitee taps the email link → app opens with the token in the
//      route.
//   2. App calls GET /sub-coaches/invites/by-token/:token (this
//      endpoint) BEFORE they sign in, to render "{head coach} invited
//      you to join their team — accept / decline" with the right
//      branding.
//   3. If they need an account, the app sends them through signup; the
//      token survives the deep-link round-trip.
//   4. Once authenticated, the app posts the token to
//      /sub-coaches/invites/accept to do the actual claim.
//
// The endpoint returns a narrow status field (`pending|accepted|
// revoked|expired`) so the UI knows whether to show an accept CTA or a
// terminal message; it never reveals the token itself nor any data
// outside the head-coach's name and the invitee's email.
@ApiTags('sub-coaches')
@Controller('sub-coaches/invites')
export class SubCoachInvitesPublicController {
  constructor(private readonly subCoaches: SubCoachesService) {}

  @Public()
  @Get('by-token/:token')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async previewByToken(@Param('token') token: string) {
    return this.subCoaches.previewByToken(token);
  }
}
