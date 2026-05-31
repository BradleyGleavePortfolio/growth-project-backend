import { Module } from '@nestjs/common';
import { IngestionService } from './ingestion/ingestion.service';
import { ProviderHttpClient } from './http/provider-http-client';
import { ConnectionsModule } from './connections/connections.module';
import { OauthModule } from './oauth/oauth.module';
import { ConnectorRegistry } from './connector-registry';

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
 *    instance (DiscoveryService-backed), re-exported here so connector PRs
 *    (PR-HK-2.*) and any wearables submodule can inject it.
 *  - {@link OauthModule} — `OauthStateService` (CSRF state + PKCE).
 *
 * The {@link ConnectorRegistry} ships EMPTY in PR-HK-1; connector PRs register
 * themselves by binding `WEARABLE_CONNECTORS` in their own module (see
 * connector-registry.ts). Nothing in PR-HK-0's surface changed — this block is
 * strictly additive.
 */
@Module({
  imports: [ConnectionsModule, OauthModule],
  providers: [IngestionService, ProviderHttpClient],
  exports: [
    IngestionService,
    ProviderHttpClient,
    ConnectionsModule,
    OauthModule,
    ConnectorRegistry,
  ],
})
export class WearablesModule {}
