import { HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma.service';
import { resolveRecipientTimeZone } from '../notifications/recipient-timezone';
import { addDays, localClock, localDayStart } from './context/roman-client-context.service';
import {
  ROMAN_DAILY_LIMITS, ROMAN_ERROR_RATE_LIMIT, type RomanUsageKind, romanDailyLimitMessage, romanRateLimitMessage,
} from './roman.constants';

/**
 * ROMANCOUNT: each client's daily Roman limits (owner: 100 messages, 3 file
 * uploads, 5 changes made by Roman). What counts (ROMANCAP-C Option 1) is this
 * one table; null = never counted: (a), (b), (d), (e) and safety replies.
 * (c) a meal photo that also logs food is 1 file. (f) a client locked out for
 * not paying their coach keeps the chat but loses Roman's context (RomanService).
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
  '$queryRaw' | 'notificationPreferences' | 'coachProfile' | 'coachingSession' | 'user'
>;

/** The local day (YYYY-MM-DD) of `now` in `timeZone` and its end, DST-safe. */
export function romanUsageDay(now: Date, timeZone: string): { day: string; resetsAt: Date } {
  const day = localClock(now, timeZone).local_date;
  return { day, resetsAt: localDayStart(addDays(day, 1), timeZone) };
}

/** The client's day: their own zone (recipient-timezone.ts rules), else UTC. */
const clientDay = async (db: UsageDb, clientId: string, now: Date) =>
  romanUsageDay(now, (await resolveRecipientTimeZone(db, clientId)) ?? 'UTC');

/** One counted event, so a turn refused before any reply can give it back. */
export type RomanUsageDebit = { clientId: string; kind: RomanUsageKind; day: string };

/**
 * Count one Roman event for a client, or refuse it. One atomic statement, so
 * two requests at the limit never both pass. Over the limit: today's 429
 * ROMAN_RATE_LIMIT plus `kind` and `resets_at`. Coaches and owners are never
 * counted (only their AI credit pool limits them). `peek` (an eating-disorder-
 * risk turn): the same statement adds 0, so it is refused at the limit, never counted.
 */
export async function consumeRomanUsage(
  db: UsageDb,
  caller: RomanUsageCaller,
  event: RomanUsageEvent,
  now: Date = new Date(),
  peek = false,
): Promise<RomanUsageDebit | null> {
  const kind = ROMAN_USAGE_KIND_OF[event];
  if (!kind || caller.role !== 'student') return null;
  const { day, resetsAt } = await clientDay(db, caller.id, now);
  const col = Prisma.raw(`"${kind}"`);
  const limit = ROMAN_DAILY_LIMITS[kind];
  const step = peek ? 0 : 1;
  const counted = await db.$queryRaw<unknown[]>`
    INSERT INTO "roman_usage_daily" ("client_id", "day", ${col}, "updated_at")
    VALUES (${caller.id}, ${day}::date, ${step}, CURRENT_TIMESTAMP)
    ON CONFLICT ("client_id", "day") DO UPDATE
      SET ${col} = "roman_usage_daily".${col} + ${step}, "updated_at" = CURRENT_TIMESTAMP
      WHERE "roman_usage_daily".${col} < ${limit}
    RETURNING 1`;
  if (counted.length > 0) return peek ? null : { clientId: caller.id, kind, day };
  const retryAfterSeconds = Math.max(1, Math.ceil((resetsAt.getTime() - now.getTime()) / 1000));
  const message =
    kind === 'messages'
      ? romanRateLimitMessage(retryAfterSeconds, caller.role)
      : romanDailyLimitMessage(kind, retryAfterSeconds);
  const body = { code: ROMAN_ERROR_RATE_LIMIT, kind, resets_at: resetsAt.toISOString(), retryAfterSeconds, message };
  throw new HttpException(body, HttpStatus.TOO_MANY_REQUESTS);
}

/** Give a counted event back, inside the refusing transaction. */
export function releaseRomanUsage(tx: Pick<Prisma.TransactionClient, '$executeRaw'>, debit: RomanUsageDebit) {
  const col = Prisma.raw(`"${debit.kind}"`);
  return tx.$executeRaw`UPDATE "roman_usage_daily" SET ${col} = ${col} - 1, "updated_at" = CURRENT_TIMESTAMP
    WHERE "client_id" = ${debit.clientId} AND "day" = ${debit.day}::date AND ${col} > 0`;
}
