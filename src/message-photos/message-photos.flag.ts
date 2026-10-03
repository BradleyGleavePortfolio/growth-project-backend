import { photoError } from './message-photos.errors';

/**
 * Kill switch for photos in coach <-> client messages (A6-PHOTOS).
 *
 * FEATURE_MESSAGE_PHOTOS defaults OFF: only the literal 'true' turns it on
 * (registered in src/common/env-validation.ts ENV_RULES, prod-switches.yml and
 * .github/fly-env-desired-state.json as "unset" until audit + device pass).
 * Read on every request, never boot-cached, so a runtime kill takes effect
 * without a redeploy.
 *
 * OFF gates every WRITE (upload intent, finalize, send with photos). Reads
 * stay on, like community voice notes: photos already sent keep rendering
 * (and stay reportable, deletable and erasable) if the surface is killed
 * mid-rollout, so no message silently turns into an empty bubble.
 */
export const FEATURE_MESSAGE_PHOTOS = 'FEATURE_MESSAGE_PHOTOS';

export function messagePhotosEnabled(): boolean {
  return process.env[FEATURE_MESSAGE_PHOTOS] === 'true';
}

export function assertMessagePhotosEnabled(): void {
  if (!messagePhotosEnabled()) throw photoError('message_photo.disabled');
}
