import { Module } from '@nestjs/common';
import { CommunityController } from './community.controller';
import { CommunityService } from './community.service';
import { CommunityRepository } from './community.repository';
import { CommunityFeatureFlagGuard } from './community-feature-flag.guard';
import { AuthModule } from '../auth/auth.module';

// PrismaService provided globally via PrismaModule.
@Module({
  imports: [AuthModule],
  controllers: [CommunityController],
  providers: [
    CommunityService,
    CommunityRepository,
    CommunityFeatureFlagGuard,
  ],
  exports: [],
})
export class CommunityModule {}
