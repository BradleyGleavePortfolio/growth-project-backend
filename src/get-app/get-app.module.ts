import { Module } from '@nestjs/common';
import { GetAppController } from './get-app.controller';
import { GetAppService } from './get-app.service';

// Durable backend-served "Get the app" interstitial. Lives in its own
// module so it can be lifted out into a marketing/web app later without
// rewriting wiring — same pattern as InviteLandingModule.
@Module({
  controllers: [GetAppController],
  providers: [GetAppService],
})
export class GetAppModule {}
