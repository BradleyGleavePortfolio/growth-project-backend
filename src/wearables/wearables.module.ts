import { Module } from '@nestjs/common';
import { IngestionService } from './ingestion/ingestion.service';
import { ProviderHttpClient } from './http/provider-http-client';

/**
 * PR-HK-0 — wearables foundation module.
 *
 * Scope of THIS PR (schema + RLS gate): wire the two foundation providers so
 * later HealthKit/wearables PRs (connections, webhooks, insights) can build on
 * a stable seam.
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
 */
@Module({
  providers: [IngestionService, ProviderHttpClient],
  exports: [IngestionService, ProviderHttpClient],
})
export class WearablesModule {}
