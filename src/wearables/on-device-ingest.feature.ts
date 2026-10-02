import { ServiceUnavailableException } from '@nestjs/common';

/**
 * S14 — single kill switch for the on-device wearables lane (Apple Health on
 * iOS, Health Connect on Android).
 *
 * `FEATURE_WEARABLES_INGEST_POST` gates BOTH halves of the lane so one flag
 * turns it on or off as a unit:
 *  - `POST /v1/wearables/connections/on-device` (register the device source)
 *  - `POST /v1/wearables/samples/ingest`         (post normalized samples)
 *
 * Anything other than the literal string 'true' (case-insensitive) is OFF, so
 * an unset variable in production fails closed. When off, both routes return
 * a TYPED 503 (`wearables_ingest_disabled`) that the mobile client renders as
 * a plain "not available yet" state, never a spinner or a silent stub.
 */
export const WEARABLES_INGEST_FLAG = 'FEATURE_WEARABLES_INGEST_POST';

export function isOnDeviceIngestEnabled(): boolean {
  return process.env[WEARABLES_INGEST_FLAG]?.toLowerCase() === 'true';
}

export function assertOnDeviceIngestEnabled(): void {
  if (!isOnDeviceIngestEnabled()) {
    throw new ServiceUnavailableException({
      code: 'wearables_ingest_disabled',
      message: 'On-device sample ingest is currently disabled.',
    });
  }
}
