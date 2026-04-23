import { Module } from '@nestjs/common';
import { FoodController } from './food.controller';
import { FoodService } from './food.service';
import { AuthModule } from '../auth/auth.module';

// PrismaService provided globally via PrismaModule.
@Module({
  imports: [AuthModule],
  controllers: [FoodController],
  providers: [FoodService],
  exports: [FoodService],
})
export class FoodModule {}
