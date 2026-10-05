/** Independent H8 stale-token, saved-page and stop boundary proofs. */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { syncHealthConnect } from '../healthConnectSyncService';
import { getSyncProgress, setSyncProgress } from '../../onDeviceState';
import { OnDeviceSessionChangedError, type SessionFence } from '../../sessionFence';

jest.mock('expo-constants', () => ({
  __esModule: true, default: { expoConfig: { extra: { healthConnectEnabled: true } } },
}));
jest.mock('../../../../utils/logger', () => ({
  logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
const scope = { userId: 'synthetic-h9', connectionId: 'synthetic-h9-c', source: 'HEALTH_CONNECT' as const };
const now = new Date('2026-05-31T12:00:00Z');
const fence = (): SessionFence => ({
  userId: scope.userId, assertCurrent: jest.fn(async () => undefined),
  throwIfStopped: jest.fn(), cancel: jest.fn(),
});
function client(read: jest.Mock) {
  return {
    initialize: jest.fn(async () => true),
    getGrantedPermissions: jest.fn(async () => [{ accessType: 'read', recordType: 'Steps' }]),
    readRecordsPaged: read,
  } as never;
}
const record = (value: number) => ({
  startTime: '2026-05-30T10:00:00.000Z', endTime: '2026-05-30T10:01:00.000Z', count: value,
});
beforeEach(async () => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  await AsyncStorage.clear();
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
});

it('an expired stored token drops only the token and makes the next visit retry the completed window', async () => {
  const old = '2026-05-29T12:00:00.000Z';
  await setSyncProgress(scope, { v: 1, completedThrough: { Steps: old }, resume: {
    Steps: { startTime: old, endTime: now.toISOString(), pageToken: 'expired' },
  } });
  const read = jest.fn().mockRejectedValueOnce(new Error('synthetic expired token'))
    .mockResolvedValueOnce({ records: [record(7)] });
  const ingest = jest.fn(async (samples) => ({ inserted: samples.length, skipped: 0 }));
  const result = await syncHealthConnect(scope, { client: client(read), ingestApi: { ingest }, fence: fence(), now: () => now });
  expect(result).toMatchObject({ complete: false, failedRecordTypes: ['Steps'] });
  expect((await getSyncProgress(scope)).completedThrough.Steps).toBe(old);
  expect((await getSyncProgress(scope)).resume.Steps).toBeUndefined();
  await syncHealthConnect(scope, { client: client(read), ingestApi: { ingest }, fence: fence(), now: () => now });
  expect(read.mock.calls[1][2]).toBeUndefined();
  expect(read.mock.calls[1][1].startTime).toBe('2026-05-28T12:00:00.000Z');
  expect(ingest.mock.calls.flatMap(([samples]) => samples).map((sample) => sample.value)).toEqual([7]);
});

it('a page save failure retries that acknowledged page and never claims its token as persisted', async () => {
  const read = jest.fn(async (_type, _range, token) => token === 'next'
    ? { records: [] } : { records: [record(9)], nextPageToken: 'next' });
  const ingest = jest.fn(async (samples) => ({ inserted: samples.length, skipped: 0 }));
  jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('synthetic save failed'));
  await expect(syncHealthConnect(scope, { client: client(read), ingestApi: { ingest }, fence: fence(), now: () => now }))
    .rejects.toThrow('synthetic save failed');
  expect((await getSyncProgress(scope)).resume.Steps).toBeUndefined();
  expect(read).toHaveBeenCalledTimes(1);
  await syncHealthConnect(scope, { client: client(read), ingestApi: { ingest }, fence: fence(), now: () => now });
  expect(read.mock.calls.map((call) => call[2])).toEqual([undefined, undefined, 'next']);
  expect((await getSyncProgress(scope)).completedThrough.Steps).toBe(now.toISOString());
});

it('a stop after page upload acknowledgment starts no save or further page read', async () => {
  let stopped = false;
  const f = fence();
  f.assertCurrent = jest.fn(async () => { if (stopped) throw new OnDeviceSessionChangedError(); });
  f.throwIfStopped = jest.fn(() => { if (stopped) throw new OnDeviceSessionChangedError(); });
  const read = jest.fn(async () => ({ records: [record(11)], nextPageToken: 'next' }));
  const ingest = jest.fn(async (_samples, options) => {
    await options.beforeEachRequest();
    stopped = true;
    return { inserted: 1, skipped: 0 };
  });
  await expect(syncHealthConnect(scope, { client: client(read), ingestApi: { ingest }, fence: f, now: () => now }))
    .rejects.toBeInstanceOf(OnDeviceSessionChangedError);
  expect(read).toHaveBeenCalledTimes(1);
  expect(ingest).toHaveBeenCalledTimes(1);
  expect(await getSyncProgress(scope)).toEqual({ v: 1, completedThrough: {}, resume: {} });
});
