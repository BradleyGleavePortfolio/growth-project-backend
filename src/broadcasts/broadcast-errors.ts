import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Stable machine codes for every A4 failure. The body is always
 * `{ code, message }`; the global HttpExceptionFilter keeps `code` on the
 * envelope and mobile maps each code to specific copy. Messages say what
 * happened and what to do next.
 */
export const BROADCAST_ERRORS = {
  'broadcast.not_found': [
    HttpStatus.NOT_FOUND,
    'This broadcast no longer exists. Pull to refresh your broadcasts.',
  ],
  'broadcast.not_editable': [
    HttpStatus.CONFLICT,
    'This broadcast is already sending or finished, so it can no longer be edited. Duplicate it to send a new one.',
  ],
  'broadcast.invalid_transition': [
    HttpStatus.CONFLICT,
    'This broadcast cannot change to that state right now. Refresh to see its current state.',
  ],
  'broadcast.body_invalid': [
    HttpStatus.BAD_REQUEST,
    'Write a message between 1 and 4000 characters.',
  ],
  'broadcast.timezone_invalid': [
    HttpStatus.BAD_REQUEST,
    'Choose a valid time zone for this schedule.',
  ],
  'broadcast.send_at_invalid': [
    HttpStatus.BAD_REQUEST,
    'Choose a send time in the future, within the next 12 months.',
  ],
  'broadcast.recurrence_invalid': [
    HttpStatus.BAD_REQUEST,
    'This repeat rule is not valid. Pick daily, weekly or monthly, a time, and the days it should repeat on.',
  ],
  'broadcast.segment_invalid': [
    HttpStatus.BAD_REQUEST,
    'This audience filter is not valid. Adjust the filters and try the preview again.',
  ],
  'broadcast.segment_ref_not_found': [
    HttpStatus.BAD_REQUEST,
    'One of the packages or programs in this audience is no longer in your library. Remove it and check the preview again.',
  ],
  'broadcast.no_recipients': [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'No clients match this audience right now. Widen the filters to include at least one client.',
  ],
  'broadcast.idempotency_conflict': [
    HttpStatus.CONFLICT,
    'A different broadcast was already sent with this request key. Refresh your broadcasts before sending again.',
  ],
  'broadcast.active_limit': [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'You have reached 50 scheduled broadcasts. Cancel or finish one before scheduling another.',
  ],
  'card.invalid': [
    HttpStatus.BAD_REQUEST,
    'This card is not valid. Choose a workout, meal plan, booking, package or check-in again.',
  ],
  'card.ref_not_found': [
    HttpStatus.BAD_REQUEST,
    'That item is no longer in your library, so it cannot be attached. Choose another one.',
  ],
  'card.meal_plan_client_specific': [
    HttpStatus.BAD_REQUEST,
    'This meal plan belongs to one client, so it cannot go to a group. Send it in that client’s thread or choose a template.',
  ],
  'saved_reply.not_found': [
    HttpStatus.NOT_FOUND,
    'This saved reply no longer exists. Pull to refresh your saved replies.',
  ],
  'saved_reply.invalid': [
    HttpStatus.BAD_REQUEST,
    'Give the saved reply a title up to 60 characters and a message up to 4000 characters.',
  ],
  'saved_reply.title_taken': [
    HttpStatus.CONFLICT,
    'You already have a saved reply with this title. Choose a different title.',
  ],
  'saved_reply.limit': [
    HttpStatus.UNPROCESSABLE_ENTITY,
    'You have 200 saved replies, the maximum. Delete one before adding another.',
  ],
  'client_tags.invalid': [
    HttpStatus.BAD_REQUEST,
    'Tags can be up to 32 letters, numbers, spaces, dashes or underscores, with at most 20 per client.',
  ],
  'client_tags.client_not_found': [
    HttpStatus.NOT_FOUND,
    'This client is not on your roster. Refresh your client list.',
  ],
} as const;

export type BroadcastErrorCode = keyof typeof BROADCAST_ERRORS;

export class BroadcastHttpError extends HttpException {
  readonly code: BroadcastErrorCode;
  constructor(code: BroadcastErrorCode, detail?: Record<string, unknown>) {
    const [status, message] = BROADCAST_ERRORS[code];
    super({ code, message, ...(detail ?? {}) }, status);
    this.code = code;
  }
}

export function broadcastError(
  code: BroadcastErrorCode,
  detail?: Record<string, unknown>,
): BroadcastHttpError {
  return new BroadcastHttpError(code, detail);
}
