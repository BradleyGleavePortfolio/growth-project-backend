import { HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma.service';
import { resolveRecipientTimeZone } from '../notifications/recipient-timezone';
import { addDays, dateOnly, localClock, localDayStart } from './context/roman-client-context.service';
import {
  ROMAN_DAILY_LIMITS, ROMAN_ERROR_RATE_LIMIT, type RomanUsageKind, romanDailyLimitMessage, romanRateLimitMessage,
} from './roman.constants';

/**
 * ROMANCOUNT: each client's daily Roman limits (owner: 100 messages, 3 file
 * uploads, 5 changes made by Roman, the same for every client). What counts
 * (ROMANCAP-C Option 1) is this one table; null = never counted:
 * (a) coach-approved change, (b) Roman's private notes, (d) voice-logged set,
 * (e) coach import screen, and safety replies. (c) A meal photo that also
 * logs food is 1 file. (f) A client locked out for not paying their coach
 * keeps the chat (counted as usual) but Roman loses their background context
 * (RomanService.streamAssistantTurn).
 */
export const ROMAN_USAGE_KIND_OF = {
  chat_message: 'messages',
  file_upload: 'files',
  meal_photo: 'files',
  roman_change: 'changes',
  coach_approved_change: null,
  private_note: null,
  voice_logged_set: null,
  coach_import: null,
  safety_reply: null,
} as const satisfies Record<string, RomanUsageKind | null>;
export type RomanUsageEvent = keyof typeof ROMAN_USAGE_KIND_OF;
export type RomanUsageCaller = { id: string; role: string };

type UsageDb = Pick<
  PrismaService,
  '$queryRaw' | 'romanUsageDaily' | 'notificationPreferences' | 'coachProfile' | 'coachingSession' | 'user'
>;

/** The local day (YYYY-MM-DD) of `now` in `timeZone` and its end, DST-safe. */
export function romanUsageDay(now: Date, timeZone: string): { day: string; resetsAt: Date } {
  const day = localClock(now, timeZone).local_date;
  return { day, resetsAt: localDayStart(addDays(day, 1), timeZone) };
}

/** The client's day: their own zone (recipient-timezone.ts rules), else UTC. */
const clientDay = async (db: UsageDb, clientId: string, now: Date) =>
  romanUsageDay(now, (await resolveRecipientTimeZone(db, clientId)) ?? 'UTC');

/**
 * Count one Roman event for a client, or refuse it. One atomic statement, so
 * two requests at the limit never both pass. Over the limit: today's 429
 * ROMAN_RATE_LIMIT plus `kind` and `resets_at`. Coaches and owners are never
 * counted (only their AI credit pool limits them).
 */
export async function consumeRomanUsage(
  db: UsageDb,
  caller: RomanUsageCaller,
  event: RomanUsageEvent,
  now: Date = new Date(),
): Promise<void> {
  const kind = ROMAN_USAGE_KIND_OF[event];
  if (!kind || caller.role !== 'student') return;
  const { day, resetsAt } = await clientDay(db, caller.id, now);
  const col = Prisma.raw(`"${kind}"`);
  const limit = ROMAN_DAILY_LIMITS[kind];
  const counted = await db.$queryRaw<unknown[]>`
    INSERT INTO "roman_usage_daily" ("client_id", "day", ${col}, "updated_at")
    VALUES (${caller.id}, ${day}::date, 1, CURRENT_TIMESTAMP)
    ON CONFLICT ("client_id", "day") DO UPDATE
      SET ${col} = "roman_usage_daily".${col} + 1, "updated_at" = CURRENT_TIMESTAMP
      WHERE "roman_usage_daily".${col} < ${limit}
    RETURNING 1`;
  if (counted.length > 0) return;
  const retryAfterSeconds = Math.max(1, Math.ceil((resetsAt.getTime() - now.getTime()) / 1000));
  const message =
    kind === 'messages'
      ? romanRateLimitMessage(retryAfterSeconds, caller.role)
      : romanDailyLimitMessage(kind, retryAfterSeconds);
  const body = { code: ROMAN_ERROR_RATE_LIMIT, kind, resets_at: resetsAt.toISOString(), retryAfterSeconds, message };
  throw new HttpException(body, HttpStatus.TOO_MANY_REQUESTS);
}

/** GET /me/roman/usage: today's counts, the limits and the reset. */
export async function romanUsageToday(db: UsageDb, clientId: string, now: Date = new Date()) {
  const { day, resetsAt } = await clientDay(db, clientId, now);
  const row = await db.romanUsageDaily.findUnique({
    where: { client_id_day: { client_id: clientId, day: dateOnly(day) } },
    select: { messages: true, files: true, changes: true },
  });
  return {
    day,
    used: { messages: row?.messages ?? 0, files: row?.files ?? 0, changes: row?.changes ?? 0 },
    limits: ROMAN_DAILY_LIMITS,
    resets_at: resetsAt.toISOString(),
  };
}
