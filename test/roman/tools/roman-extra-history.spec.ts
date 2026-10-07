// R11-T1b: read_history's extra kinds (health_day, fasting, roman_chat, community_post) read the caller's rows only,
// with numbers computed in code. The doubles return fixed rows; the tests assert the where clauses.

import { RomanReadToolbox } from '../../../src/roman/tools/roman-read-tools';
import type { RomanTimelineReader } from '../../../src/roman/memory/roman-timeline.reader';
import type { PrismaService } from '../../../src/prisma.service';
import { fakeOf } from '../../ai-egress/ai-egress.fakes';

const NOW = new Date('2026-10-06T19:00:00.000Z'); // 12:00 in Los Angeles
const T = (iso: string) => new Date(iso);
const sample = (metric: string, provider: string, value: number, start: string, end = start) =>
  ({ metric, provider, value, start_at: T(start), end_at: T(end), recorded_at: T(end), source_tz: null });

function setup(samples = [sample('SPO2_PCT', 'OURA', 97, '2026-10-01T15:00:00Z')]) {
  const fasts = [
    { start_time: T('2026-10-02T03:00:00Z'), end_time: T('2026-10-02T19:30:00Z'), protocol: '16:8', notes: 'felt fine' },
    { start_time: T('2026-10-02T22:00:00Z'), end_time: null, protocol: null, notes: null },
  ];
  const chats = [
    { created_at: T('2026-10-01T16:00:00Z'), role: 'user', content: 'How was my sleep?' },
    { created_at: T('2026-10-01T16:00:05Z'), role: 'roman', content: 'x'.repeat(400) },
  ];
  const posts = [{ created_at: T('2026-10-02T01:00:00Z'), scope: 'workspace', title: 'Week 3', body: 'New squat best' }];
  const prisma = {
    user: { findUnique: jest.fn(async () => ({ deleted_at: null, notification_prefs: { timezone: 'America/Los_Angeles' } })) },
    wearableSample: { findMany: jest.fn(async (_a: { where: unknown }) => samples) },
    wearableUserMetricPreference: {
      findMany: jest.fn(async (_a: { where: unknown }) => [{ metric: 'SLEEP_DEEP_MIN', preferred_provider: 'APPLE_HEALTH' }]),
    },
    fastingWindow: { findMany: jest.fn(async (_a: { where: unknown }) => fasts) },
    romanMessage: { findMany: jest.fn(async (_a: { where: unknown }) => chats) },
    communityPost: { findMany: jest.fn(async (_a: { where: unknown }) => posts) },
  };
  const timeline = { read: jest.fn(async () => ({ client_id: 'client-a', events: [], next_cursor: null, truncated: [] })) };
  const box = new RomanReadToolbox(fakeOf<PrismaService>(prisma), fakeOf<RomanTimelineReader>(timeline));
  const run = (input: unknown) => box.run({ id: 'client-a', role: 'student' }, 'read_history', input, { now: NOW });
  return { prisma, timeline, run };
}
const KINDS = ['health_day', 'fasting', 'roman_chat', 'community_post'];
const WINDOW = { from: '2026-10-01', to: '2026-10-02' };

