import { Module } from '@nestjs/common';
import { StravaConnector } from './strava.connector';
import {
  StravaActivityFetchQueue,
  StravaWebhookController,
} from './strava-webhook.controller';

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
 * This module is intentionally NOT imported into WearablesModule or the
 * connector registry here — that wiring is a different PR's write-set
 * (file-disjoint mutex). It stands alone and self-contained.
 */
@Module({
  controllers: [StravaWebhookController],
  providers: [StravaConnector, StravaActivityFetchQueue],
  exports: [StravaConnector, StravaActivityFetchQueue],
})
export class StravaConnectorModule {}
