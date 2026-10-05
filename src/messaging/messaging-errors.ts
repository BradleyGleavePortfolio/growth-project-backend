import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * A3-MSG-CORE — stable machine codes for the canonical 1:1 thread actions.
 *
 * Every error body carries `code` (stable, namespaced, never reworded),
 * `error` (the same value, for the legacy mobile reader that keys on `error`
 * like NO_COACH_ASSIGNED / BLOCKED) and `message` (plain human text that says
 * what happened and what to do next). Mobile maps `code` to its own copy; the
 * message is the fallback for API consumers. No user content, ids or PII ever
 * appear in a message.
 */
export const MESSAGING_ERRORS = {
  FEATURE_DISABLED: {
    code: 'messaging.feature_disabled',
    message:
      'This messaging feature is switched off right now. Your conversation is safe; update the app or check back later.',
  },
  MESSAGE_NOT_FOUND: {
    code: 'messaging.message_not_found',
    message:
      'That message is no longer in this conversation. Refresh the conversation to see the latest messages.',
  },
  NOT_AUTHOR: {
    code: 'messaging.not_author',
    message: 'Only the person who sent a message can change or delete it.',
  },
  MESSAGE_DELETED: {
    code: 'messaging.message_deleted',
    message: 'That message was deleted, so it can no longer be changed, pinned or replied to.',
  },
  EDIT_WINDOW_CLOSED: {
    code: 'messaging.edit_window_closed',
    message:
      'Messages can be edited for 48 hours after sending. Send a new message with the correction instead.',
  },
  DELETE_WINDOW_CLOSED: {
    code: 'messaging.delete_window_closed',
    message:
      'Messages can be deleted for 48 hours after sending. Contact support if this message needs to be removed.',
  },
  NOT_EDITABLE: {
    code: 'messaging.not_editable',
    message: 'A voice note without text cannot be edited. Delete it and record a new one instead.',
  },
  EDIT_EMPTY: {
    code: 'messaging.edit_empty',
    message:
      'An edited message needs some text. To remove the message entirely, delete it instead.',
  },
  BLOCKED: {
    code: 'messaging.blocked',
    message:
      'This conversation is blocked, so messages cannot be sent, edited or pinned. Unblock in Settings to continue.',
  },
  REPLY_TARGET_UNAVAILABLE: {
    code: 'messaging.reply_target_unavailable',
    message:
      'The message you replied to is no longer available. Send your message without the quote.',
  },
  PIN_LIMIT_REACHED: {
    code: 'messaging.pin_limit_reached',
    message: 'This conversation already has 10 pinned messages. Unpin one to pin another.',
  },
  INBOX_PIN_LIMIT_REACHED: {
    code: 'messaging.inbox_pin_limit_reached',
    message: 'You can pin up to 5 conversations. Unpin one to pin this conversation.',
  },
  IDEMPOTENCY_KEY_REUSED: {
    code: 'messaging.idempotency_key_reused',
    message:
      'This message was already sent to a different conversation. Send it again as a new message.',
  },
  IDEMPOTENCY_KEY_INVALID: {
    code: 'messaging.idempotency_key_invalid',
    message:
      'The message could not be matched to a send attempt. Update the app and send it again.',
  },
  IDEMPOTENCY_KEY_MISMATCH: {
    code: 'messaging.idempotency_key_mismatch',
    message: 'The message carried two different send ids. Update the app and send it again.',
  },
} as const;

export type MessagingErrorSpec = (typeof MESSAGING_ERRORS)[keyof typeof MESSAGING_ERRORS];

export type MessagingErrorCode = MessagingErrorSpec['code'];

/** Build an HttpException carrying `{ error, code, message }`. */
export function messagingError(
  status: HttpStatus,
  spec: MessagingErrorSpec,
  extra: Record<string, string | number | boolean | null> = {},
): HttpException {
  return new HttpException(
    { statusCode: status, error: spec.code, code: spec.code, message: spec.message, ...extra },
    status,
  );
}
