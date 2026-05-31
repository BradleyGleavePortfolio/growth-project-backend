/**
 * PR-HK-2.f — Strava connector public barrel.
 *
 * The single import surface for the Strava connector folder. The connector
 * registry / sync worker (separate PRs) import the connector + module from
 * here; nothing reaches inside the folder past this barrel.
 */
export { StravaConnector } from './strava.connector';
export type { StravaConnectorDeps } from './strava.connector';
export { normalizeStravaActivities, computeStravaDedupKey } from './strava.normalizer';
export { StravaConnectorModule } from './strava.module';
export {
  StravaWebhookController,
  StravaActivityFetchQueue,
} from './strava-webhook.controller';
export {
  STRAVA_SCOPES,
} from './strava.types';
export type {
  StravaActivity,
  StravaWebhookEvent,
  StravaWebhookVerifyQuery,
  StravaTokenResponse,
} from './strava.types';
