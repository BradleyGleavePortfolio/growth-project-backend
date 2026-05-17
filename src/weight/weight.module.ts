import { Module } from '@nestjs/common';
import { WeightController } from './weight.controller';
import { WeightService } from './weight.service';
import { AuthModule } from '../auth/auth.module';
import { AiModule } from '../ai/ai.module';

// PrismaService provided globally via PrismaModule.
// AiModule imported so WeightService can call ClientAIContextService.invalidateForUser
// (M2 — bust the AI context cache after weight writes).
@Module({ imports: [AuthModule, AiModule], controllers: [WeightController], providers: [WeightService] })
export class WeightModule {}
