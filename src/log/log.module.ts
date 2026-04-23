import { Module } from '@nestjs/common';
import { LogController } from './log.controller';
import { LogService } from './log.service';
import { AuthModule } from '../auth/auth.module';
import { FoodModule } from '../food/food.module';

// PrismaService provided globally via PrismaModule.
// FoodModule exports FoodService — needed so LogService can resolve synthetic
// USDA/OFF food ids to real FoodItem rows before creating LoggedFoodEntry.
@Module({
  imports: [AuthModule, FoodModule],
  controllers: [LogController],
  providers: [LogService],
  exports: [LogService],
})
export class LogModule {}
