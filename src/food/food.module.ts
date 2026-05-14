import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FoodController } from './food.controller';
import { FoodService } from './food.service';
import { AuthModule } from '../auth/auth.module';

// PrismaService provided globally via PrismaModule. ConfigModule is also global
// but we import it explicitly here to make the dependency on REDIS_URL visible
// when the module is read in isolation.
@Module({
  imports: [AuthModule, ConfigModule],
  controllers: [FoodController],
  providers: [FoodService],
  exports: [FoodService],
})
export class FoodModule {}
