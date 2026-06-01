/**
 * PR-HK-2.d — Garmin connector public surface.
 *
 * Barrel export so the integration PR can wire Garmin with a single import
 * (`import { GarminModule, GarminConnector } from './connectors/garmin'`)
 * without reaching into individual files.
 */
export {
  GarminConnector,
  garminPushTokenHeader,
  hashGarminUserId,
} from './garmin.connector';
export { GarminWebhookController } from './garmin-webhook.controller';
export { GarminModule } from './garmin.module';
export {
  normalizeGarmin,
  garminDedupKey,
  offsetToSourceTz,
} from './garmin.normalizer';
export * from './garmin.types';
