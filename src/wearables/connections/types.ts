import { WearableProvider } from '@prisma/client';

/**
 * PR-HK-1 — shared connection types + enum mappings for the connections lane.
 *
 * Single source of truth (guard #40) for connection-status strings and the
 * safe (token-free) projection shape returned by the read API. The
 * `WearableConnection.status` column is a free-form string in the schema
 * (Agent 2 §2.3); this enum pins the canonical lifecycle values so the
 * service/controller never hardcode magic strings.
 */

/**
 * Connection lifecycle states. Mirrors the documented values on
 * `WearableConnection.status`:
 *  - `connected`    — active; tokens valid (cloud) or device-permission granted.
 *  - `expired`      — token/consent expired; needs re-link.
 *  - `error`        — provider outage / refresh failure (fail-explicit, #36/#50).
 *  - `disconnected` — soft-disconnected by the user; tokens cleared, audit kept.
 */
export enum WearableConnectionStatus {
  CONNECTED = 'connected',
  EXPIRED = 'expired',
  ERROR = 'error',
  DISCONNECTED = 'disconnected',
}

/**
 * The token-free connection projection returned to clients/coaches. This
 * shape MUST mirror the `WearableConnectionSafe` view (PR-HK-0) — it omits
 * every `encrypted_*` column and the `*_secret_ref` pointers (50-Failures
 * #12 — never serialize secrets). The service selects exactly these columns.
 */
export interface SafeWearableConnection {
  id: string;
  user_id: string;
  provider: WearableProvider;
  external_account_id: string | null;
  access_token_expires_at: Date | null;
  scopes: string[];
  webhook_subscription_id: string | null;
  channel_expires_at: Date | null;
  status: string;
  last_error: string | null;
  last_synced_at: Date | null;
  backfilled_until: Date | null;
  disconnected_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * The exact column set the read path selects from `WearableConnection`. Kept
 * as a const so the Prisma `select` and the {@link SafeWearableConnection}
 * type can never drift — adding a column here without adding it to the type
 * (or vice versa) is a compile error.
 *
 * Deliberately EXCLUDES: `encrypted_refresh_token`, `encrypted_access_token`,
 * `credentials_secret_ref`, `webhook_secret_ref`.
 */
export const SAFE_CONNECTION_SELECT = {
  id: true,
  user_id: true,
  provider: true,
  external_account_id: true,
  access_token_expires_at: true,
  scopes: true,
  webhook_subscription_id: true,
  channel_expires_at: true,
  status: true,
  last_error: true,
  last_synced_at: true,
  backfilled_until: true,
  disconnected_at: true,
  created_at: true,
  updated_at: true,
} as const;

/** Result of starting an OAuth connect flow. */
export interface StartOauthResult {
  /** Provider authorization URL the client opens in a browser/web-view. */
  authorizationUrl: string;
  /** Opaque, single-use CSRF state echoed by the provider on callback. */
  state: string;
}

/** Result of completing an OAuth callback (NEVER includes tokens). */
export interface OauthCallbackResult {
  success: true;
  provider: WearableProvider;
}

/** Result of a soft-disconnect. */
export interface DisconnectResult {
  success: true;
  provider: WearableProvider;
}
