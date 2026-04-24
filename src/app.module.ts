import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
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
import { WaterModule } from './water/water.module';
import { SupabaseModule } from './supabase/supabase.module';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './health/health.module';
import { InviteCodesModule } from './invite-codes/invite-codes.module';
import { MessagingModule } from './messaging/messaging.module';

@Module({
  imports: [
    // Global config — loads .env automatically
    ConfigModule.forRoot({ isGlobal: true }),

    // Rate limiting: 100 requests per minute globally (AI endpoint has own tighter limit)
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),

    // Global Prisma module — single PrismaClient shared by every feature module.
    PrismaModule,

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
    WaterModule,
    HealthModule,
    InviteCodesModule,
    MessagingModule,
  ],
  providers: [
    // SECURITY: register ThrottlerGuard as a global APP_GUARD so that @Throttle(...)
    // decorators (e.g. on /auth/login, /auth/register, /ai/chat) are actually enforced.
    // Without this, ThrottlerModule is imported but never wired in and every @Throttle
    // decorator is silently inert — see audit C2.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
