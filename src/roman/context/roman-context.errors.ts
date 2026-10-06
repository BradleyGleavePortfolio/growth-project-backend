/**
 * B-651-10: copy and codes for GET /roman/context/me failures. Only the
 * client (students) reaches this route. Each message says what happened and
 * gives a working next step; no "we", no exclamation marks, no generic text.
 */

/** 503: a transient read failure (pool timeout, dropped link); retry works. */
export const ROMAN_ERROR_CONTEXT_UNAVAILABLE = 'ROMAN_CONTEXT_UNAVAILABLE';
export const ROMAN_CONTEXT_UNAVAILABLE_MESSAGE =
  'The view of what Roman can see could not load just now. Your plan and logs are safe. Try again in a moment, or open the Today tab to see them there.';

/** 500: an unexpected failure; support can trace it by the reference id. */
export const ROMAN_ERROR_CONTEXT_FAILED = 'ROMAN_CONTEXT_FAILED';
export const ROMAN_CONTEXT_FAILED_MESSAGE =
  'The view of what Roman can see could not load. Your plan and logs are safe and still open from the Today tab. If this keeps happening, contact support and quote the reference shown with this message.';
