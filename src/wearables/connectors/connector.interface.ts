import { WearableConnection, WearableProvider } from '@prisma/client';
import {
  NormalizedSample,
  RawRecord,
  TokenSet,
} from '../normalization/normalizer.types';

/**
 * PR-HK-0 — the contract every provider connector implements (Agent 2 §3).
 *
 * Each provider lives in its own file-disjoint module folder
 * (`src/wearables/connectors/<provider>/`) and exports a const implementing
 * this interface, so the 14+ connector PRs run fully in parallel after the
 * foundation lands. The foundation defines ONLY the interface — no provider
 * logic ships in PR-HK-0 (50-Failures #43 — no dead/stub connector code is
 * merged here).
 *
 * Auth models:
 *  - `oauth2`     — server-side OAuth (Oura, Whoop, Strava, Garmin, …).
 *  - `sdk-native` — on-device SDK that still has a server token (rare).
 *  - `on-device`  — HealthKit / Health Connect / Samsung Health. No server
 *                   token, no server backfill, no webhook: the mobile app
 *                   reads device data and POSTs pre-normalized samples to
 *                   the ingest endpoint. For these, `buildAuthUrl` returns
 *                   null and the OAuth/backfill methods are not exercised.
 */
export type WearableAuthModel = 'oauth2' | 'sdk-native' | 'on-device';

/**
 * Minimal shape of an inbound webhook request a connector needs to verify
 * and parse it. Provider webhook controllers (PR-HK-2.*) construct this from
 * the raw NestJS request (raw body + headers) so signature verification runs
 * against the unparsed bytes (Stripe-pattern raw-body HMAC).
 */
export interface RawWebhookRequest {
  /** Raw, unparsed request body bytes (required for HMAC verification). */
  rawBody: Buffer;
  /** Lower-cased header map. */
  headers: Record<string, string | string[] | undefined>;
}

/**
 * A deduped, normalized provider event extracted from a webhook. The
 * `providerEventId` keys {@link WearableProcessedEvent} for replay
 * protection (50-Failures #28/#29).
 */
export interface ProviderEvent {
  /** Stable provider-native event id (composite-key segment for dedup). */
  providerEventId: string;
  /** Provider-native event type (e.g. "sleep.updated"). */
  type: string;
  /** Records referenced by the event, to be fetched/normalized. */
  records: RawRecord[];
}

export interface WearableConnector {
  /** The provider this connector serves. */
  readonly provider: WearableProvider;

  /** How this provider authenticates / delivers data. */
  readonly authModel: WearableAuthModel;

  /**
   * Build the provider OAuth authorization URL for a connect flow. Returns
   * `null` for `on-device` providers (no server OAuth). `state` is the
   * server-minted CSRF/PKCE state (PR-HK-1 owns its generation/validation).
   */
  buildAuthUrl(userId: string, state: string): string | null;

  /** Exchange an OAuth authorization code for a {@link TokenSet}. */
  exchangeCode(code: string): Promise<TokenSet>;

  /** Refresh an expiring access token using the connection's refresh token. */
  refresh(conn: WearableConnection): Promise<TokenSet>;

  /**
   * Pull provider history since `since` (TOS-bounded; the connector enforces
   * its own backfill window and never exceeds it). Returns raw records to be
   * normalized — must page internally and never N+1 the ingestion lane
   * (50-Failures #21).
   */
  backfill(conn: WearableConnection, since: Date): Promise<RawRecord[]>;

  /** Map provider-native raw records to canonical normalized samples. */
  normalize(raw: RawRecord[]): NormalizedSample[];

  /**
   * Verify a webhook's authenticity (provider-specific HMAC). Optional:
   * polling-only providers (Peloton / Eight Sleep) omit it.
   */
  verifyWebhook?(req: RawWebhookRequest): boolean;

  /** Parse a verified webhook into provider events. Optional (see above). */
  parseWebhook?(req: RawWebhookRequest): ProviderEvent[];
}
