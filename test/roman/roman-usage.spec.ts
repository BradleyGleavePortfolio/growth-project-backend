// ROMANCOUNT (agent 145): 100 messages / 3 files / 5 changes a client a day,
// reset at their local midnight. Real Postgres: test/rls/roman-usage-daily-rls.spec.ts.
import 'reflect-metadata';
import { HttpException, HttpStatus } from '@nestjs/common';
import type { PrismaService } from '../../src/prisma.service';
import type { AuthedRequest } from '../../src/auth/auth-request';
import { consumeRomanUsage, romanUsageDay, romanUsageToday } from '../../src/roman/roman-usage';
import { RomanUsageController } from '../../src/roman/roman-usage.controller';
import { ROMAN_DAILY_LIMITS, romanRateLimitMessage } from '../../src/roman/roman.constants';
import { pickErrorDetails } from '../../src/filters/error-details';
import { fakeOf } from '../ai-egress/ai-egress.fakes';

const CLIENT = { id: 'rc-client', role: 'student' };
const AT = new Date('2026-10-14T06:30:00Z');

/** `$queryRaw` answers the atomic statement: a row back = counted. */
function fakeDb(counted: boolean, tz: string | null = null, row: unknown = null) {
  const $queryRaw = jest.fn(async (..._a: unknown[]) => (counted ? [{ '?column?': 1 }] : []));
  const find = jest.fn(async (..._a: unknown[]) => row);
  const db = fakeOf<Parameters<typeof consumeRomanUsage>[0]>({
    $queryRaw,
    notificationPreferences: {
      findUnique: jest.fn(async () => (tz ? { timezone: tz, timezone_updated_at: AT } : null)),
    },
    coachProfile: { findUnique: jest.fn(async () => null) },
    coachingSession: { findUnique: jest.fn(async () => null) },
    user: { findUnique: jest.fn(async () => ({ coach_id: null })) },
    romanUsageDaily: { findUnique: find },
  });
  return { db, $queryRaw, find };
}

async function refusal(p: Promise<unknown>): Promise<HttpException> {
  const err = await p.then(() => null).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(HttpException);
  return err as HttpException;
}

const day = (iso: string, tz: string) => romanUsageDay(new Date(iso), tz);
const reset = (iso: string, tz: string) => day(iso, tz).resetsAt.toISOString();

describe('ROMANCOUNT: the client local day; who counts', () => {
  it('zones and DST: each its own local day and real local midnight', () => {
    expect(day(AT.toISOString(), 'America/Los_Angeles').day).toBe('2026-10-13');
    expect(reset(AT.toISOString(), 'America/Los_Angeles')).toBe('2026-10-14T07:00:00.000Z');
    expect(day(AT.toISOString(), 'Europe/London').day).toBe('2026-10-14');
    expect(reset(AT.toISOString(), 'Europe/London')).toBe('2026-10-14T23:00:00.000Z');
    expect(reset(AT.toISOString(), 'Pacific/Auckland')).toBe('2026-10-14T11:00:00.000Z');
    expect(reset(AT.toISOString(), 'UTC')).toBe('2026-10-15T00:00:00.000Z');
    // DST: the real local midnight on 25-hour and 23-hour days.
    expect(reset('2026-11-01T12:00:00Z', 'America/New_York')).toBe('2026-11-02T05:00:00.000Z');
    expect(reset('2026-03-08T12:00:00Z', 'America/New_York')).toBe('2026-03-09T04:00:00.000Z');
    expect(reset('2026-03-29T00:30:00Z', 'Europe/London')).toBe('2026-03-29T23:00:00.000Z');
    expect(reset('2026-10-25T00:30:00Z', 'Europe/London')).toBe('2026-10-26T00:00:00.000Z');
  });

  it('coaches and the owner are never counted (only their AI credit pool limits them)', async () => {
    for (const role of ['coach', 'owner']) {
      const { db, $queryRaw } = fakeDb(false);
      await expect(consumeRomanUsage(db, { id: 'x', role }, 'chat_message', AT)).resolves.toBeUndefined();
      expect($queryRaw).not.toHaveBeenCalled();
    }
  });
});

