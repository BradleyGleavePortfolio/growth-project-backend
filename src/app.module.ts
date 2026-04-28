import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/auth.guard';
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
import { NudgesModule } from './nudges/nudges.module';
import { MealPlansModule } from './meal-plans/meal-plans.module';
import { CheckInsModule } from './check-ins/check-ins.module';
import { RecipesModule } from './recipes/recipes.module';
import { ListsModule } from './lists/lists.module';
import { PrepGuideModule } from './prep-guide/prep-guide.module';
import { UsersModule } from './users/users.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { SystemModule } from './system/system.module';
import { AdminModule } from './admin/admin.module';
import { AuditModule } from './audit/audit.module';
import { ConsentModule } from './consent/consent.module';
import { BillingModule } from './billing/billing.module';
import { V1Module } from './v1/v1.module';
import { InviteLandingModule } from './invite-landing/invite-landing.module';
import { PublicPagesModule } from './public-pages/public-pages.module';

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
    NudgesModule,
    MealPlansModule,
    CheckInsModule,
    RecipesModule,
    ListsModule,
    PrepGuideModule,
    UsersModule,
    // Global PostHog analytics (no-op when POSTHOG_KEY is unset)
    AnalyticsModule,
    // Trust & Privacy metadata (psych report #2: Trust as Emotion)
    SystemModule,
    // Global immutable audit log (compliance + sensitive-action trail).
    // Must precede AdminModule + UsersModule so AuditService is in DI scope.
    AuditModule,
    // Consent layer v1 — client→coach data-access toggles. Global so
    // CoachService and AdminService can inject ConsentService without a
    // local import in their modules.
    ConsentModule,
    // Phase 1A/1B platform admin (OWNER-only routes)
    AdminModule,
    // Stripe billing mirror + SubscriptionGuard (Phase 2A foundation).
    BillingModule,
    // V1 Backend-For-Frontend for tgp-coach-console.
    V1Module,
    // Public invite landing — server-rendered HTML at /join/:code and
    // /invite/:code (mounted outside the /api prefix, see main.ts).
    InviteLandingModule,
    // Durable status pages used as the destinations for APP_STORE_URL,
    // PLAY_STORE_URL, and PUBLIC_WEB_SIGNUP_URL until the real store
    // listings exist (mounted outside the /api prefix, see main.ts).
    PublicPagesModule,
  ],
  providers: [
    // SECURITY: register ThrottlerGuard as a global APP_GUARD so that @Throttle(...)
    // decorators (e.g. on /auth/login, /auth/register, /ai/chat) are actually enforced.
    // Without this, ThrottlerModule is imported but never wired in and every @Throttle
    // decorator is silently inert — see audit C2.
    { provide: APP_GUARD, useClass: ThrottlerGuard },

    // SECURITY: global JWT auth guard — every route is private by default.
    // Routes opt out via the @Public() decorator (see common/decorators/public.decorator.ts).
    // Previously each controller had to remember @UseGuards(JwtAuthGuard); one
    // missed decorator = public endpoint with no warning. Now the failure mode
    // is reversed: forgetting @Public() on an intentionally-public route
    // surfaces as a loud 401 in tests, not a silent data leak.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
