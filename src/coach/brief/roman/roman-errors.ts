// src/coach/brief/roman/roman-errors.ts
//
// A5-COACH-BRIEF — stable machine codes for the Roman drafts surface. Every
// error body carries `code` (stable, mobile maps it to specific copy) plus a
// human `message` that says what happened and what to do next.

import { HttpException, HttpStatus } from '@nestjs/common';

export type RomanDraftErrorCode =
  | 'reply_draft_not_found'
  | 'reply_draft_already_sent'
  | 'reply_draft_dismissed'
  | 'reply_draft_expired'
  | 'reply_draft_send_in_progress'
  | 'reply_draft_body_invalid'
  | 'reply_draft_recipient_blocked'
  | 'reply_draft_client_unavailable'
  | 'reply_draft_send_failed';

const STATUS: Record<RomanDraftErrorCode, HttpStatus> = {
  reply_draft_not_found: HttpStatus.NOT_FOUND,
  reply_draft_already_sent: HttpStatus.CONFLICT,
  reply_draft_dismissed: HttpStatus.CONFLICT,
  reply_draft_expired: HttpStatus.CONFLICT,
  reply_draft_send_in_progress: HttpStatus.CONFLICT,
  reply_draft_body_invalid: HttpStatus.BAD_REQUEST,
  reply_draft_recipient_blocked: HttpStatus.FORBIDDEN,
  reply_draft_client_unavailable: HttpStatus.GONE,
  reply_draft_send_failed: HttpStatus.BAD_GATEWAY,
};

const MESSAGE: Record<RomanDraftErrorCode, string> = {
  reply_draft_not_found:
    'This draft is no longer available. Pull to refresh to see current drafts.',
  reply_draft_already_sent: 'This reply was already sent. It is in the client thread.',
  reply_draft_dismissed: 'This draft was dismissed. Reply from the client thread instead.',
  reply_draft_expired:
    'This draft is out of date because the thread moved on. Refresh to get a fresh draft, or reply from the thread.',
  reply_draft_send_in_progress: 'This reply is already being sent. Wait a moment, then refresh.',
  reply_draft_body_invalid: 'The reply must be between 1 and 4000 characters.',
  reply_draft_recipient_blocked:
    'This reply cannot be sent because one of you has blocked the other.',
  reply_draft_client_unavailable:
    'This client is no longer on your roster, so the reply cannot be sent.',
  reply_draft_send_failed:
    'The reply was not sent. Your draft is kept; tap Send to try again, or contact support with the reference shown.',
};

export class RomanDraftError extends HttpException {
  readonly code: RomanDraftErrorCode;

  constructor(code: RomanDraftErrorCode, extra: Record<string, string> = {}) {
    super(
      { statusCode: STATUS[code], code, error: code, message: MESSAGE[code], ...extra },
      STATUS[code],
    );
    this.code = code;
  }
}
