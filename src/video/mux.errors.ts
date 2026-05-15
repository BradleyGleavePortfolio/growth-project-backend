/**
 * Mux-specific errors thrown by MuxService.
 *
 * `MuxDisabledError` is the load-bearing one — it propagates up to the
 * controllers, which translate it into a 503 with body
 *   { error: 'mux_disabled', action: '...' }
 *
 * Mobile contract (per growth-project-mobile feat/video-library-v1-mobile):
 * the detail endpoint must NOT return this error on missing-config —
 * instead `playbackUrl: null` is the user-facing signal that "no video
 * yet". Only the owner attach + upload routes 503 with `mux_disabled`,
 * because those routes intrinsically cannot work without Mux.
 */

export class MuxDisabledError extends Error {
  readonly code = 'mux_disabled';
  constructor(action: string) {
    super(`Mux is not configured. ${action}`);
    this.name = 'MuxDisabledError';
    Object.defineProperty(this, 'action', { value: action, enumerable: true });
  }
  readonly action!: string;
}

export class MuxApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'MuxApiError';
  }
}
