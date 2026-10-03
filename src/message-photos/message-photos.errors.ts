import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Stable machine codes for every message-photo failure (A6-PHOTOS).
 *
 * Body shape (same as the community module): `{ error, code, message }` where
 * `error` and `code` carry the same stable code and `message` says what
 * happened and what to do next. The mobile app maps `code` to its own copy;
 * the server message is the fallback. Plain words, no exclamation marks, no
 * "we/us".
 */
export const PHOTO_ERRORS = {
  'message_photo.disabled': {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message: 'Photos are not available in messages yet. You can still send text.',
  },
  'message_photo.type_unsupported': {
    status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    message: 'This file type cannot be sent. Choose a JPEG, PNG or WebP photo.',
  },
  'message_photo.too_large': {
    status: HttpStatus.PAYLOAD_TOO_LARGE,
    message: 'This photo is larger than 15 MB. Choose a smaller photo or take a new one.',
  },
  'message_photo.not_found': {
    status: HttpStatus.NOT_FOUND,
    message: 'This photo is no longer available. Choose the photo again to send it.',
  },
  'message_photo.upload_missing': {
    status: HttpStatus.CONFLICT,
    message: 'The photo did not finish uploading. Tap retry to upload it again.',
  },
  'message_photo.upload_expired': {
    status: HttpStatus.GONE,
    message: 'The upload took too long and expired. Tap retry to upload the photo again.',
  },
  'message_photo.not_an_image': {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'This file could not be read as a photo. Choose a different photo.',
  },
  'message_photo.dimensions_out_of_range': {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'This photo is too large to display. Choose a smaller photo or a screenshot of it.',
  },
  'message_photo.processing': {
    status: HttpStatus.CONFLICT,
    message: 'This photo is still being prepared. Wait a moment, then tap retry.',
  },
  'message_photo.storage_unavailable': {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message: 'Photo storage is not responding right now. Tap retry in a minute.',
  },
  'message_photo.rejected': {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'This photo cannot be sent because it does not meet the community guidelines.',
  },
  'message_photo.not_ready': {
    status: HttpStatus.CONFLICT,
    message:
      'A photo in this message has not finished uploading. Wait for it to finish, then send.',
  },
  'message_photo.already_attached': {
    status: HttpStatus.CONFLICT,
    message:
      'This photo was already sent in another message. Choose it again to send it once more.',
  },
  'message_photo.limit_exceeded': {
    status: HttpStatus.BAD_REQUEST,
    message: 'A message can hold up to 10 photos. Remove some, then send.',
  },
  'message_photo.pending_limit': {
    status: HttpStatus.TOO_MANY_REQUESTS,
    message: 'Several photos are still uploading. Wait for them to finish, then add more.',
  },
  'message_photo.blocked': {
    status: HttpStatus.FORBIDDEN,
    message: 'Photos cannot be sent in this conversation because one of you has blocked the other.',
  },
  'message_photo.removed': {
    status: HttpStatus.GONE,
    message: 'This photo was removed and can no longer be viewed.',
  },
  'message_photo.hidden': {
    status: HttpStatus.FORBIDDEN,
    message: 'You reported this photo, so it is hidden for you while it is reviewed.',
  },
  'message_photo.not_sender': {
    status: HttpStatus.FORBIDDEN,
    message: 'Only the person who sent this photo can delete it. You can report it instead.',
  },
  'message_photo.report_not_found': {
    status: HttpStatus.NOT_FOUND,
    message: 'This report was not found or was already closed. Refresh the queue.',
  },
} as const;

export type PhotoErrorCode = keyof typeof PHOTO_ERRORS;

export class MessagePhotoException extends HttpException {
  constructor(
    readonly code: PhotoErrorCode,
    extra: Record<string, string | number | boolean> = {},
  ) {
    const def = PHOTO_ERRORS[code];
    super({ error: code, code, message: def.message, ...extra }, def.status);
  }
}

export function photoError(
  code: PhotoErrorCode,
  extra?: Record<string, string | number | boolean>,
): MessagePhotoException {
  return new MessagePhotoException(code, extra);
}
