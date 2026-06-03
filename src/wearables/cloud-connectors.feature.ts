import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

/**
 * P0-0B — `FEATURE_WEARABLES_CLOUD_CONNECTORS` master switch.
 *
 * The eight cloud wearable connectors (Fitbit, Garmin, Oura, Polar, Strava,
 * Wahoo, WHOOP, Withings) are now WIRED into `WearablesModule` (so the registry
 * discovers them and their webhook controllers mount), but they ship behind a
 * default-OFF env flag until the connector-registry tests pass in production.
 *
 * Posture mirrors `FEATURE_GOOGLE_CALENDAR_SYNC` (see
 * `src/scheduling/google-oauth/google-oauth.service.ts`): the flag is read from
 * the environment, defaults OFF, and is treated as ON only when the value is
 * exactly `'true'` (case-insensitive). Unlike Google Calendar's 404 posture,
 * the wearables kill switch returns a TYPED 503 disabled error — the route is
 * mounted and known, the feature is just turned off — so the mobile client can
 * render an actionable "cloud connectors are off" state rather than a 404
 * (route-missing) or an indefinite spinner. There is NO "Coming soon" string,
 * NO `as any`, NO swallowed rejection.
 */

/** The typed error code returned by every disabled cloud-connector route. */
export const WEARABLES_CLOUD_DISABLED_CODE = 'wearables_cloud_disabled';

/** Env var name for the cloud-connectors master switch (default OFF). */
export const FEATURE_WEARABLES_CLOUD_CONNECTORS_ENV =
  'FEATURE_WEARABLES_CLOUD_CONNECTORS';

/**
 * True only when `FEATURE_WEARABLES_CLOUD_CONNECTORS` is exactly `'true'`
 * (case-insensitive). Absent / any other value → OFF.
 */
export function isWearablesCloudConnectorsEnabled(): boolean {
  return (
    process.env[FEATURE_WEARABLES_CLOUD_CONNECTORS_ENV]?.toLowerCase() === 'true'
  );
}

/**
 * The 503 body thrown by both the OAuth start endpoint and the eight webhook
 * controllers when the feature is off. Structured (not a string) so callers can
 * branch on `code` without parsing prose.
 */
export function wearablesCloudDisabledError(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: WEARABLES_CLOUD_DISABLED_CODE,
    message:
      'Cloud wearable connectors are not enabled on this environment. ' +
      'Set FEATURE_WEARABLES_CLOUD_CONNECTORS=true to enable OAuth connect and webhook delivery.',
  });
}

/**
 * Guard that gates cloud-connector routes (OAuth start + provider webhooks)
 * behind {@link isWearablesCloudConnectorsEnabled}. When the flag is off it
 * throws the typed 503 {@link wearablesCloudDisabledError} BEFORE any handler
 * body runs — so a disabled environment never starts an OAuth round-trip or
 * processes an inbound webhook delivery.
 */
@Injectable()
export class WearablesCloudConnectorsGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    if (!isWearablesCloudConnectorsEnabled()) {
      throw wearablesCloudDisabledError();
    }
    return true;
  }
}