describe('ROMANCOUNT: over the limit is the 429 ROMAN_RATE_LIMIT the app already shows', () => {
  it('messages: kind, resets_at, the wait in seconds and the existing copy', async () => {
    const err = await refusal(consumeRomanUsage(fakeDb(false, 'America/Los_Angeles').db, CLIENT, 'chat_message', AT));
    expect(err.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(err.getResponse()).toEqual({
      code: 'ROMAN_RATE_LIMIT',
      kind: 'messages',
      resets_at: '2026-10-14T07:00:00.000Z',
      retryAfterSeconds: 1800,
      message: romanRateLimitMessage(1800, 'student'),
    });
  });

  it('files and changes: the approved C3-S-37 and C3-S-38 copy', async () => {
    const files = await refusal(consumeRomanUsage(fakeDb(false).db, CLIENT, 'meal_photo', AT));
    expect(files.getResponse()).toMatchObject({
      kind: 'files',
      message:
        "You have sent Roman today's 3 files. Roman can take another file in about 18 hours. You can keep chatting with Roman, and your coach is in Messages any time.",
    });
    const changes = await refusal(consumeRomanUsage(fakeDb(false).db, CLIENT, 'roman_change', AT));
    expect(changes.getResponse()).toMatchObject({
      kind: 'changes',
      message:
        "Roman has made today's 5 changes for you. He can make another in about 18 hours. You can still log and edit everything yourself, and your coach is in Messages any time.",
    });
  });

  it('the error filter passes kind and resets_at to the app, nothing else', () => {
    const resets_at = '2026-10-14T07:00:00.000Z';
    const body = { kind: 'files', resets_at, retryAfterSeconds: 1800 };
    expect(pickErrorDetails(429, 'ROMAN_RATE_LIMIT', body)).toEqual({ kind: 'files', resets_at });
    expect(pickErrorDetails(429, 'ROMAN_RATE_LIMIT', { kind: 'other' })).toEqual({});
  });
});

describe('ROMANCOUNT: GET /me/roman/usage', () => {
  it("the client's own counts today, the limits and the reset; no row yet reads as zero", async () => {
    const { db, find } = fakeDb(true, 'Europe/London', { messages: 99, files: 2, changes: 4 });
    await expect(romanUsageToday(db, CLIENT.id, AT)).resolves.toEqual({
      day: '2026-10-14',
      used: { messages: 99, files: 2, changes: 4 },
      limits: { messages: 100, files: 3, changes: 5 },
      resets_at: '2026-10-14T23:00:00.000Z',
    });
    expect(find.mock.calls[0][0]).toMatchObject({ where: { client_id_day: { client_id: CLIENT.id } } });
    const none = await romanUsageToday(fakeDb(true).db, CLIENT.id, AT);
    expect(none.used).toEqual({ messages: 0, files: 0, changes: 0 });
  });

  it('clients only; a client with no coach gets 403 ROMAN_REQUIRES_COACH', async () => {
    expect(Reflect.getMetadata('roles', RomanUsageController.prototype.usage)).toEqual(['student']);
    const ctrl = new RomanUsageController(fakeOf<PrismaService>(fakeDb(true).db));
    const as = (coach_id: string | null) => fakeOf<AuthedRequest>({ user: { ...CLIENT, coach_id } });
    const err = await refusal(ctrl.usage(as(null)));
    expect([err.getStatus(), err.getResponse()]).toMatchObject([403, { code: 'ROMAN_REQUIRES_COACH' }]);
    await expect(ctrl.usage(as('c1'))).resolves.toMatchObject({ limits: ROMAN_DAILY_LIMITS });
  });
});
