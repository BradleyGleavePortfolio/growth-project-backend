import { Module } from '@nestjs/common';
import { InviteCodesModule } from '../invite-codes/invite-codes.module';
import { CoachlessController, FeaturedCoachAdminController } from './coachless.controller';
import { CoachCodeLookupService } from './coach-code-lookup.service';
import { CoachCodeRedemptionService } from './coach-code-redemption.service';
import { CoachlessHomeService } from './coachless-home.service';
import { CoachlessPromptService } from './coachless-prompt.service';
import { FeaturedCoachService } from './featured-coach.service';

// A1-COACHLESS — coachless Home (banner + scripted Roman card), the owner's
// featured-coach config and post-signup coach-code redemption. PrismaService
// and the auth guards are global; InviteCodesModule exports the canonical
// attach writer this module delegates to.
@Module({
  imports: [InviteCodesModule],
  controllers: [CoachlessController, FeaturedCoachAdminController],
  providers: [
    CoachCodeLookupService,
    CoachCodeRedemptionService,
    CoachlessHomeService,
    CoachlessPromptService,
    FeaturedCoachService,
  ],
  exports: [FeaturedCoachService],
})
export class CoachlessModule {}
