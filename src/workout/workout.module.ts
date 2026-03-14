import { Module } from '@nestjs/common';
import { WorkoutController } from './workout.controller';
import { WorkoutService } from './workout.service';
import { PrismaService } from '../prisma.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [WorkoutController],
  providers: [WorkoutService, PrismaService],
  exports: [WorkoutService],
})
export class WorkoutModule {}
