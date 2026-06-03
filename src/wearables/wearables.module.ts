import { Module, forwardRef } from '@nestjs/common';
import { WearablesCloudConnectorsGuardModule } from './cloud-connectors.module';
import { IngestionService } from './ingestion/ingestion.service';
import { ProviderHttpClient } from './http/provider-http-client';
import { ConnectionsModule } from './connections/connections.module';
import { OauthModule } from './oauth/oauth.module';
import { InsightsModule } from './insights/insights.module';
import { SamplesModule } from './samples/samples.module';
import { PreferencesModule } from './preferences/preferences.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { FitbitModule } from './connectors/fitbit/fitbit.module';
import { GarminModule } from './connectors/garmin/garmin.module';
import { OuraModule } from './connectors/oura/oura.module';
import { PolarModule } from './connectors/polar/polar.module';
import { StravaConnectorModule } from './connectors/strava/strava.module';
import { WahooModule } from './connectors/wahoo/wahoo.module';
import { WhoopModule } from './connectors/whoop/whoop.module';
import { WithingsModule } from './connectors/withings/withings.module';

/**
 * PR-HK-0 — wearables foundation module.
 *
 * Scope of THE FOUNDATION PR (schema + RLS gate): wire the two foundation
 * providers so later HealthKit/wearables PRs (connections, webhooks, insights)
 * can build on a stable seam.
 *
 *  - {@link IngestionService} — the canonical normalized-sample ingestion lane
 *    (batch upsert + dedup + cache invalidation + read-time resolveBest).
 *  - {@link ProviderHttpClient} — the single hardened HTTP client all cloud
 *    connectors will route through (timeout + capped jittered backoff).
 *
 * PrismaService is provided globally by PrismaModule (@Global) — IngestionService
 * injects it without this module importing PrismaModule. ProviderHttpClient takes
 * an OPTIONAL `deps?: Partial<ProviderHttpDeps>`; Nest constructs it with no args,
 * so it binds the global `fetch` + real timers in production (tests inject stubs).
 *
 * Both services are exported so downstream wearables modules (PR-HK-1+) can
 * consume them without re-providing.
 *
 * ── PR-HK-1 (pure-additive wiring) ──
 * Mount the generic OAuth + connection-management surface:
 *  - {@link ConnectionsModule} — connect/callback/list/disconnect API +
 *    service. It also provides + exports the single {@link ConnectorRegistry}
 *    instance (DiscoveryService-backed), exposed transitively via
 *    `ConnectionsModule`'s exports — connector PRs (PR-HK-2.*) and submodules
 *    consume it through `imports: [ConnectionsModule]` or
 *    `imports: [WearablesModule]`.
 *  - {@link OauthModule} — `OauthStateService` (CSRF state + PKCE).
 *
 * The {@link ConnectorRegistry} ships EMPTY in PR-HK-1; connector PRs register
 * themselves by binding `WEARABLE_CONNECTORS` in their own module (see
 * connector-registry.ts). Nothing in PR-HK-0's surface changed — this block is
 * strictly additive.
 *
 * ── PR-HK-4 (pure-additive wiring) ──
 * Mount {@link InsightsModule} — embedded AI insights (backend-only). The
 * coach + client insight endpoints mount under the wearables feature without
 * touching the PR-HK-0 ingestion seam or the PR-HK-1 connections seam.
 * Disjoint folder (src/wearables/insights/), no shared providers.
 *
 * ── PR-HK-3a (pure-additive wiring) ──
 * Mount {@link SamplesModule} (GET /v1/wearables/samples — the H&F / S&R
 * read API consumed by the mobile WearablesShell + Metric Detail) and
 * {@link PreferencesModule} (POST/DELETE /v1/wearables/preferences — the
 * read-time precedence override the provider-overlap chips write). Both are
 * disjoint folders (src/wearables/samples/, src/wearables/preferences/) with
 * no shared providers beyond the @Global PrismaService + the PR-HK-0
 * IngestionService (re-provided inside SamplesModule), so this block is
 * strictly additive over the PR-HK-0/1/4 seams.
 *
 * ── PR-HK (cron prune) (pure-additive wiring) ──
 * Mount {@link MaintenanceModule} — the daily WearableProcessedEvent retention
 * prune (scheduler + service). Disjoint folder (src/wearables/maintenance/),
 * no shared providers beyond the @Global PrismaService, so this block is
 * strictly additive over the seams above. This is the prune cron deferred from
 * the HK wearables expansion (unbounded webhook-idempotency ledger growth).
 */
@Module({
  imports: [
    // P0-0B: register the cloud-connectors kill-switch guard in DI scope so
    // `@UseGuards(WearablesCloudConnectorsGuard)` resolves for the OAuth-start
    // endpoint and the eight webhook controllers. @Global, so one import here
    // makes the guard injectable across every wearables sub-module.
    WearablesCloudConnectorsGuardModule,
    ConnectionsModule,
    OauthModule,
    InsightsModule,
    SamplesModule,
    PreferencesModule,
    MaintenanceModule,
    // ── P0-0B: cloud wearable connector modules ──────────────────────────────
    // Each connector module binds its ConnectorDefinition to the canonical
    // `WEARABLE_CONNECTORS` token; ConnectionsModule's ConnectorRegistry
    // (DiscoveryService-backed) aggregates all eight at boot. Garmin + WHOOP
    // import WearablesModule back (for the shared HTTP/ingestion seam), so they
    // are wrapped in `forwardRef` on BOTH sides to break the module cycle.
    FitbitModule,
    forwardRef(() => GarminModule),
    OuraModule,
    PolarModule,
    StravaConnectorModule,
    WahooModule,
    forwardRef(() => WhoopModule),
    WithingsModule,
  ],
  providers: [IngestionService, ProviderHttpClient],
  exports: [
    IngestionService,
    ProviderHttpClient,
    ConnectionsModule,
    OauthModule,
    InsightsModule,
    SamplesModule,
    PreferencesModule,
    MaintenanceModule,
    FitbitModule,
    GarminModule,
    OuraModule,
    PolarModule,
    StravaConnectorModule,
    WahooModule,
    WhoopModule,
    WithingsModule,
  ],
})
export class WearablesModule {}
