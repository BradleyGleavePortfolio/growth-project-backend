import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { ProfileModule } from './profile/profile.module';
import { FoodModule } from './food/food.module';
import { LogModule } from './log/log.module';
import { WorkoutModule } from './workout/workout.module';
import { FastingModule } from './fasting/fasting.module';
import { WeightModule } from './weight/weight.module';
import { HabitsModule } from './habits/habits.module';
import { AiModule } from './ai/ai.module';
import { CoachModule } from './coach/coach.module';
import { NotificationsModule } from './notifications/notifications.module';
import { CommunityModule } from './community/community.module';
import { LessonsModule } from './lessons/lessons.module';
import { SupabaseModule } from './supabase/supabase.module';
import { PrismaService } from './prisma.service';

@Module({
  imports: [
    // Global config — loads .env automatically
    ConfigModule.forRoot({ isGlobal: true }),

    // Rate limiting: 100 requests per minute globally (AI endpoint has own tighter limit)
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),

    // Supabase singleton client (global — available to all modules)
    SupabaseModule,

    AuthModule,
    ProfileModule,
    FoodModule,
    LogModule,
    WorkoutModule,
    FastingModule,
    WeightModule,
    HabitsModule,
    AiModule,
    CoachModule,
    NotificationsModule,
    CommunityModule,
    LessonsModule,
  ],
  providers: [PrismaService],
})
export class AppModule {}
