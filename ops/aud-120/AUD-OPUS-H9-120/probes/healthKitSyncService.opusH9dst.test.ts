/**
 * AUD-OPUS-H9-120 probe, INNER file run by healthKitSyncService.opusH9.test.ts in a child jest with
 * TZ=America/Los_Angeles (the zone must be set at process start). #370 H8 OPENING
 * (c7014623). Apple Health day pieces through the REAL HealthKitClient (only
 * the `react-native-health` native module is faked), so the real sleep
 * look-back, sleep window and hourly-bucket filter run in every piece.
 * The fake native readers select a sample by its START in [startDate,
 * endDate) (HKQueryOptionStrictStartDate); hourly sums are anchored at the
 * query start. Synthetic data only; no device, no network. Lane only.
 */
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('react-native-health', () => {
  const native = {
    initHealthKit: jest.fn(),
    getDailyStepCountSamples: jest.fn(),
    getActiveEnergyBurned: jest.fn(),
    getRestingHeartRateSamples: jest.fn(),
    getHeartRateSamples: jest.fn(),
    getVo2MaxSamples: jest.fn(),
    getAnchoredWorkouts: jest.fn(),
    getWeightSamples: jest.fn(),
    getBodyFatPercentageSamples: jest.fn(),
    getBloodPressureSamples: jest.fn(),
    getSleepSamples: jest.fn(),
    getHeartRateVariabilitySamples: jest.fn(),
    getOxygenSaturationSamples: jest.fn(),
    getRespiratoryRateSamples: jest.fn(),
    getBodyTemperatureSamples: jest.fn(),
  };
  return Object.assign(native, { __esModule: true, default: native });
});

const mockPost = jest.fn();
jest.mock('../../../api', () => ({
  __esModule: true,
  default: { post: (...args: unknown[]) => mockPost(...args) },
}));

import { HealthKitClient } from '../healthKitClient';
import {
  CUMULATIVE_SETTLE_MINUTES,
  HEALTHKIT_METRIC_KEYS,
  HealthKitSyncService,
  floorToLocalHour,
} from '../healthKitSyncService';
import { getSyncProgress, setSyncProgress, type OnDeviceScope } from '../../onDeviceState';
import type { SessionFence } from '../../sessionFence';

type Native = Record<string, jest.Mock>;
const native = jest.requireMock('react-native-health') as unknown as Native;
const HOUR = 60 * 60_000;
const SCOPE: OnDeviceScope = { userId: 'opus-h9-hk', connectionId: 'conn-h9', source: 'APPLE_HEALTHKIT' };

interface Sample {
  value: number | string;
  startDate: string;
  endDate: string;
}
interface Opts {
  startDate: string;
  endDate: string;
  period?: number;
}

/** Start-date selection, as HKQueryOptionStrictStartDate. */
function byStart(samples: Sample[]) {
  return (o: Opts, cb: (e: string | null, r: unknown) => void) => {
    const s = Date.parse(o.startDate);
    const e = Date.parse(o.endDate);
    cb(
      null,
      samples.filter((x) => {
        const t = Date.parse(x.startDate);
        return t >= s && t < e;
      }),
    );
  };
}

/** Hourly sums anchored at the query start (react-native-health period 60). */
function hourlyFromStart(value: number) {
  return (o: Opts, cb: (e: string | null, r: unknown) => void) => {
    const s = Date.parse(o.startDate);
    const e = Date.parse(o.endDate);
    const out: Sample[] = [];
    for (let t = s; t < e; t += HOUR) {
      out.push({ value, startDate: new Date(t).toISOString(), endDate: new Date(t + HOUR).toISOString() });
    }
    cb(null, out);
  };
}

function empty(_o: Opts, cb: (e: string | null, r: unknown) => void) {
  cb(null, []);
}

function okFence(): SessionFence {
  return {
    userId: SCOPE.userId,
    assertCurrent: jest.fn(async () => undefined),
    throwIfStopped: jest.fn(),
    cancel: jest.fn(),
  };
}

