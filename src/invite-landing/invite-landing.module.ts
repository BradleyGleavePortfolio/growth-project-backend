import { Module } from '@nestjs/common';
import { InviteCodesModule } from '../invite-codes/invite-codes.module';
import { InviteLandingController } from './invite-landing.controller';
import { InviteLandingService } from './invite-landing.service';

// The HTML landing pages live in a dedicated module so they can be lifted
// out into a separate web app later without rewriting controllers or wiring.
// See docs/invite-landing.md for the future-extraction plan.
@Module({
  imports: [InviteCodesModule],
  controllers: [InviteLandingController],
  providers: [InviteLandingService],
})
export class InviteLandingModule {}
