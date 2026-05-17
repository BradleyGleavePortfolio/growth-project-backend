import { Module } from '@nestjs/common';
import { FastingController } from './fasting.controller';
import { FastingService } from './fasting.service';
import { AuthModule } from '../auth/auth.module';
import { AiModule } from '../ai/ai.module';

// PrismaService provided globally via PrismaModule.
// AiModule imported so FastingService can call ClientAIContextService.invalidateForUser
// (M2 — bust the AI context cache after fasting start/end events).
@Module({ imports: [AuthModule, AiModule], controllers: [FastingController], providers: [FastingService] })
export class FastingModule {}
