import { Module } from '@nestjs/common';
import { LogController } from './log.controller';
import { LogService } from './log.service';
import { AuthModule } from '../auth/auth.module';
import { FoodModule } from '../food/food.module';
import { AiModule } from '../ai/ai.module';

// PrismaService provided globally via PrismaModule.
// FoodModule exports FoodService — needed so LogService can resolve synthetic
// USDA/OFF food ids to real FoodItem rows before creating LoggedFoodEntry.
// AiModule imported so LogService can call ClientAIContextService.invalidateForUser
// (M2 — bust the AI context cache after food-log writes).
@Module({
  imports: [AuthModule, FoodModule, AiModule],
  controllers: [LogController],
  providers: [LogService],
  exports: [LogService],
})
export class LogModule {}
