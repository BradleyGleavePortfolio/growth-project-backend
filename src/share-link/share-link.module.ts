import { Module } from '@nestjs/common';
import { ShareLinkController } from './share-link.controller';
import { ShareLinkService } from './share-link.service';

// R43 Storefront Phase 1 — coach-only share link minting. Guards
// (JwtAuthGuard, CoachGuard) are sourced from the @Global
// SecurityGuardsModule; PrismaService comes from PrismaModule.
@Module({
  controllers: [ShareLinkController],
  providers: [ShareLinkService],
  exports: [ShareLinkService],
})
export class ShareLinkModule {}
