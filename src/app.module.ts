import { Logger, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { UserThrottlerGuard } from './throttler/user-throttler.guard';
import { buildThrottlerOptions } from './throttler/throttler.config';
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
import { AiGatewayModule } from './ai/gateway/ai-gateway.module';
import { CoachAIModule } from './ai/coach/coach-ai.module';
import { CoachModule } from './coach/coach.module';
import { NotificationsModule } from './notifications/notifications.module';
import { LeaderboardModule } from './leaderboard/leaderboard.module';
import { CommunityModule } from './community/community.module';
import { LessonsModule } from './lessons/lessons.module';
import { WaterModule } from './water/water.module';
import { SupabaseModule } from './supabase/supabase.module';
import { PrismaModule } from './prisma/prisma.module';
import { KmsModule } from './common/kms/kms.module';
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
import { BloodworkModule } from './bloodwork/bloodwork.module';
import { BillingModule } from './billing/billing.module';
import { ConnectModule } from './connect/connect.module';
import { PtmModule } from './ptm/ptm.module';
import { DiagnosticModule } from './diagnostic/diagnostic.module';
import { BuildWeekModule } from './build-week/build-week.module';
import { V1Module } from './v1/v1.module';
import { InviteLandingModule } from './invite-landing/invite-landing.module';
import { PublicPagesModule } from './public-pages/public-pages.module';
import { TimelineModule } from './timeline/timeline.module';
import { FirstWinModule } from './first-win/first-win.module';
// Sprint B — coach toolset (workout builder, macros, real meal plans,
// holistic insights). See sprint-b PR description for the audit
// findings each module addresses.
import { ExerciseLibraryModule } from './exercise-library/exercise-library.module';
// Video library v1 — owner-curated exercise catalog + Mux ingest. The
// VideoModule (Mux adapter + webhook) is @Global so workout-builder can
// inject MuxService when it enriches assignment reads with playback URLs.
import { VideoModule } from './video/video.module';
import { ExerciseCatalogModule } from './exercise-catalog/exercise-catalog.module';
import { WorkoutBuilderModule } from './workout-builder/workout-builder.module';
import { MacrosModule } from './macros/macros.module';
import { RealMealPlansModule } from './real-meal-plans/real-meal-plans.module';
import { InsightsModule } from './insights/insights.module';
// Team Mode foundation — sub-coach assignments, curated audit feed,
// Pro-tier paid staff seats. See docs/architecture/adr-0001-team-mode-foundation.md.
import { TeamModeModule } from './team-mode/team-mode.module';
// Concierge scheduling (PR #142) — private 1:1 coach <-> client booking
// with optional Google Calendar two-way sync. See
// docs/rfcs/142-concierge-scheduling.md.
import { SchedulingModule } from './scheduling/scheduling.module';
import { ObservabilityModule } from './observability/observability.module';
import { AccountDeletionModule } from './account-deletion/account-deletion.module';
// Phase 10 — GDPR Article 20 data portability.
import { DataExportModule } from './data-export/data-export.module';
// Phase 10 Track 7 — Secrets rotation playbook + zero-downtime JWT rotation.
import { SecretsModule } from './secrets/secrets.module';
// Transactional email — Resend transport + 8 launch templates + idempotency
// ledger (EmailSendLog). Global, so any feature can inject EmailService.
import { EmailModule } from './email/email.module';

@Module({
  imports: [
    // OBSERVABILITY: must be the FIRST module so RequestIdMiddleware runs before
    // every auth guard and AuditModule interceptor. See src/observability/README.md.
    ObservabilityModule,

    // Global config — loads .env automatically
    ConfigModule.forRoot({ isGlobal: true }),

    // Rate limiting: named throttlers (auth-login, auth-signup,
    // auth-password-reset, default) backed by Redis when REDIS_URL is set,
    // otherwise the built-in in-memory tracker. See throttler.config.ts
    // for the limit table; see UserThrottlerGuard for the user-id-vs-IP
    // tracker policy.
    ThrottlerModule.forRootAsync({
      useFactory: () =>
        buildThrottlerOptions(process.env.REDIS_URL, new Logger('ThrottlerConfig')),
    }),

    // In-process cron scheduler. Drives the daily GDPR scrub
    // (UsersModule -> GdprScrubScheduler) so the 30-day hard-delete
    // window is honored automatically rather than only via the
    // out-of-band scripts/gdpr-scrub.ts entry point.
    ScheduleModule.forRoot(),

    // Global Prisma module — single PrismaClient shared by every feature module.
    PrismaModule,

    // Global KMS helper. Provides KmsService for at-rest encryption of
    // sensitive fields (Bloodwork free-text, Google Calendar refresh
    // tokens). Local AES-256-GCM provider keyed by KMS_MASTER_KEY; falls
    // back to a "PLAINTEXT:" marker prefix when unconfigured so dev runs
    // without secrets do not break.
    KmsModule,

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
    // Tenant-safe AI gateway (provider routing, redaction, audit, approval).
    // Global so feature modules (coach messaging, meal-plan AI, finance proof)
    // can inject AiGatewayService without re-importing.
    AiGatewayModule,
    // Coach AI v1 — Claude Sonnet adapter + per-client workout/meal/insight
    // generation behind /coach/ai/*. Boot-gated via CoachAIStateService;
    // returns 503 ai_disabled when ANTHROPIC_API_KEY is unset.
    CoachAIModule,
    CoachModule,
    // Phase 7C — Peer Leaderboard (opt-in, coach-roster scoped).
    // Score: combined 30-day habit completion rate, never raw health data.
    LeaderboardModule,
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
    // Transactional email (Resend + log). Must precede InviteCodesModule /
    // BillingModule which inject EmailService for invite + dunning sends.
    EmailModule,
    // Consent layer v1 — client→coach data-access toggles. Global so
    // CoachService and AdminService can inject ConsentService without a
    // local import in their modules.
    ConsentModule,
    // Bloodwork v1 — client-entered lab panels with coach review,
    // consent gating, and an attachment-scan state machine. Sensitive
    // health data: see docs/bloodwork.md.
    BloodworkModule,
    // Phase 1A/1B platform admin (OWNER-only routes)
    AdminModule,
    // Stripe billing mirror + SubscriptionGuard (Phase 2A foundation).
    BillingModule,
    // Stripe Connect Express — Phase 1 of the Connect master plan. Coach
    // onboards to Stripe Express, we mirror the account state from webhooks.
    // See /CONNECT_MASTER_PLAN.md §Phase 1 — Foundation.
    ConnectModule,
    // V1 Backend-For-Frontend for tgp-coach-console.
    V1Module,
    // Public invite landing — server-rendered HTML at /join/:code and
    // /invite/:code (mounted outside the /api prefix, see main.ts).
    InviteLandingModule,
    // Durable status pages used as the destinations for APP_STORE_URL,
    // PLAY_STORE_URL, and PUBLIC_WEB_SIGNUP_URL until the real store
    // listings exist (mounted outside the /api prefix, see main.ts).
    PublicPagesModule,
    // Phase 1 PTM (Predictive Tracking Model). @Global module exposing
    // PtmService for fire-and-forget signal collection across check-ins,
    // weight, workout, food, messaging, and finance hooks; plus the
    // heuristic + weighted scoring engines and the nightly recompute
    // scheduler. See src/ptm/README.md.
    PtmModule,
    // Phase 4 — Build Week. 7-day guided coaching arc. Catalog seeded
    // by the migration; per-user enrollment + completion tracking with
    // a PTM milestone signal on Day 7. See src/build-week/README.md.
    BuildWeekModule,
    // Phase 3 — public 40-point diagnostic + AI roadmap.
    DiagnosticModule,
    // Phase 7B — Transformation Timeline. 4-lane chronological event
    // feed computed on the fly from existing tables (WeightLog,
    // ClientSignal, CoachMessage, BuildWeekEnrollment). No new migrations.
    // Endpoint: GET /me/timeline. See src/timeline/README.md.
    TimelineModule,
    // Phase 7A — Day 1 Win Sequence. POST /me/first-win/complete +
    // GET /me/first-win/status. Gates the retention screen on every new
    // client's first cold start. See src/first-win/README.md (users README).
    FirstWinModule,
    // Sprint B — coach toolset and holistic insights engine. Order is
    // not load-bearing; grouped here for discoverability.
    ExerciseLibraryModule,
    VideoModule,
    ExerciseCatalogModule,
    WorkoutBuilderModule,
    MacrosModule,
    RealMealPlansModule,
    InsightsModule,
    // Team Mode v1 — head-coach -> sub-coach assignments, curated
    // audit feed, Pro-tier paid staff seats, Enterprise included,
    // Growth blocked at the controller with a structured upsell.
    TeamModeModule,
    // Concierge scheduling — private 1:1 coach<->client booking with
    // optional Google Calendar two-way sync. Stub adapters by default
    // so the module loads without Google OAuth credentials configured;
    // real GCal adapter opt-in via GOOGLE_OAUTH_CLIENT_ID + secret.
    SchedulingModule,
    // Phase 10 — GDPR right to erasure. Two-phase deletion flow with
    // email confirmation, 14-day grace period, per-model cascade strategy,
    // and admin force-delete. See src/account-deletion/README.md.
    AccountDeletionModule,
    // Phase 10 — GDPR Article 20 right to data portability. Any user
    // (coach or client) can request a JSON archive of their own data.
    // A 7-day signed download URL is emailed when the export completes.
    DataExportModule,
    // Phase 10 Track 7 — Secrets rotation. OWNER-only surface for tracking when
    // secrets were last rotated and whether any are overdue.
    // Endpoints: GET /admin/secrets/status, POST /admin/secrets/:name/rotation-log.
    // See src/secrets/README.md.
    SecretsModule,
  ],
  providers: [
    // SECURITY: register UserThrottlerGuard as a global APP_GUARD so that @Throttle(...)
    // decorators (e.g. on /auth/login, /auth/register, /ai/chat) are actually enforced.
    // Without this, ThrottlerModule is imported but never wired in and every @Throttle
    // decorator is silently inert — see audit C2.
    //
    // UserThrottlerGuard extends @nestjs/throttler's ThrottlerGuard with a
    // getTracker() override: authenticated requests are bucketed per user-id
    // and unauthenticated ones fall back to client IP. Replaces the original
    // IP-only ThrottlerGuard so shared-NAT / mobile-CGNAT users do not lock
    // each other out, and so per-user fairness holds for authed routes.
    { provide: APP_GUARD, useClass: UserThrottlerGuard },

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
