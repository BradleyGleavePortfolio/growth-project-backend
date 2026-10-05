/** Independent H8 proof: real native-wrapper/normalizer/sync composition.
 * Synthetic callback data and backend dedup only; no device or network.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import AppleHealthKit from 'react-native-health';
import { HealthKitClient, type HealthKitSample } from '../healthKitClient';
import { HEALTHKIT_METRIC_KEYS, HealthKitSyncService } from '../healthKitSyncService';
import { getSyncProgress, setSyncProgress } from '../../onDeviceState';
import type { SessionFence } from '../../sessionFence';

jest.mock('../../../api', () => ({
  __esModule: true, default: { post: jest.fn() },
}));
jest.mock('react-native-health', () => {
  const empty = () => jest.fn((_: unknown, cb: (error: null, data: unknown[]) => void) => cb(null, []));
  return {
    __esModule: true,
    default: {
      initHealthKit: jest.fn((_: unknown, cb: (error: null, data: object) => void) => cb(null, {})),
      getDailyStepCountSamples: empty(),
      getActiveEnergyBurned: empty(),
      getRestingHeartRateSamples: empty(),
      getHeartRateSamples: empty(),
      getVo2MaxSamples: empty(),
      getAnchoredWorkouts: jest.fn((_: unknown, cb: (error: null, data: object) => void) =>
        cb(null, { anchor: '', data: [] })),
      getWeightSamples: empty(),
      getBodyFatPercentageSamples: empty(),
      getBloodPressureSamples: empty(),
      getSleepSamples: empty(),
      getHeartRateVariabilitySamples: empty(),
      getOxygenSaturationSamples: empty(),
      getRespiratoryRateSamples: empty(),
      getBodyTemperatureSamples: empty(),
    },
  };
});

const scope = { userId: 'synthetic-h9', connectionId: 'synthetic-h9-c', source: 'APPLE_HEALTHKIT' as const };
const fence = (): SessionFence => ({
  userId: scope.userId, assertCurrent: jest.fn(async () => undefined),
  throwIfStopped: jest.fn(), cancel: jest.fn(),
});
const native = AppleHealthKit as unknown as Record<string, jest.Mock>;
const iso = (s: string) => new Date(s).toISOString();
const sample = (value: number | string, start: string, end = start): HealthKitSample => ({
  value, startDate: iso(start), endDate: iso(end),
});

beforeEach(async () => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  await AsyncStorage.clear();
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  for (const [key, mock] of Object.entries(native)) {
    if (key === 'initHealthKit') mock.mockImplementation((_, cb) => cb(null, {}));
    else if (key === 'getAnchoredWorkouts') mock.mockImplementation((_, cb) => cb(null, { anchor: '', data: [] }));
    else mock.mockImplementation((_, cb) => cb(null, []));
  }
});

async function seed(through: string) {
  await setSyncProgress(scope, {
    v: 1, resume: {},
    completedThrough: Object.fromEntries(HEALTHKIT_METRIC_KEYS.map((key) => [key, iso(through)])),
  });
}

it('a sleep session crossing a daily piece edge is emitted whole with one stable backend key', async () => {
  await seed('2026-05-30T12:00:00Z');
  // Pieces end at 12:00; the synthetic night crosses that edge at 10:00–14:00.
  const sleep = [sample('DEEP', '2026-05-30T10:00:00Z', '2026-05-30T12:00:00Z'),
    sample('REM', '2026-05-30T12:00:00Z', '2026-05-30T14:00:00Z')];
  native.getSleepSamples.mockImplementation((options, cb) => cb(null,
    sleep.filter((s) => s.startDate >= options.startDate && s.startDate <= options.endDate)));
  const accepted = new Map<string, { metric: string; value: number; startAt: string; endAt: string }>();
  const sent: Array<{ metric: string; value: number; startAt: string; endAt: string }> = [];
  const post = jest.fn(async (_path, body) => {
    let inserted = 0;
    for (const row of body) {
      sent.push(row);
      const key = `${scope.userId}|${row.provider}|${row.metric}|${row.startAt}|${row.endAt}`;
      if (!accepted.has(key)) { accepted.set(key, row); inserted += 1; }
    }
    return { data: { inserted, skipped: body.length - inserted } };
  });
  const service = new HealthKitSyncService(new HealthKitClient());
  await service.sync({ scope, fence: fence(), now: new Date('2026-05-31T12:00:00Z'), ingestDeps: { post } });
  await service.sync({ scope, fence: fence(), now: new Date('2026-05-31T13:00:00Z'), ingestDeps: { post } });
  const total = [...accepted.values()].filter((row) => row.metric === 'SLEEP_TOTAL_MIN');
  expect(total).toEqual([expect.objectContaining({
    value: 240, startAt: iso('2026-05-30T10:00:00Z'), endAt: iso('2026-05-30T14:00:00Z'),
  })]);
  expect(sent.filter((row) => row.metric === 'SLEEP_TOTAL_MIN').every((row) => row.value === 240)).toBe(true);
  expect(native.getSleepSamples.mock.calls.some(([options]) =>
    Date.parse(options.startDate) < Date.parse('2026-05-30T10:00:00Z'))).toBe(true);
});

it('both real hourly readers keep unsettled hours out and post their late shares once settled', async () => {
  await seed('2026-05-31T10:00:00Z');
  const steps = [sample(100, '2026-05-31T11:00:00Z', '2026-05-31T12:00:00Z')];
  const energy = [sample(10, '2026-05-31T11:00:00Z', '2026-05-31T12:00:00Z')];
  const read = (records: HealthKitSample[]) => (options: { startDate: string; endDate: string }, cb: Function) =>
    cb(null, records.filter((s) => s.startDate >= options.startDate && s.startDate < options.endDate));
  native.getDailyStepCountSamples.mockImplementation(read(steps));
  native.getActiveEnergyBurned.mockImplementation(read(energy));
  native.getHeartRateSamples.mockImplementation(read([sample(65, '2026-05-31T11:00:00Z')]));
  const sent: Array<{ metric: string; value: number }> = [];
  const post = jest.fn(async (_path, body) => { sent.push(...body); return { data: { inserted: body.length, skipped: 0 } }; });
  const service = new HealthKitSyncService(new HealthKitClient());
  await service.sync({ scope, fence: fence(), now: new Date('2026-05-31T12:00:00Z'), ingestDeps: { post } });
  expect(sent.filter((row) => ['STEPS', 'ACTIVE_ENERGY_KCAL'].includes(row.metric))).toEqual([]);
  expect((await getSyncProgress(scope)).completedThrough.steps).toBe(iso('2026-05-31T10:00:00Z'));
  steps[0].value = 160;
  energy[0].value = 25;
  await service.sync({ scope, fence: fence(), now: new Date('2026-05-31T14:00:00Z'), ingestDeps: { post } });
  expect(sent.filter((row) => ['STEPS', 'ACTIVE_ENERGY_KCAL'].includes(row.metric))).toEqual([
    expect.objectContaining({ metric: 'STEPS', value: 160 }),
    expect.objectContaining({ metric: 'ACTIVE_ENERGY_KCAL', value: 25 }),
  ]);
  expect(native.getDailyStepCountSamples.mock.calls.every(([options]) => options.period === 60)).toBe(true);
  expect(native.getActiveEnergyBurned.mock.calls.every(([options]) => options.period === 60)).toBe(true);
});

it('progress storage failure after a posted day retries it rather than falsely completing history', async () => {
  await seed('2026-05-30T12:00:00Z');
  const rates = [sample(65, '2026-05-29T13:00:00Z'), sample(66, '2026-05-30T13:00:00Z')];
  native.getHeartRateSamples.mockImplementation((options, cb) => cb(null,
    rates.filter((s) => s.startDate >= options.startDate && s.startDate < options.endDate)));
  const post = jest.fn(async (_path, body) => ({ data: { inserted: body.length, skipped: 0 } }));
  jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('synthetic save failed'));
  const service = new HealthKitSyncService(new HealthKitClient());
  await expect(service.sync({ scope, fence: fence(), now: new Date('2026-05-31T12:00:00Z'), ingestDeps: { post } }))
    .rejects.toThrow('synthetic save failed');
  expect((await getSyncProgress(scope)).completedThrough.heartRate).toBe(iso('2026-05-30T12:00:00Z'));
  await service.sync({ scope, fence: fence(), now: new Date('2026-05-31T12:00:00Z'), ingestDeps: { post } });
  expect(post.mock.calls.flatMap(([, body]) => body).filter((row) => row.metric === 'HEART_RATE_BPM')
    .map((row) => row.value)).toEqual([65, 65, 66]);
});
