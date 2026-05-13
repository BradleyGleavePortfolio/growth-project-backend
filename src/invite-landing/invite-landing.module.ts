import { Module } from '@nestjs/common';
import { InviteCodesModule } from '../invite-codes/invite-codes.module';
import { InviteLandingController } from './invite-landing.controller';
import { InviteLandingService } from './invite-landing.service';
import { WellKnownController } from './well-known.controller';

// The HTML landing pages live in a dedicated module so they can be lifted
// out into a separate web app later without rewriting controllers or wiring.
// See docs/invite-landing.md for the future-extraction plan.
//
// WellKnownController serves /.well-known/apple-app-site-association and
// /.well-known/assetlinks.json. It sits in this module because the same
// invite-landing surface is the consumer of universal links — when these
// 404, the invite flow breaks end-to-end.
@Module({
  imports: [InviteCodesModule],
  controllers: [InviteLandingController, WellKnownController],
  providers: [InviteLandingService],
})
export class InviteLandingModule {}
