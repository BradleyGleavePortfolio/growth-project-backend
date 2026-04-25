import { Module } from '@nestjs/common';
import { PrepGuideController } from './prep-guide.controller';
import { PrepGuideService } from './prep-guide.service';
import { AuthModule } from '../auth/auth.module';

// PrismaService provided globally via PrismaModule.
@Module({ imports: [AuthModule], controllers: [PrepGuideController], providers: [PrepGuideService] })
export class PrepGuideModule {}
