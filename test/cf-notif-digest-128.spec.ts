// CF-NOTIF-DIGEST-128 (FW-NOTIF-128 U6 + owner default): client digest emails
// state true numbers, and the client DAILY digest is off by default.
//
// Fails on main: the daily client digest went to every client each morning;
// the window covered 8 days ("8 / 7", 114%); the current streak was the
// 7-day count and the personal best was the same number; weight was always
// printed in lbs; the weekly change used the first two weigh-ins; and every
// client digest left an inbox row ("has been sent to <email>").

import { ConfigService } from '@nestjs/config';
import { DigestService } from '../src/notifications/digest.service';
import {
  checkInDaysInWindow,
  checkInStreaks,
  digestWindow,
  formatWeight,
  formatWeightChange,
} from '../src/notifications/digest-stats';
import { NotificationsService } from '../src/notifications/notifications.service';
import { PrismaService } from '../src/prisma.service';

const NOW = new Date('2026-10-11T08:00:00Z'); // Sunday, weekly cron time
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const range = (from: string, to: string) => {
  const out: Date[] = [];
  for (let d = day(from); d <= day(to); d = new Date(d.getTime() + 86_400_000)) out.push(d);
  return out;
};

// Check-ins every day 3..11 Oct (9 days, today included) plus a 12-day run in September.
const CHECK_INS = [...range('2026-10-03', '2026-10-11'), ...range('2026-09-01', '2026-09-12')];
const WEIGH_INS = [
  { date: day('2026-10-03'), weight_lbs: 210 }, // before the window
  { date: day('2026-10-04'), weight_lbs: 200 },
  { date: day('2026-10-06'), weight_lbs: 199 },
  { date: day('2026-10-10'), weight_lbs: 195.6 },
];
const WORKOUTS = [day('2026-10-03'), day('2026-10-05'), day('2026-10-11')];

type DateFilter = { gte?: Date; lt?: Date };
const inRange = (d: Date, f?: DateFilter) =>
  (!f?.gte || d >= f.gte) && (!f?.lt || d < f.lt);

function fakePrisma(weightUnit: string | null) {
  const prisma = Object.create(PrismaService.prototype);
  const users = { findMany: jest.fn(async () => [{ id: 'client-1', email: 'c@example.com', name: 'Sam Lee' }]) };
  Object.defineProperty(prisma, 'user', {
    value: {
      ...users,
      findUnique: async () => ({ coach: { name: 'Alex Morgan' }, profile: { weight_unit: weightUnit } }),
    },
  });
  Object.defineProperty(prisma, 'checkIn', {
    value: {
      findMany: async ({ where }: { where: { date?: DateFilter } }) =>
        CHECK_INS.filter((d) => inRange(d, where.date))
          .sort((a, b) => b.getTime() - a.getTime())
          .map((date) => ({ date })),
    },
  });
  Object.defineProperty(prisma, 'weightLog', {
    value: {
      findMany: async ({ where, take }: { where: { date?: DateFilter }; take?: number }) =>
        WEIGH_INS.filter((w) => inRange(w.date, where.date))
          .slice(0, take ?? WEIGH_INS.length)
          .map((w) => ({ ...w })),
      findFirst: async () => ({ ...WEIGH_INS[WEIGH_INS.length - 1] }),
    },
  });
  Object.defineProperty(prisma, 'workoutSession', {
    value: { count: async ({ where }: { where: { date?: DateFilter } }) => WORKOUTS.filter((d) => inRange(d, where.date)).length },
  });
  return { prisma, users };
}

function service(env: Record<string, string>, weightUnit: string | null = 'lbs') {
  const { prisma, users } = fakePrisma(weightUnit);
  const notifications = Object.create(NotificationsService.prototype);
  const createNotification = jest.fn(async () => ({}));
  Object.defineProperty(notifications, 'claimDigestWindow', { value: async () => 'log-1' });
  Object.defineProperty(notifications, 'markDigestSent', { value: async () => undefined });
  Object.defineProperty(notifications, 'markDigestFailed', { value: async () => undefined });
  Object.defineProperty(notifications, 'createNotification', { value: createNotification });
  const svc = new DigestService(prisma, notifications, new ConfigService(env));
  const build = svc['_buildClientDigestData'].bind(svc);
  Object.defineProperty(svc, '_buildClientDigestData', {
    value: (id: string, type: 'daily' | 'weekly') => build(id, type, NOW),
  });
  return { svc, users, createNotification };
}

const LIVE = {
  EMAIL_TRANSPORT: 'resend',
  RESEND_API_KEY: 're_test',
  EMAIL_FROM_ADDRESS: 'The Growth Project <noreply@growthprojectapp.com>',
  EMAIL_DIGEST_COACH_ENABLED: 'off',
};

