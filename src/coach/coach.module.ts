import { Module } from '@nestjs/common';
import { CoachController } from './coach.controller';
import { CoachService } from './coach.service';
import { AuthModule } from '../auth/auth.module';

// PrismaService provided globally via PrismaModule.
@Module({ imports: [AuthModule], controllers: [CoachController], providers: [CoachService] })
export class CoachModule {}
