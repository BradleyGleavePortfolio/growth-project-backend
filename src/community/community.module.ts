import { Module } from '@nestjs/common';
import { CommunityController } from './community.controller';
import { CommunityService } from './community.service';
import { AuthModule } from '../auth/auth.module';

// PrismaService provided globally via PrismaModule.
@Module({ imports: [AuthModule], controllers: [CommunityController], providers: [CommunityService] })
export class CommunityModule {}
