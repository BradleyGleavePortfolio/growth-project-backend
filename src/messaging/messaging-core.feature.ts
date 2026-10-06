/**
 * A3-MSG-CORE — `FEATURE_MESSAGING_CORE_V2` kill switch (DEFAULT OFF).
 *
 * Gates every new user-facing surface on the canonical 1:1 thread
 * (CoachMessage): the unified inbox, edit, delete, swipe-reply, message pins,
 * per-thread mute, inbox pins, read-up-to and the `thread-updated` realtime
 * ping. While OFF:
 *   - every new route answers 503 `messaging.feature_disabled` (specific copy
 *     on mobile; the mobile surface is also hidden through
 *     GET /me/feature-flags `messaging_core_v2`);
 *   - the existing thread read/send/read-marker routes behave byte-for-byte as
 *     before (no reply include, no tombstone mapping, no mute lookup).
 *
 * Send idempotency (`client_message_id` / `Idempotency-Key`) is NOT gated: it
 * is a correctness guarantee for any retrying client, not a surface.
 *
 * ON only when the env value is exactly `'true'` (case-insensitive). Read at
 * the call site on every request (never boot-cached) so a flip needs no
 * redeploy. Registered in src/common/env-validation.ts ENV_RULES.
 */
import { CanActivate, HttpStatus, Injectable } from '@nestjs/common';
import { messagingError, MESSAGING_ERRORS } from './messaging-errors';

export const FEATURE_MESSAGING_CORE_V2_ENV = 'FEATURE_MESSAGING_CORE_V2';

export function isMessagingCoreV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[FEATURE_MESSAGING_CORE_V2_ENV] ?? '').toLowerCase() === 'true';
}

/** Route guard for the new messaging surfaces: 503 with a stable code when OFF. */
@Injectable()
export class MessagingCoreV2Guard implements CanActivate {
  canActivate(): boolean {
    if (!isMessagingCoreV2Enabled()) {
      throw messagingError(HttpStatus.SERVICE_UNAVAILABLE, MESSAGING_ERRORS.FEATURE_DISABLED);
    }
    return true;
  }
}
