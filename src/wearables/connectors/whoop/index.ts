/**
 * PR-HK-2.l — WHOOP connector public surface.
 *
 * Barrel export so the integration PR can wire WHOOP with a single import
 * (`import { WhoopModule, WhoopConnector } from './connectors/whoop'`) without
 * reaching into individual files.
 */
export { WhoopConnector, signWhoopWebhook } from './whoop.connector';
export { WhoopWebhookController } from './whoop-webhook.controller';
export { WhoopModule } from './whoop.module';
export { normalizeWhoop, whoopDedupKey } from './whoop.normalizer';
export * from './whoop.types';