async function seedAllThrough(iso: string) {
  const completedThrough: Record<string, string> = {};
  for (const k of HEALTHKIT_METRIC_KEYS) completedThrough[k] = iso;
  await setSyncProgress(SCOPE, { v: 1, completedThrough, resume: {} });
}

type Wire = { metric: string; value: number; startAt: string; endAt: string };
const posted = (): Wire[] => mockPost.mock.calls.flatMap((call) => call[1] as Wire[]);

const ORIGINAL_TZ = process.env.TZ;

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  mockPost.mockResolvedValue({ data: { accepted: 1 } });
  native.initHealthKit.mockImplementation((_p: unknown, cb: (e: string | null, r: unknown) => void) =>
    cb(null, true),
  );
  for (const k of Object.keys(native)) {
    const fn = native[k] as unknown as { mockImplementation?: unknown };
    if (k === 'initHealthKit' || k === 'getAnchoredWorkouts' || typeof fn?.mockImplementation !== 'function') continue;
    native[k].mockImplementation(empty);
  }
  native.getAnchoredWorkouts.mockImplementation((_o: unknown, cb: (e: string | null, r: unknown) => void) =>
    cb(null, { anchor: '', data: [] }),
  );
});
afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

describe('H9-HK-2: pieces across the end of daylight saving (America/Los_Angeles, 2026-11-01)', () => {
  it('pieces are contiguous on local hours, and every settled hour is posted exactly once', async () => {
    // Precondition: the zone change took effect in this worker.
    expect(new Date('2026-10-30T12:00:00.000Z').getTimezoneOffset()).toBe(420);
    expect(new Date('2026-11-03T12:00:00.000Z').getTimezoneOffset()).toBe(480);
    const NOW = new Date('2026-11-03T20:17:00.000Z'); // 12:17 PST
    await seedAllThrough('2026-10-31T16:30:00.000Z'); // 09:30 PDT -> window start 2026-10-30 09:00 PDT
    native.getDailyStepCountSamples.mockImplementation(hourlyFromStart(10));
    const result = await new HealthKitSyncService(new HealthKitClient()).sync({ scope: SCOPE, now: NOW, fence: okFence() });

    const windows = native.getHeartRateSamples.mock.calls.map((c) => ({
      s: Date.parse((c[0] as Opts).startDate),
      e: Date.parse((c[0] as Opts).endDate),
    }));
    expect(windows[0].s).toBe(Date.parse('2026-10-30T16:00:00.000Z'));
    expect(windows[windows.length - 1].e).toBe(NOW.getTime());
    for (let i = 0; i < windows.length; i += 1) {
      if (i > 0) expect(windows[i].s).toBe(windows[i - 1].e);
      expect(new Date(windows[i].s).getMinutes()).toBe(0);
      expect(windows[i].e - windows[i].s).toBeLessThanOrEqual(25 * HOUR);
    }

    const settled = floorToLocalHour(new Date(NOW.getTime() - CUMULATIVE_SETTLE_MINUTES * 60_000)).getTime();
    const steps = posted().filter((s) => s.metric === 'STEPS');
    const starts = steps.map((s) => Date.parse(s.startAt));
    expect(new Set(starts).size).toBe(starts.length); // each hour once in this run
    const expected: number[] = [];
    for (let t = Date.parse('2026-10-30T16:00:00.000Z'); t + HOUR <= settled; t += HOUR) expected.push(t);
    expect([...starts].sort((a, b) => a - b)).toEqual(expected);
    for (const s of steps) expect(Date.parse(s.endAt) - Date.parse(s.startAt)).toBe(HOUR);
    const progress = await getSyncProgress(SCOPE);
    expect(progress.completedThrough.steps).toBe(new Date(settled).toISOString());
    expect(progress.completedThrough.heartRate).toBe(NOW.toISOString());
    expect(result.complete).toBe(true);
  });
});

