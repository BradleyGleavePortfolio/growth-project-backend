/**
 * AUD-OPUS-H9-120 probe (Claude Opus 5.5 lens, agent 120): #370 H8 OPENING
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

/** One night 22:00 -> 06:00 (UTC) as eight hourly stage segments (480 min asleep). */
function night(dayIso: string): Sample[] {
  const start = Date.parse(`${dayIso}T22:00:00.000Z`);
  const stages = ['CORE', 'DEEP', 'REM', 'CORE', 'DEEP', 'REM', 'CORE', 'CORE'];
  return stages.map((value, i) => ({
    value,
    startDate: new Date(start + i * HOUR).toISOString(),
    endDate: new Date(start + (i + 1) * HOUR).toISOString(),
  }));
}

describe('H9-HK-1: day pieces cut nights at 03:00; every night is posted whole, under one key', () => {
  beforeEach(() => {
    process.env.TZ = 'UTC';
  });

  it('a multi-day read whose piece ends fall inside the nights posts no partial night', async () => {
    const NOW = new Date('2026-06-10T12:00:00.000Z');
    // Progress 03:30 -> window start floor(03:30 - 1 day) = 03:00: every piece ends at 03:00, mid-night.
    await seedAllThrough('2026-06-06T03:30:00.000Z');
    const segments = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-06', '2026-06-07', '2026-06-08', '2026-06-09'].flatMap(night);
    native.getSleepSamples.mockImplementation(byStart(segments));
    const result = await new HealthKitSyncService(new HealthKitClient()).sync({ scope: SCOPE, now: NOW, fence: okFence() });
    const pieceEnds = native.getHeartRateSamples.mock.calls.map((c) => (c[0] as Opts).endDate);
    expect(pieceEnds.length).toBeGreaterThan(3);
    const totals = posted().filter((s) => s.metric === 'SLEEP_TOTAL_MIN');
    const keys = new Set(totals.map((s) => `${s.startAt}|${s.endAt}`));
    // Every posted night is whole: 22:00 -> 06:00, 480 minutes, one key per night.
    for (const s of totals) {
      expect(s.startAt.endsWith('T22:00:00.000Z')).toBe(true);
      expect(s.endAt.endsWith('T06:00:00.000Z')).toBe(true);
      expect(s.value).toBe(480);
    }
    // Nights from the first piece's sleep look-back to the last full night.
    expect([...keys].sort()).toEqual(
      ['2026-06-03', '2026-06-04', '2026-06-05', '2026-06-06', '2026-06-07', '2026-06-08', '2026-06-09'].map((d) => {
        const s = `${d}T22:00:00.000Z`;
        const e = new Date(Date.parse(s) + 8 * HOUR).toISOString();
        return `${s}|${e}`;
      }),
    );
    expect(result.complete).toBe(true);
    expect((await getSyncProgress(SCOPE)).completedThrough.sleep).toBe(NOW.toISOString());
  });
});

describe('H9-HK-4: DOCUMENTS C-370-3 (outside this diff, amplified by day pieces): a partial night read at a piece\'s 36 h sleep look-back start is posted as a second night', () => {
  beforeEach(() => {
    process.env.TZ = 'UTC';
  });

  it('a long segment spanning the look-back start, then a segment 3 h after it, posts the night whole AND its tail as its own night', async () => {
    const NOW = new Date('2026-06-10T12:00:00.000Z');
    await seedAllThrough('2026-06-07T12:00:00.000Z'); // window start 2026-06-06 12:00: pieces at 12:00, look-back starts at 00:00
    const s1: Sample = { value: 'ASLEEP', startDate: '2026-06-06T23:00:00.000Z', endDate: '2026-06-07T01:30:00.000Z' };
    const s2: Sample = { value: 'ASLEEP', startDate: '2026-06-07T03:00:00.000Z', endDate: '2026-06-07T06:00:00.000Z' };
    native.getSleepSamples.mockImplementation(byStart([s1, s2]));
    await new HealthKitSyncService(new HealthKitClient()).sync({ scope: SCOPE, now: NOW, fence: okFence() });
    const keys = new Map<string, number>();
    for (const s of posted().filter((x) => x.metric === 'SLEEP_TOTAL_MIN')) keys.set(`${s.startAt}|${s.endAt}`, s.value);
    expect(Object.fromEntries(keys)).toEqual({
      '2026-06-06T23:00:00.000Z|2026-06-07T06:00:00.000Z': 330, // the whole night (pieces 1 and 2)
      '2026-06-07T03:00:00.000Z|2026-06-07T06:00:00.000Z': 180, // its tail again (piece 3, look-back from 2026-06-07 00:00)
    });
  });
});

describe('H9-HK-2: pieces across the end of daylight saving (America/Los_Angeles, 2026-11-01)', () => {
  it('runs the DST probe in a child jest started with TZ=America/Los_Angeles', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawnSync } = require('child_process') as typeof import('child_process');
    const res = spawnSync(
      process.execPath,
      ['node_modules/jest/bin/jest.js', '--ci', 'src/services/health/healthkit/__tests__/healthKitSyncService.opusH9dst.test.ts'],
      { env: { ...process.env, TZ: 'America/Los_Angeles' }, encoding: 'utf8', timeout: 170_000 },
    );
    if (res.status !== 0) console.log(`${res.stdout ?? ''}\n${res.stderr ?? ''}`);
    expect(`${res.stderr ?? ''}`).toMatch(/Tests:\s+1 passed, 1 total/);
    expect(res.status).toBe(0);
  }, 180_000);
});

describe('H9-HK-3: the one-day look-back bound', () => {
  beforeEach(() => {
    process.env.TZ = 'UTC';
  });

  it('a heart rate that starts 23 h before the saved progress is posted; one 25 h before is not (DOCUMENTS the bound)', async () => {
    const NOW = new Date('2026-06-10T12:00:00.000Z');
    const saved = Date.parse('2026-06-10T11:00:00.000Z');
    await seedAllThrough(new Date(saved).toISOString());
    const at = (h: number, value: number): Sample => {
      const iso = new Date(saved - h * HOUR).toISOString();
      return { value, startDate: iso, endDate: iso };
    };
    native.getHeartRateSamples.mockImplementation(byStart([at(23, 61), at(25, 62)]));
    await new HealthKitSyncService(new HealthKitClient()).sync({ scope: SCOPE, now: NOW, fence: okFence() });
    const hr = posted().filter((s) => s.metric === 'HEART_RATE_BPM').map((s) => s.value);
    expect(hr).toEqual([61]);
  });
});
