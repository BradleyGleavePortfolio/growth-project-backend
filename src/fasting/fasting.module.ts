import { Module } from '@nestjs/common';
import { FastingController } from './fasting.controller';
import { FastingService } from './fasting.service';
import { AuthModule } from '../auth/auth.module';

// PrismaService provided globally via PrismaModule.
@Module({ imports: [AuthModule], controllers: [FastingController], providers: [FastingService] })
export class FastingModule {}
