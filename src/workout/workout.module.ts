import { Module } from '@nestjs/common';
import { WorkoutController } from './workout.controller';
import { WorkoutService } from './workout.service';
import { AuthModule } from '../auth/auth.module';
import { AiModule } from '../ai/ai.module';

// PrismaService provided globally via PrismaModule.
// AiModule imported so WorkoutService can call ClientAIContextService.invalidateForUser
// (M2 — bust the AI context cache after workout writes).
@Module({
  imports: [AuthModule, AiModule],
  controllers: [WorkoutController],
  providers: [WorkoutService],
  exports: [WorkoutService],
})
export class WorkoutModule {}