async function sentHtml(svc: DigestService, type: 'daily' | 'weekly'): Promise<string> {
  const fetchMock = jest
    .spyOn(global, 'fetch')
    .mockResolvedValue(new Response('{"id":"m"}', { status: 200 }));
  fetchMock.mockClear(); // one spy per test file run; count this send only
  await svc['_sendClientDigest'](
    { id: 'client-1', email: 'c@example.com', name: 'Sam Lee' },
    `${type}_client`,
    '2026-10-11',
    type,
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
  return String(body.html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

afterEach(() => jest.restoreAllMocks());

describe('digest-stats (pure)', () => {
  it('the window is the 7 complete days before the send day, so the count never passes 7', () => {
    const { start, end } = digestWindow(NOW);
    expect(start.toISOString()).toBe('2026-10-04T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-11T00:00:00.000Z');
    expect(checkInDaysInWindow(CHECK_INS, start, end)).toBe(7);
  });

  it('streaks are consecutive days: current ends today or yesterday, best is the longest run', () => {
    expect(checkInStreaks(CHECK_INS, NOW)).toEqual({ current: 9, best: 12 });
    expect(checkInStreaks(range('2026-10-01', '2026-10-09'), NOW)).toEqual({ current: 0, best: 9 });
    expect(checkInStreaks([day('2026-10-10'), day('2026-10-08')], NOW)).toEqual({ current: 1, best: 1 });
    expect(checkInStreaks([], NOW)).toEqual({ current: 0, best: 0 });
  });

  it('weight in the client unit; the change runs from the first to the last weigh-in', () => {
    expect(formatWeight(195.6, 'lbs')).toBe('195.6 lbs');
    expect(formatWeight(195.6, 'kg')).toBe('88.7 kg');
    expect(formatWeightChange([200, 199, 195.6], 'lbs')).toBe('-4.4 lbs');
    expect(formatWeightChange([200, 199, 195.6], 'kg')).toBe('-2.0 kg');
    expect(formatWeightChange([180, 181.2], 'lbs')).toBe('+1.2 lbs');
    expect(formatWeightChange([180, 180.02], 'lbs')).toBe('0.0 lbs');
    expect(formatWeightChange([180], 'lbs')).toBeNull();
  });
});

describe('client digest emails (DigestService)', () => {
  it('daily client digest is off by default; only EMAIL_DIGEST_CLIENT_DAILY_ENABLED=on sends it', async () => {
    const off = service({ ...LIVE });
    await off.svc.sendClientDailyDigests();
    expect(off.users.findMany).not.toHaveBeenCalled();

    const on = service({ ...LIVE, EMAIL_DIGEST_CLIENT_DAILY_ENABLED: 'on' });
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{"id":"m"}', { status: 200 }));
    await on.svc.sendClientDailyDigests();
    expect(on.users.findMany).toHaveBeenCalledTimes(1);

    const killed = service({ ...LIVE, EMAIL_DIGEST_CLIENT_DAILY_ENABLED: 'on', EMAIL_DIGEST_CLIENT_ENABLED: 'off' });
    await killed.svc.sendClientDailyDigests();
    expect(killed.users.findMany).not.toHaveBeenCalled();
  });

  it('weekly client digest is kept by default', async () => {
    const { svc, users } = service({ ...LIVE });
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{"id":"m"}', { status: 200 }));
    await svc.sendWeeklyDigests();
    expect(users.findMany).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('no inbox row is written for a client digest', async () => {
    const { svc, createNotification } = service({ ...LIVE });
    await sentHtml(svc, 'weekly');
    await sentHtml(svc, 'daily');
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('weekly email: 7 / 7, 100%, workouts in the window, true streaks, change in lbs', async () => {
    const text = await sentHtml(service({ ...LIVE }).svc, 'weekly');
    expect(text).toContain('week ending 10 October 2026');
    expect(text).toContain('Check-ins logged 7 / 7');
    expect(text).toContain('100%');
    expect(text).toContain('Workouts logged 1');
    expect(text).toContain('Weight change this week -4.4 lbs');
    expect(text).toContain('Current check-in streak 9 days');
    expect(text).toContain('Personal best streak 12 days');
    expect(text).not.toMatch(/8 \/ 7|114%/);
  });

  it('weekly and daily emails use kg for a client whose profile unit is kg', async () => {
    const weekly = await sentHtml(service({ ...LIVE }, 'kg').svc, 'weekly');
    expect(weekly).toContain('Weight change this week -2.0 kg');
    expect(weekly).not.toContain('lbs');
    const daily = await sentHtml(service({ ...LIVE }, 'kg').svc, 'daily');
    expect(daily).toContain('Last logged weight 88.7 kg');
    expect(daily).not.toContain('lbs');
  });

  it('daily email (when switched on): last 7 days and the current streak, no duplicate Streaks section', async () => {
    const text = await sentHtml(service({ ...LIVE }).svc, 'daily');
    expect(text).toContain('Check-ins in the last 7 days 7 of 7');
    expect(text).toContain('Current check-in streak 9 days');
    expect(text).toContain('Last logged weight 195.6 lbs');
    expect(text).not.toMatch(/8 of 7|Streaks/);
  });
});
