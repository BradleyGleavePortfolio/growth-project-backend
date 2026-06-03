import { Module } from '@nestjs/common';
import { StravaConnector } from './strava.connector';
import {
  StravaActivityFetchQueue,
  StravaWebhookController,
} from './strava-webhook.controller';
import { stravaConnectorDef, WEARABLE_CONNECTORS } from './index';

/**
 * PR-HK-2.f — Strava connector module (file-disjoint under connectors/strava/).
 *
 * Wires the Strava cloud connector surface:
 *  - {@link StravaWebhookController} — GET subscription challenge + POST push
 *    events (`/v1/wearables/webhooks/strava`).
 *  - {@link StravaActivityFetchQueue} — the enqueue facade the webhook hands a
 *    just-updated activity to (Strava events carry no payload).
 *  - {@link StravaConnector} — the OAuth2 + backfill + refresh-rotation
 *    connector implementing the foundation's WearableConnector contract.
 *
 * PrismaService is provided globally by PrismaModule (@Global), so the webhook
 * controller injects it without this module importing PrismaModule —
 * consistent with WearablesModule (PR-HK-0).
 *
 * `StravaConnector` is constructed by Nest with no args: its ctor takes an
 * OPTIONAL `deps?: Partial<StravaConnectorDeps>`, so production binds a fresh
 * ProviderHttpClient (global fetch + real timers) and `process.env`; unit
 * tests inject stub http + env. The connector is exported so the registry /
 * sync worker (separate PRs, NOT edited here) can consume it.
 *
 * Registry integration (P0-0B): this module CONTRIBUTES {@link stravaConnectorDef}
 * by binding it as a VALUE to PR-HK-1's canonical {@link WEARABLE_CONNECTORS}
 * token. PR-HK-1's `ConnectorRegistry` enumerates every provider whose injection
 * token is `WEARABLE_CONNECTORS` across all loaded modules via Nest's
 * `DiscoveryService` and indexes the discovered definitions by provider at boot —
 * so Strava becomes OAuth-discoverable once this module is imported.
 */
@Module({
  controllers: [StravaWebhookController],
  providers: [
    StravaConnector,
    StravaActivityFetchQueue,
    // Registry contribution: bind Strava's canonical ConnectorDefinition VALUE
    // to PR-HK-1's `WEARABLE_CONNECTORS` token (discovered by token at boot).
    { provide: WEARABLE_CONNECTORS, useValue: stravaConnectorDef },
  ],
  exports: [StravaConnector, StravaActivityFetchQueue, WEARABLE_CONNECTORS],
})
export class StravaConnectorModule {}
