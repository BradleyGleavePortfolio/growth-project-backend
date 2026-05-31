import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { OauthModule } from '../oauth/oauth.module';
import { ConnectorRegistry } from '../connector-registry';
import { ConnectionsController } from './connections.controller';
import { ConnectionsService } from './connections.service';

/**
 * PR-HK-1 — generic wearable connection management module.
 *
 * Wires the OAuth connect/callback/list/disconnect API:
 *  - {@link ConnectionsController} — the HTTP surface (JWT-guarded,
 *    rate-limited, validated).
 *  - {@link ConnectionsService} — the provider-agnostic OAuth + connection
 *    logic (state/PKCE consumption, KMS token wrapping, upsert, IDOR-safe
 *    read/disconnect).
 *
 * Dependencies:
 *  - {@link OauthModule} provides `OauthStateService` (imported, not
 *    re-provided).
 *  - {@link DiscoveryModule} provides `DiscoveryService`, which the
 *    {@link ConnectorRegistry} uses to aggregate every connector contributed
 *    by PR-HK-2.* connector modules across the whole app.
 *  - {@link ConnectorRegistry} is provided + exported HERE (single instance)
 *    so `ConnectionsService` injects it from the same module scope. It is
 *    re-exported by {@link WearablesModule}. There is exactly ONE registry
 *    instance in the app; DiscoveryService scans all loaded modules, so
 *    connectors registered anywhere are picked up regardless of where the
 *    registry instance lives.
 *
 * `KmsService` is `@Global` (KmsModule), so it is injectable here without an
 * explicit import. `PrismaService` is likewise global.
 *
 * Exports {@link ConnectionsService} (for connector PRs to reuse connection
 * helpers) and {@link ConnectorRegistry} (the single shared instance).
 */
@Module({
  imports: [DiscoveryModule, OauthModule],
  controllers: [ConnectionsController],
  providers: [ConnectionsService, ConnectorRegistry],
  exports: [ConnectionsService, ConnectorRegistry],
})
export class ConnectionsModule {}
