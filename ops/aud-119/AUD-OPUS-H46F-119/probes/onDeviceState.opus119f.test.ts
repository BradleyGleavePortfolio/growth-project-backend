/**
 * AUD-OPUS-H46F-119 probe (Claude Opus 5.5 lens, agent 119): FIX ROUND 5
 * (261e7d4c) sign-out drain through the onDeviceState chain and the C-362-13
 * restore. Synthetic storage scheduler on the jest AsyncStorage mock; no
 * native build, no network, no health data.
 * Cases prefixed "DOCUMENTS" assert the CURRENT behaviour behind a C finding.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ON_DEVICE_STATE_PREFIX,
  emptyProgress,
  getLocalAuthorization,
  getSyncProgress,
  localAuthorizationSeq,
  recordLocalAuthorization,
  retireOnDeviceSource,
  retireOnDeviceStateAtSignOut,
  setSyncProgress,
} from '../onDeviceState';
import { connectOnDevice } from '../onDeviceSync';
import {
  OnDeviceSessionChangedError,
  createSessionFence,
  stopOnDeviceHealthWork,
} from '../sessionFence';
import type { WearableConnection } from '../../../api/wearablesConnectionsApi';

const source = 'HEALTH_CONNECT' as const;
const old = { userId: 'opus-f-user', source, connectionId: 'old-connection' };
const fresh = { ...old, connectionId: 'fresh-connection' };
const D1 = '2026-10-01T00:00:00.000Z';
const D2 = '2026-10-02T00:00:00.000Z';
const D3 = '2026-10-03T00:00:00.000Z';

function deferred<T = void>() {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { resolve, promise };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function healthKeys(): Promise<readonly string[]> {
  return (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(ON_DEVICE_STATE_PREFIX));
}

function connectionRow(id: string): WearableConnection {
  return {
    id,
    user_id: old.userId,
    provider: source,
    external_account_id: 'on-device',
    access_token_expires_at: null,
    scopes: [],
    webhook_subscription_id: null,
    channel_expires_at: null,
    status: 'connected',
    last_error: null,
    last_synced_at: null,
    backfilled_until: null,
    disconnected_at: null,
    created_at: D1,
    updated_at: D1,
  } as WearableConnection;
}

beforeEach(async () => {
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});
afterEach(() => jest.restoreAllMocks());

it('CLOSED C-362-12: a grant write in flight at sign-out leaves no key and no grant (real retireOnDeviceStateAtSignOut)', async () => {
  const commit = deferred();
  const set = AsyncStorage.setItem.bind(AsyncStorage);
  jest.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(async (k: string, v: string) => {
    await commit.promise;
    await set(k, v);
  });
  const writing = recordLocalAuthorization(old, new Date(D3));
  await tick();
  const retired = retireOnDeviceStateAtSignOut();
  commit.resolve();
  await Promise.all([writing, retired]);
  expect(await healthKeys()).toEqual([]);
  expect(await getLocalAuthorization(old.userId, source)).toBeNull();
});

it('a Connect whose fence predates sign-out records nothing when registration returns after sign-out started', async () => {
  const fence = createSessionFence(old.userId, async () => old.userId);
  const registered = deferred<WearableConnection>();
  const connecting = connectOnDevice(source, fence, {
    register: () => registered.promise,
    readUserId: async () => old.userId,
    syncHealthConnect: async () => ({ normalizedCount: 0, complete: true }),
  }).then(
    () => null,
    (e: unknown) => e,
  );
  await tick();
  // signOut's first two synchronous statements.
  stopOnDeviceHealthWork();
  const retired = retireOnDeviceStateAtSignOut();
  registered.resolve(connectionRow('late-connection'));
  expect(await connecting).toBeInstanceOf(OnDeviceSessionChangedError);
  await retired;
  expect(await healthKeys()).toEqual([]);
  expect(await getLocalAuthorization(old.userId, source)).toBeNull();
});

it('a Disconnect that started before sign-out never removes a Connect made after sign-out', async () => {
  const prior = await recordLocalAuthorization(old, new Date(D1));
  const since = localAuthorizationSeq();
  await retireOnDeviceStateAtSignOut();
  await recordLocalAuthorization(fresh, new Date(D2));
  await setSyncProgress(fresh, { ...emptyProgress(), completedThrough: { Steps: D2 } });
  await retireOnDeviceSource(old.userId, source, prior.grantedAt, since);
  expect((await getLocalAuthorization(old.userId, source))?.connectionId).toBe(fresh.connectionId);
  expect((await getSyncProgress(fresh)).completedThrough.Steps).toBe(D2);
});

it('a second sign-out voids a grant made between the two sign-outs; a grant after it is honoured', async () => {
  await retireOnDeviceStateAtSignOut();
  await recordLocalAuthorization(old, new Date(D1));
  await retireOnDeviceStateAtSignOut();
  expect(await getLocalAuthorization(old.userId, source)).toBeNull();
  await recordLocalAuthorization(fresh, new Date(D2));
  expect((await getLocalAuthorization(old.userId, source))?.connectionId).toBe(fresh.connectionId);
});

it('a grant write that fails after sign-out (new session) is not honoured and the old disk record stays voided', async () => {
  await recordLocalAuthorization(old, new Date(D1));
  jest.spyOn(AsyncStorage, 'removeMany').mockRejectedValueOnce(new Error('synthetic removal failure'));
  await retireOnDeviceStateAtSignOut(); // removal fails: old key still on disk
  jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk full'));
  await expect(recordLocalAuthorization(fresh, new Date(D2))).rejects.toThrow('disk full');
  expect(await healthKeys()).not.toEqual([]);
  expect(await getLocalAuthorization(old.userId, source)).toBeNull();
});

it('DOCUMENTS C-362-14: a failed sign-out removal is voided in this run, but after a restart the same account reads the old grant again', async () => {
  await recordLocalAuthorization(old, new Date(D1));
  jest.spyOn(AsyncStorage, 'removeMany').mockRejectedValueOnce(new Error('synthetic removal failure'));
  await retireOnDeviceStateAtSignOut();
  expect(await getLocalAuthorization(old.userId, source)).toBeNull(); // voided in this run
  let restarted: typeof import('../onDeviceState') | undefined;
  jest.isolateModules(() => {
    jest.doMock('@react-native-async-storage/async-storage', () => AsyncStorage);
    restarted = require('../onDeviceState');
  });
  // Fresh module state = app restart over the same disk.
  expect((await restarted!.getLocalAuthorization(old.userId, source))?.grantedAt).toBe(D1);
  // Only for the account that granted it: another account sees nothing.
  expect(await restarted!.getLocalAuthorization('opus-f-other', source)).toBeNull();
});

it('DOCUMENTS C-362-15: two overlapping grant writes that BOTH fail leave the first failed write credited, so an older Disconnect keeps the old grant', async () => {
  const prior = await recordLocalAuthorization(old, new Date(D1));
  const since = localAuthorizationSeq();
  jest
    .spyOn(AsyncStorage, 'setItem')
    .mockRejectedValueOnce(new Error('disk full'))
    .mockRejectedValueOnce(new Error('disk full'));
  const a = recordLocalAuthorization(fresh, new Date(D2)).then(() => null, (e: unknown) => e);
  const b = recordLocalAuthorization(fresh, new Date(D3)).then(() => null, (e: unknown) => e);
  expect(await a).toBeInstanceOf(Error);
  expect(await b).toBeInstanceOf(Error);
  await retireOnDeviceSource(old.userId, source, prior.grantedAt, since);
  // The second write restored the first write's (failed) sequence, which is newer than `since`.
  expect((await getLocalAuthorization(old.userId, source))?.grantedAt).toBe(D1);
});

it('control for C-362-15: one failed grant write then an older Disconnect retires the old grant', async () => {
  const prior = await recordLocalAuthorization(old, new Date(D1));
  const since = localAuthorizationSeq();
  jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk full'));
  await expect(recordLocalAuthorization(fresh, new Date(D2))).rejects.toThrow('disk full');
  await retireOnDeviceSource(old.userId, source, prior.grantedAt, since);
  expect(await getLocalAuthorization(old.userId, source)).toBeNull();
});
