import { Module } from '@nestjs/common';
import { CommunityController } from './community.controller';
import { CommunityService } from './community.service';
import { BadgesService } from './badges.service';
import { AuthModule } from '../auth/auth.module';

// PrismaService provided globally via PrismaModule.
@Module({
  imports: [AuthModule],
  controllers: [CommunityController],
  providers: [CommunityService, BadgesService],
  exports: [BadgesService],
})
export class CommunityModule {}
