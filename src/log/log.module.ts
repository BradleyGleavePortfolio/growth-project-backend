import { Module } from '@nestjs/common';
import { LogController } from './log.controller';
import { LogService } from './log.service';
import { SavedFoodsController } from './saved-foods.controller';
import { SavedFoodsService } from './saved-foods.service';
import { AuthModule } from '../auth/auth.module';
import { FoodModule } from '../food/food.module';
import { AiModule } from '../ai/ai.module';

// PrismaService provided globally via PrismaModule.
// FoodModule exports FoodService — needed so LogService can resolve synthetic
// USDA/OFF food ids to real FoodItem rows before creating LoggedFoodEntry.
// AiModule imported so LogService can call ClientAIContextService.invalidateForUser
// (M2 — bust the AI context cache after food-log writes).
// SavedFoodsController (FOODSAVED): /me/foods favourites and saved meals, which
// log through the same entry table.
@Module({
  imports: [AuthModule, FoodModule, AiModule],
  controllers: [LogController, SavedFoodsController],
  providers: [LogService, SavedFoodsService],
  exports: [LogService],
})
export class LogModule {}