describe('R11-T1b read_history extra kinds', () => {
  it('reads health, fasting and Roman chats for the caller only, merged by local date and time', async () => {
    const t = setup([
      // Sleep is the day it ends; the preferred provider wins (OURA ignored); the day after the window is dropped.
      sample('SLEEP_DEEP_MIN', 'APPLE_HEALTH', 60, '2026-10-01T06:00:00Z', '2026-10-01T13:00:00Z'),
      sample('SLEEP_DEEP_MIN', 'APPLE_HEALTH', 30.4, '2026-10-01T09:00:00Z', '2026-10-01T12:00:00Z'),
      sample('SLEEP_DEEP_MIN', 'OURA', 200, '2026-10-01T06:00:00Z', '2026-10-01T13:00:00Z'),
      sample('SLEEP_ONSET_ISO', 'APPLE_HEALTH', 1395, '2026-10-01T06:00:00Z', '2026-10-01T13:00:00Z'),
      sample('BODY_WEIGHT_KG', 'WITHINGS', 80, '2026-10-02T14:00:00Z'),
      sample('BODY_WEIGHT_KG', 'WITHINGS', 81, '2026-10-02T15:00:00Z'),
      sample('WORKOUT_DISTANCE_M', 'STRAVA', 5234, '2026-10-02T16:00:00Z'),
      sample('BLOOD_PRESSURE_SYS', 'WITHINGS', 120, '2026-10-03T15:00:00Z'),
    ]);
    const r = await t.run({ ...WINDOW, kinds: KINDS });
    expect(t.timeline.read).not.toHaveBeenCalled();
    const health = t.prisma.wearableSample.findMany.mock.calls[0][0].where;
    expect(health).toMatchObject({
      user_id: 'client-a',
      start_at: { gte: T('2026-09-30T07:00:00Z'), lt: T('2026-10-03T07:00:00Z') },
    });
    const metrics: string[] = (health as { metric: { in: string[] } }).metric.in;
    for (const m of ['HEART_RATE_BPM', 'STEPS', 'SLEEP_TOTAL_MIN']) expect(metrics).not.toContain(m);
    expect(t.prisma.wearableUserMetricPreference.findMany.mock.calls[0][0].where).toMatchObject({ user_id: 'client-a' });
    expect(t.prisma.fastingWindow.findMany.mock.calls[0][0].where).toEqual({
      user_id: 'client-a', start_time: { gte: T('2026-10-01T07:00:00Z'), lt: T('2026-10-03T07:00:00Z') },
    });
    expect(t.prisma.romanMessage.findMany.mock.calls[0][0].where).toEqual({
      user_id: 'client-a', interrupted: false,
      created_at: { gte: T('2026-10-01T07:00:00Z'), lt: T('2026-10-03T07:00:00Z') },
      session: { user_id: 'client-a', surface: 'client', deleted_at: null },
    });
    expect(t.prisma.communityPost.findMany.mock.calls[0][0].where).toMatchObject({
      author_id: 'client-a', deleted_at: null, visibility: 'active',
    });
    expect(r).toMatchObject({ ok: true, rows: 7, truncated: false });
    expect(JSON.parse(r.content).events).toEqual([
      { date: '2026-10-01', kind: 'health_day', sleep_deep_min: 90, bedtime: '23:15' },
      { date: '2026-10-01', time: '09:00', kind: 'roman_chat', from: 'client', text: 'How was my sleep?' },
      { date: '2026-10-01', time: '09:00', kind: 'roman_chat', from: 'roman', text: `${'x'.repeat(300)}…` },
      { date: '2026-10-01', time: '18:00', kind: 'community_post', scope: 'workspace', title: 'Week 3', text: 'New squat best' },
      { date: '2026-10-01', time: '20:00', kind: 'fasting', hours: 16.5, ended: true, protocol: '16:8', text: 'felt fine' },
      { date: '2026-10-02', kind: 'health_day', body_weight_kg: 81, body_weight_lbs: 178.6, workout_distance_km: 5.23 },
      { date: '2026-10-02', time: '15:00', kind: 'fasting', ended: false },
    ]);
  });

  it('no kinds list reads the ten timeline kinds and every extra kind, all for the caller', async () => {
    const t = setup();
    const r = await t.run(WINDOW);
    expect(t.timeline.read).toHaveBeenCalledTimes(1);
    expect(t.timeline.read.mock.calls[0]).toEqual(['client-a', expect.objectContaining({ kinds: expect.any(Array) })]);
    for (const m of [t.prisma.wearableSample, t.prisma.fastingWindow, t.prisma.romanMessage]) {
      expect(m.findMany).toHaveBeenCalledTimes(1);
      expect(m.findMany.mock.calls[0][0].where).toMatchObject({ user_id: 'client-a' });
    }
    expect(t.prisma.communityPost.findMany).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: true, rows: 6 });
  });

  it('a capped device read sets truncated and drops the day it may not have read completely', async () => {
    const rows = Array.from({ length: 12_000 }, () => sample('SPO2_PCT', 'OURA', 97, '2026-10-01T15:00:00Z'));
    rows.push(sample('SPO2_PCT', 'OURA', 90, '2026-10-02T15:00:00Z'));
    const r = await setup(rows).run({ ...WINDOW, kinds: ['health_day'] });
    expect(r).toMatchObject({ ok: true, rows: 1, truncated: true });
    expect(JSON.parse(r.content).events).toEqual([{ date: '2026-10-01', kind: 'health_day', spo2_pct: 97 }]);
  });
});
