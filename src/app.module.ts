import { Logger, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { UserThrottlerGuard } from './throttler/user-throttler.guard';
import { buildThrottlerOptions } from './throttler/throttler.config';
import { AuthModule } from './auth/auth.module';
import { ExtensionPairModule } from './extension-pair/extension-pair.module';
import { JwtAuthGuard } from './auth/auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { ProfileModule } from './profile/profile.module';
import { FoodModule } from './food/food.module';
import { LogModule } from './log/log.module';
import { WorkoutModule } from './workout/workout.module';
import { FastingModule } from './fasting/fasting.module';
import { WeightModule } from './weight/weight.module';
import { HabitsModule } from './habits/habits.module';
import { AiModule } from './ai/ai.module';
import { AiGatewayModule } from './ai/gateway/ai-gateway.module';
import { AiCreditsModule } from './ai-credits/ai-credits.module';
import { CoachAIModule } from './ai/coach/coach-ai.module';
import { CoachModule } from './coach/coach.module';
import { CoachBriefModule } from './coach/brief/coach-brief.module';
import { CoachHomeModule } from './coach/home/coach-home.module';
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
import { MessagesSafetyModule } from './messages-safety/messages-safety.module';
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
import { PackagesModule } from './packages/packages.module';
import { AssignableAssetResolversModule } from './packages/asset-resolvers/asset-resolvers.module';
import { CheckoutModule } from './checkout/checkout.module';
import { ContractsModule } from './contracts/contracts.module';
import { DunningV2Module } from './checkout/dunning-v2/dunning-v2.module';
import { PayoutsV2Module } from './payouts-v2/payouts-v2.module';
import { RomanModule } from './roman/roman.module';
import { PtmModule } from './ptm/ptm.module';
import { DiagnosticModule } from './diagnostic/diagnostic.module';
import { BuildWeekModule } from './build-week/build-week.module';
import { V1Module } from './v1/v1.module';
import { InviteLandingModule } from './invite-landing/invite-landing.module';
import { PublicPagesModule } from './public-pages/public-pages.module';
import { TimelineModule } from './timeline/timeline.module';
import { FirstWinModule } from './first-win/first-win.module';
import { FeatureFlagsModule } from './feature-flags/feature-flags.module';
// Sprint B — coach toolset (workout builder, macros, real meal plans,
// holistic insights). See sprint-b PR description for the audit
// findings each module addresses.
import { ExerciseLibraryModule } from './exercise-library/exercise-library.module';
// Video library v1 — owner-curated exercise catalog + Mux ingest. The
// VideoModule (Mux adapter + webhook) is @Global so workout-builder can
// inject MuxService when it enriches assignment reads with playback URLs.
import { VideoModule } from './video/video.module';
// PR-12 — coach-media upload pipeline (Supabase PDF + Mux video) behind
// StorageProvider (decision #5). @Global so PR-13 buyer-side delivery
// endpoints can inject CoachMediaService without importing the module.
import { CoachMediaModule } from './coach-media/coach-media.module';
import { ExerciseCatalogModule } from './exercise-catalog/exercise-catalog.module';
import { WorkoutBuilderModule } from './workout-builder/workout-builder.module';
import { RegimesModule } from './regimes/regimes.module';
import { MacrosModule } from './macros/macros.module';
import { RealMealPlansModule } from './real-meal-plans/real-meal-plans.module';
import { InsightsModule } from './insights/insights.module';
// Team Mode foundation — sub-coach assignments, curated audit feed,
// Pro-tier paid staff seats. See docs/architecture/adr-0001-team-mode-foundation.md.
import { TeamModeModule } from './team-mode/team-mode.module';
// Phase 8 — Mobile coach SaaS surface (team profile, sub-coach
// invite/revoke, coach Connect business view).
import { TeamModule } from './team/team.module';
import { SubCoachesModule } from './sub-coaches/sub-coaches.module';
import { TalentMarketplaceModule } from './talent-marketplace/talent-marketplace.module';
import { CoachConnectModule } from './coach-connect/coach-connect.module';
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
import { RlsContextInterceptor } from './common/interceptors/rls-context.interceptor';
// SecurityGuardsModule consolidates every cross-cutting NestJS guard into a
// single @Global() module with zero feature-module imports. Loaded BEFORE
// AuthModule so its guards are in DI scope for every downstream module —
// see common/security/security-guards.module.ts for the prevention rationale
// (hotfix #243, prod-down 2026-05-20).
import { SecurityGuardsModule } from './common/security/security-guards.module';
// Phase 11 Track 7 — Sub-coach roster, analytics, and reassignment.
import { SubCoachModule } from './sub-coach/sub-coach.module';
// R43 — TGP Storefront Phase 1: package share links + guest checkout.
import { ShareLinkModule } from './share-link/share-link.module';
import { StorefrontModule } from './storefront/storefront.module';
// R46 — Coach Landing Page Builder Phase 2: coach CRUD + public SSR renderer
// + storefront routing. Public routes at /p/:coachSlug/:pageSlug mounted
// outside the /api prefix (see main.ts exclude list).
import { LandingPagesModule } from './landing-pages/landing-pages.module';
// PR-HK-0 — wearables/HealthKit foundation (schema + RLS gate). Provides the
// canonical IngestionService + ProviderHttpClient that later wearables PRs build on.
import { WearablesModule } from './wearables/wearables.module';

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
      useFactory: () => buildThrottlerOptions(process.env.REDIS_URL, new Logger('ThrottlerConfig')),
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

    // Cross-cutting NestJS guards (auth, roles, owner, entitlement, billing
    // tier, sub-coach gating, …). @Global with zero feature-module imports —
    // every guard's deps resolve via global providers (Prisma, Ptm,
    // Analytics) or local colocated services (JwksVerifierService).
    // Must precede AuthModule and every feature module so the guards are in
    // DI scope for `@UseGuards(...)` decorators everywhere. The accompanying
    // module-cycle Jest spec (`test/module-graph.spec.ts`) fails CI if any
    // directed cycle is reintroduced.
    SecurityGuardsModule,

    AuthModule,
    ExtensionPairModule,
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
    // Stream 1 — Coach AI Credits. @Global so the gateway can inject the
    // budget service and the brief / weekly-insight schedulers can inject
    // DormancyGuardService without re-importing this module everywhere.
    AiCreditsModule,
    // Coach AI v1 — Claude Sonnet adapter + per-client workout/meal/insight
    // generation behind /coach/ai/*. Boot-gated via CoachAIStateService;
    // returns 503 ai_disabled when ANTHROPIC_API_KEY is unset.
    CoachAIModule,
    CoachModule,
    // R43 — daily Coach Brief (AI-generated dispatch + daily log + prefs +
    // per-coach push cron). Mounts /coach/brief/*. Brief generation falls
    // back to a deterministic narrative when ANTHROPIC_API_KEY is missing
    // or the Anthropic call fails — never 503 to the coach.
    CoachBriefModule,
    // ED.2 (Roman three-arc router) — GET /coach/home/daily-rings daily
    // completion counts; flag-gated FEATURE_ROMAN_THREE_ARC_COUNTS (off).
    CoachHomeModule,
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
    // Apple App Review 1.2 — abuse-report + per-user blocklist endpoints.
    // Safety surface, NOT a paid feature. Reachable by every authenticated
    // user; intentionally absent from PAID_ROUTES.
    MessagesSafetyModule,
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
    // Phase 2 Connect — Coach offers / packages CRUD.
    PackagesModule,
    // PR-7 — Packages & Drip-Feed: AssignableAssetResolver registry.
    // Registered at the AppModule level (not under PackagesModule) so the
    // resolver wiring's MessagingModule dependency cannot loop back through
    // AuditModule → AuthModule → InviteCodesModule → BillingModule →
    // CheckoutModule → PackagesModule (the same cycle the PackagesModule
    // comment already documents). @Global on the module means PR-9/PR-10
    // can inject the registry from the drip cron without re-importing.
    AssignableAssetResolversModule,
    // Phase 3 Connect — Stripe Checkout session creation + ClientPurchase
    // lifecycle, driven by checkout/subscription/payment webhooks.
    CheckoutModule,
    // B5 — Digital contracts + e-signatures (HelloSign Embedded). Module is
    // also imported by CheckoutModule for the two-layer gate; NestJS dedupes
    // the singleton. FEATURE_CONTRACTS_ENABLED defaults OFF in prod.
    ContractsModule,
    // B3 Smart Dunning v2 — 4-attempt cadence + Day-10 lockout + late-reversal,
    // ALL behind FEATURE_DUNNING_V2 (default OFF). Imported alongside (not
    // inside) CheckoutModule so v1 dunning wiring is untouched; every v2
    // service / guard / cron self-checks the flag and no-ops while it is off.
    DunningV2Module,
    // Bank-Account Payouts v2 (spec §2). Parallel payout-method layer; every
    // surface no-ops while FEATURE_BANK_PAYOUTS_V2 is OFF (default). Safe to
    // mount ahead of the operator flip. Mirrors DunningV2Module posture.
    PayoutsV2Module,
    // Roman Phase 1 — Chat MVP backend (sessions + messages + SSE streaming +
    // RLS). Mounted always so the module-graph cycle guard keeps exercising it,
    // but the surface is dark by default: RomanFeatureGuard returns 404 on
    // every /roman route while FEATURE_ROMAN_CHAT_ENABLED is OFF (default), and
    // RomanService re-checks the flag before any Anthropic call. Mirrors the
    // DunningV2Module / PayoutsV2Module mount-then-self-gate posture. Phase 2
    // (mobile UI) and Phase 3 (push/email) follow. See src/roman/.
    RomanModule,
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
    // D5 = B+γ — GET /me/feature-flags. Server-evaluated feature-flag map for
    // the mobile client (unblocks PR #251 useFeatureFlags()). Pure read.
    FeatureFlagsModule,
    // Sprint B — coach toolset and holistic insights engine. Order is
    // not load-bearing; grouped here for discoverability.
    ExerciseLibraryModule,
    VideoModule,
    // PR-12 — coach-media. Sits next to VideoModule because it composes
    // MuxService for the video pipeline. CoachMediaModule is @Global so
    // a future buyer-side delivery surface can inject the service for
    // signed-URL minting from anywhere.
    CoachMediaModule,
    ExerciseCatalogModule,
    WorkoutBuilderModule,
    RegimesModule,
    MacrosModule,
    RealMealPlansModule,
    InsightsModule,
    // Team Mode v1 — head-coach -> sub-coach assignments, curated
    // audit feed, Pro-tier paid staff seats, Enterprise included,
    // Growth blocked at the controller with a structured upsell.
    TeamModeModule,
    TeamModule,
    SubCoachesModule,
    TalentMarketplaceModule,
    CoachConnectModule,
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
    // Phase 11 Track 7 — Sub-coach roster, analytics, and reassignment.
    SubCoachModule,
    // R43 — TGP Storefront Phase 1: package share links + guest checkout
    // via Stripe (2% application fee). Public storefront endpoints under
    // /v1/packages/public/*; coach-only mint endpoint under
    // /v1/coach/packages/:id/share-link.
    ShareLinkModule,
    StorefrontModule,
    // R46 — Landing Pages Phase 2. Coach CRUD at /api/v1/coach/landing-pages/*;
    // public SSR at /p/:coachSlug/:pageSlug (excluded from /api prefix, see main.ts).
    LandingPagesModule,
    // PR-HK-0 — wearables/HealthKit foundation.
    WearablesModule,
  ],
  providers: [
    // SECURITY: global JWT auth guard — every route is private by default.
    // Routes opt out via the @Public() decorator (see common/decorators/public.decorator.ts).
    // Previously each controller had to remember @UseGuards(JwtAuthGuard); one
    // missed decorator = public endpoint with no warning. Now the failure mode
    // is reversed: forgetting @Public() on an intentionally-public route
    // surfaces as a loud 401 in tests, not a silent data leak.
    //
    // ORDER MATTERS (Audit #2 P2-A): JwtAuthGuard is registered BEFORE
    // UserThrottlerGuard so that `req.user` is populated by the time the
    // throttler runs `getTracker()`. Otherwise the per-user buckets (e.g.
    // auth-recent-auth's 5/min limit) silently fall back to IP-based
    // tracking, which collapses two real users behind the same NAT into a
    // single shared budget. On @Public() routes JwtAuthGuard short-circuits
    // to `true` without throwing, so the throttler still runs on login /
    // signup / password-reset and bucketizes them by IP (the desired
    // behaviour for unauthenticated routes).
    { provide: APP_GUARD, useClass: JwtAuthGuard },

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

    // RLS context interceptor — runs AFTER JwtAuthGuard so req.user is populated.
    // Sets app.current_user_id + app.current_user_role as transaction-scoped
    // PostgreSQL session variables consumed by RLS policies.
    // Replaces the old RlsContextMiddleware which ran before guards and therefore
    // could never observe a valid req.user (Bug 1 fix).
    { provide: APP_INTERCEPTOR, useClass: RlsContextInterceptor },

    // ClientEntitlementGuard, SubscriptionGuard, and every other cross-cutting
    // guard are now provided by SecurityGuardsModule (@Global). Selective
    // application via @UseGuards() on controllers continues to work — the DI
    // scope is global.

    // SECURITY (Phase 10 — audit P2-2): RolesGuard is now a global APP_GUARD.
    // It is intentionally a NO-OP when no @Roles(...) decorator is present
    // (see roles.guard.ts), so existing controllers that gate by service-layer
    // checks or bespoke guards (CoachGuard, OwnerGuard, CoachOrOwnerGuard) keep
    // working unchanged. The reason for going global rather than per-controller
    // is the meta-test failure mode: previously a future controller could add
    // @Roles('owner') WITHOUT @UseGuards(RolesGuard) and the gate would
    // silently never execute. With the guard global, every @Roles(...) is
    // enforced unconditionally — and the meta-test (test/roles-enforced.spec.ts)
    // can now ASSERT this registration rather than just check metadata.
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
