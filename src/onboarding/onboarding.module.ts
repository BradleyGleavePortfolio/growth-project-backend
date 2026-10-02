import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkoutBuilderModule } from '../workout-builder/workout-builder.module';
import { CoachConsultationController, OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

// PrismaService provided globally via PrismaModule.
@Module({
  imports: [AuthModule, WorkoutBuilderModule],
  controllers: [OnboardingController, CoachConsultationController],
  providers: [OnboardingService],
  exports: [OnboardingService],
})
export class OnboardingModule {}
