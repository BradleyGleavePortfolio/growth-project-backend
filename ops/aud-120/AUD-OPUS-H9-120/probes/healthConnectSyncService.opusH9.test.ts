// AUD-OPUS-H9-120 probe (Claude Opus 5.5 lens, agent 120): #370 H8 OPENING
// (c7014623). Health Connect per-page progress composed with the REAL H7
// sign-out (stopOnDeviceHealthWork + retireOnDeviceStateAtSignOut, real
// onDeviceState chain, real session fence): no page is posted and no
// progress is written after sign-out began, and the sweep leaves no
// progress key behind. Plus the one-day look-back bound. Synthetic store
// only; no device, no network. Lane only, never merge.

import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { healthConnectEnabled: true } } },
}));
jest.mock('../../../../utils/logger', () => ({
  logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { syncHealthConnect } from '../healthConnectSyncService';
import {
  ON_DEVICE_STATE_PREFIX,
  getSyncProgress,
  retireOnDeviceStateAtSignOut,
  setSyncProgress,
  type OnDeviceScope,
} from '../../onDeviceState';
import {
  OnDeviceSessionChangedError,
  createSessionFence,
  stopOnDeviceHealthWork,
} from '../../sessionFence';

const SCOPE: OnDeviceScope = { userId: 'opus-h9-hc', connectionId: 'conn-h9', source: 'HEALTH_CONNECT' };
const PAGE_SIZE = 2;
const HOUR = 60 * 60_000;

interface StoredRecord {
  startTime: string;
  endTime: string;
  count: number;
}

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((yes) => (resolve = yes));
  return { resolve, promise };
}

/** Pages PAGE_SIZE records at a time; `between` keeps records wholly inside the range. */
function makeClient(records: Record<string, StoredRecord[]>) {
  const readRecordsPaged = jest.fn(
    async (
      recordType: string,
      range: { startTime: string; endTime: string },
      resumeFrom?: string,
      stop?: { assertCurrent(): Promise<void>; throwIfStopped(): void },
      maxPages = 20,
    ) => {
      const inRange = (records[recordType] ?? []).filter(
        (r) => r.startTime >= range.startTime && r.endTime <= range.endTime,
      );
      let offset = resumeFrom ? Number(resumeFrom) : 0;
      const out: StoredRecord[] = [];
      for (let page = 0; page < maxPages; page += 1) {
        if (stop) {
          await stop.assertCurrent();
          stop.throwIfStopped();
        }
        out.push(...inRange.slice(offset, offset + PAGE_SIZE));
        offset += PAGE_SIZE;
        if (offset >= inRange.length) return { records: out };
      }
      return { records: out, nextPageToken: String(offset) };
    },
  );
  const granted = Object.keys(records).map((recordType) => ({ accessType: 'read', recordType }));
  return {
    isHealthConnectSupported: jest.fn(() => true),
    buildReadPermissions: jest.fn(() => granted),
    initialize: jest.fn().mockResolvedValue(true),
    requestPermission: jest.fn().mockResolvedValue(granted),
    getGrantedPermissions: jest.fn().mockResolvedValue(granted),
    readRecords: jest.fn().mockResolvedValue([]),
    readRecordsPaged,
    readAllSupportedRecords: jest.fn().mockResolvedValue({}),
  };
}

const NOW = new Date('2026-06-10T12:00:00.000Z');
function steps(n: number): StoredRecord[] {
  return Array.from({ length: n }, (_, i) => {
    const s = Date.parse('2026-06-09T00:00:00.000Z') + i * HOUR;
    return { startTime: new Date(s).toISOString(), endTime: new Date(s + 15 * 60_000).toISOString(), count: 100 + i };
  });
}

async function healthKeys(): Promise<readonly string[]> {
  return (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(ON_DEVICE_STATE_PREFIX));
}

beforeEach(async () => {
  jest.restoreAllMocks();
  await AsyncStorage.clear();
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
});

it('H9-HC-1: sign-out while page 2 is being posted: page 1 was saved, page 3 is never read or posted, and the sweep leaves no progress', async () => {
  const fence = createSessionFence(SCOPE.userId, async () => SCOPE.userId);
  const client = makeClient({ Steps: steps(6) });
  const held = deferred();
  const release = deferred();
  let calls = 0;
  const ingest = jest.fn(async (s: unknown[], opts?: { beforeEachRequest?: () => Promise<void> }) => {
    calls += 1;
    if (opts?.beforeEachRequest) await opts.beforeEachRequest();
    if (calls === 2) {
      held.resolve();
      await release.promise; // the request is on the wire when sign-out starts
    }
    return { inserted: s.length, skipped: 0 };
  });
  const running = syncHealthConnect(SCOPE, {
    client: client as never,
    ingestApi: { ingest } as never,
    now: () => NOW,
    fence,
  }).then(
    () => null,
    (e: unknown) => e,
  );
  await held.promise;
  const page1 = await getSyncProgress(SCOPE);
  // signOut()'s first two synchronous statements.
  stopOnDeviceHealthWork();
  const signingOut = retireOnDeviceStateAtSignOut();
  release.resolve();
  expect(await running).toBeInstanceOf(OnDeviceSessionChangedError);
  await signingOut;
  expect(page1.resume.Steps?.pageToken).toBe(String(PAGE_SIZE));
  expect(ingest).toHaveBeenCalledTimes(2);
  expect(client.readRecordsPaged).toHaveBeenCalledTimes(2);
  expect(await healthKeys()).toEqual([]);
});

it('H9-HC-2: sign-out while a page\'s progress write is on the wire: the run stops and the sweep removes the key after the write', async () => {
  const fence = createSessionFence(SCOPE.userId, async () => SCOPE.userId);
  const client = makeClient({ Steps: steps(6) });
  const held = deferred();
  const release = deferred();
  const set = AsyncStorage.setItem.bind(AsyncStorage);
  jest.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(async (k, v) => {
    held.resolve();
    await release.promise;
    await set(k, v);
  });
  const ingest = jest.fn(async (s: unknown[]) => ({ inserted: s.length, skipped: 0 }));
  const running = syncHealthConnect(SCOPE, {
    client: client as never,
    ingestApi: { ingest } as never,
    now: () => NOW,
    fence,
  }).then(
    () => null,
    (e: unknown) => e,
  );
  await held.promise;
  stopOnDeviceHealthWork();
  const signingOut = retireOnDeviceStateAtSignOut();
  release.resolve();
  expect(await running).toBeInstanceOf(OnDeviceSessionChangedError);
  await signingOut;
  expect(ingest).toHaveBeenCalledTimes(1);
  expect(await healthKeys()).toEqual([]);
});

it('H9-HC-3: the one-day look-back: a record starting 23 h before the saved progress, written later, is read; one 25 h before is not (DOCUMENTS the bound)', async () => {
  const saved = Date.parse('2026-06-10T11:00:00.000Z');
  await setSyncProgress(SCOPE, { v: 1, completedThrough: { Steps: new Date(saved).toISOString() }, resume: {} });
  const rec = (h: number, count: number): StoredRecord => ({
    startTime: new Date(saved - h * HOUR).toISOString(),
    endTime: new Date(saved - h * HOUR + 10 * 60_000).toISOString(),
    count,
  });
  const client = makeClient({ Steps: [rec(25, 7), rec(23, 9)] });
  const seen: number[] = [];
  const ingest = jest.fn(async (s: Array<{ value: number }>) => {
    seen.push(...s.map((x) => x.value));
    return { inserted: s.length, skipped: 0 };
  });
  const fence = createSessionFence(SCOPE.userId, async () => SCOPE.userId);
  const res = await syncHealthConnect(SCOPE, {
    client: client as never,
    ingestApi: { ingest } as never,
    now: () => NOW,
    fence,
  });
  expect(seen).toEqual([9]);
  expect(res.complete).toBe(true);
  expect((await getSyncProgress(SCOPE)).completedThrough.Steps).toBe(NOW.toISOString());
});
