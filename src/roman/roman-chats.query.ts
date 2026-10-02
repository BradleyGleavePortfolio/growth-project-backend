/**
 * Route-owned validation for GET /roman/sessions (Sol B-635-5).
 *
 * The global ValidationPipe (src/main.ts: whitelist, forbidNonWhitelisted,
 * transform) answers a DTO failure with an uncoded 400 whose message is a
 * class-validator string, before any route code runs. A second pipe cannot
 * fix that (the global rejection happens first). So the list route takes the
 * raw query object (a plain-object metatype, which the global pipe does not
 * validate) and this function validates it, just as strictly as the old DTO:
 * only `cursor`, `limit` and `surface`, each a single value; `limit` an
 * integer 1..100; `surface` `client` or `coach`; `cursor` at most 64
 * characters. Every rejection is a coded 400 with a next step:
 *
 *   - ROMAN_SESSIONS_QUERY_INVALID: unknown parameter, bad limit, bad
 *     surface. The app never sends these, so the copy says to refresh and
 *     update the app if it keeps happening.
 *   - ROMAN_CURSOR_INVALID: a cursor that is not a single short id (the same
 *     code and copy the service uses for a cursor that is not the caller's).
 *
 * The rejection happens before the service is called.
 */
import { BadRequestException } from '@nestjs/common';
import {
  ROMAN_CURSOR_INVALID_MESSAGE,
  ROMAN_ERROR_CURSOR_INVALID,
  ROMAN_ERROR_SESSIONS_QUERY_INVALID,
  ROMAN_SESSIONS_MAX_LIMIT,
} from './roman.constants';
import { ROMAN_SURFACES, RomanSurfaceDto } from './roman.dto';

/** Longest accepted cursor (a session id). */
export const ROMAN_SESSIONS_CURSOR_MAX_LENGTH = 64;

const ALLOWED_KEYS: ReadonlySet<string> = new Set(['cursor', 'limit', 'surface']);

export interface ListSessionsQuery {
  cursor?: string;
  limit?: number;
  surface?: RomanSurfaceDto;
}

const NEXT_STEP = 'Refresh the list, and update the app if this keeps happening.';

export const ROMAN_SESSIONS_LIMIT_INVALID_MESSAGE = `Your conversations could not be listed because the app asked for a page size the server does not accept (a whole number from 1 to ${ROMAN_SESSIONS_MAX_LIMIT}). ${NEXT_STEP}`;
export const ROMAN_SESSIONS_SURFACE_INVALID_MESSAGE = `Your conversations could not be listed because the app asked for a kind of chat the server does not know (client or coach). ${NEXT_STEP}`;
export const ROMAN_SESSIONS_UNKNOWN_PARAM_MESSAGE = `Your conversations could not be listed because the app sent a setting the server does not accept. ${NEXT_STEP}`;

function queryInvalid(message: string): BadRequestException {
  return new BadRequestException({ code: ROMAN_ERROR_SESSIONS_QUERY_INVALID, message });
}

function cursorInvalid(): BadRequestException {
  return new BadRequestException({
    code: ROMAN_ERROR_CURSOR_INVALID,
    message: ROMAN_CURSOR_INVALID_MESSAGE,
  });
}

function isSurface(v: string): v is RomanSurfaceDto {
  return (ROMAN_SURFACES as readonly string[]).includes(v);
}

export function parseListSessionsQuery(raw: unknown): ListSessionsQuery {
  const query: Record<string, unknown> =
    raw !== null && typeof raw === 'object' ? Object.fromEntries(Object.entries(raw)) : {};
  for (const key of Object.keys(query)) {
    if (!ALLOWED_KEYS.has(key)) throw queryInvalid(ROMAN_SESSIONS_UNKNOWN_PARAM_MESSAGE);
  }
  const out: ListSessionsQuery = {};

  const limit = query.limit;
  if (limit !== undefined) {
    if (typeof limit !== 'string' || !/^\d{1,3}$/.test(limit)) {
      throw queryInvalid(ROMAN_SESSIONS_LIMIT_INVALID_MESSAGE);
    }
    const n = Number(limit);
    if (n < 1 || n > ROMAN_SESSIONS_MAX_LIMIT)
      throw queryInvalid(ROMAN_SESSIONS_LIMIT_INVALID_MESSAGE);
    out.limit = n;
  }

  const surface = query.surface;
  if (surface !== undefined) {
    if (typeof surface !== 'string' || !isSurface(surface)) {
      throw queryInvalid(ROMAN_SESSIONS_SURFACE_INVALID_MESSAGE);
    }
    out.surface = surface;
  }

  const cursor = query.cursor;
  if (cursor !== undefined) {
    if (typeof cursor !== 'string' || cursor.length > ROMAN_SESSIONS_CURSOR_MAX_LENGTH) {
      throw cursorInvalid();
    }
    // An empty cursor means the first page (as before).
    if (cursor.length > 0) out.cursor = cursor;
  }
  return out;
}
