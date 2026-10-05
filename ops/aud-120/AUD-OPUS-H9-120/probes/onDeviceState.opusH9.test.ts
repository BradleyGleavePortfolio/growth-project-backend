/**
 * AUD-OPUS-H9-120 probe (Claude Opus 5.5 lens, agent 120): #369 FIX ROUND 2
 * (a2bfe2fa, Sol B-369-2). A Connect write already running when sign-out
 * starts, held at each native step the fix fences; plus liveness after
 * sign-out and the grant write that was issued before sign-out began.
 * A restart is a fresh module lifetime over the SAME disk. Synthetic storage
 * only; no native build, network or health data. Lane only, never merge.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import {
  ON_DEVICE_CONSENT_AUTHORITY_KEY,
  ON_DEVICE_CONSENT_SESSION_KEY,
  ON_DEVICE_STATE_PREFIX,
  getLocalAuthorization,
  getSyncProgress,
  recordLocalAuthorization,
  retireOnDeviceStateAtSignOut,
  setSyncProgress,
} from '../onDeviceState';
import { OnDeviceSessionChangedError } from '../sessionFence';

const old = { userId: 'opus-h9-user', source: 'HEALTH_CONNECT' as const, connectionId: 'old-connection' };
const fresh = { ...old, connectionId: 'fresh-connection' };
const grantKey = `${ON_DEVICE_STATE_PREFIX}auth:${old.source}:${old.userId}`;
const D1 = new Date('2026-10-01T00:00:00.000Z');
const D2 = new Date('2026-10-02T00:00:00.000Z');
const D3 = new Date('2026-10-03T00:00:00.000Z');
const secure = jest.mocked(SecureStore);
const secureMap = (SecureStore as unknown as { __store: Map<string, string> }).__store;

function resetSecureStoreMock() {
  secure.getItemAsync.mockReset().mockImplementation(async (k) => secureMap.get(k) ?? null);
  secure.setItemAsync.mockReset().mockImplementation(async (k, v) => {
    secureMap.set(k, v);
  });
  secure.deleteItemAsync.mockReset().mockImplementation(async (k) => {
    secureMap.delete(k);
  });
}

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((yes) => (resolve = yes));
  return { resolve, promise };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function restart(): typeof import('../onDeviceState') {
  let state: typeof import('../onDeviceState') | undefined;
  jest.isolateModules(() => {
    jest.doMock('@react-native-async-storage/async-storage', () => ({
      __esModule: true,
      default: AsyncStorage,
    }));
    jest.doMock('expo-secure-store', () => SecureStore);
    state = require('../onDeviceState');
  });
  if (!state) throw new Error('restart setup failed');
  return state;
}

/** Hold the chain's second revocation (the app exits there). */
function holdChainRevocation(failFirst = false) {
  const reached = deferred();
  const release = deferred();
  let deletes = 0;
  secure.deleteItemAsync.mockImplementation(async (k) => {
    deletes += 1;
    if (deletes === 1 && failFirst) throw new Error('synthetic Keystore delete failure');
    if (deletes === 2) {
      reached.resolve();
      await release.promise;
    }
    secureMap.delete(k);
  });
  return { reached, release };
}

async function healthKeys(): Promise<readonly string[]> {
  return (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(ON_DEVICE_STATE_PREFIX));
}

beforeEach(async () => {
  jest.restoreAllMocks();
  resetSecureStoreMock();
  await AsyncStorage.clear();
  secureMap.clear();
});
afterEach(() => jest.restoreAllMocks());

it('H9-1: a first Connect held at its session WRITE when sign-out starts stops and leaves no consent, even at an exit before the chain', async () => {
  const held = deferred();
  const release = deferred();
  const set = AsyncStorage.setItem.bind(AsyncStorage);
  jest.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(async (k, v) => {
    held.resolve();
    await release.promise;
    await set(k, v); // the new session lands after sign-out began
  });
  const chain = holdChainRevocation();
  const writing = recordLocalAuthorization(fresh, D2).then(
    () => null,
    (e: unknown) => e,
  );
  await held.promise;
  const signingOut = retireOnDeviceStateAtSignOut();
  release.resolve();
  await chain.reached.promise;
  let atExit: unknown = 'unset';
  try {
    atExit = await restart().getLocalAuthorization(fresh.userId, fresh.source);
  } finally {
    chain.release.resolve();
  }
  await signingOut;
  expect(await writing).toBeInstanceOf(OnDeviceSessionChangedError);
  expect(atExit).toBeNull();
  expect(await AsyncStorage.getItem(grantKey)).toBeNull();
  expect(await SecureStore.getItemAsync(ON_DEVICE_CONSENT_AUTHORITY_KEY)).toBeNull();
  expect(await restart().getLocalAuthorization(fresh.userId, fresh.source)).toBeNull();
});

it('H9-2: a Connect held at its authority READ when sign-out starts stops before the grant write', async () => {
  await recordLocalAuthorization(old, D1); // session and authority exist
  const held = deferred();
  const release = deferred();
  secure.getItemAsync.mockImplementationOnce(async (k) => {
    const value = secureMap.get(k) ?? null; // read before sign-out, delivered after
    held.resolve();
    await release.promise;
    return value;
  });
  const chain = holdChainRevocation();
  const writing = recordLocalAuthorization(fresh, D2).then(
    () => null,
    (e: unknown) => e,
  );
  await held.promise;
  const signingOut = retireOnDeviceStateAtSignOut();
  release.resolve();
  await chain.reached.promise;
  let atExit: unknown = 'unset';
  try {
    atExit = await restart().getLocalAuthorization(fresh.userId, fresh.source);
  } finally {
    chain.release.resolve();
  }
  await signingOut;
  expect(await writing).toBeInstanceOf(OnDeviceSessionChangedError);
  expect(atExit).toBeNull();
  expect(JSON.parse((await AsyncStorage.getItem(grantKey)) ?? 'null')?.connectionId).not.toBe(
    fresh.connectionId,
  );
  expect(await restart().getLocalAuthorization(old.userId, old.source)).toBeNull();
});

it.each([
  ['the immediate revocation deletes', false],
  ['the immediate delete fails (Android) and a new authority replaces it', true],
] as const)(
  'H9-3: a grant write issued before sign-out that commits after it stays void at an exit before the chain (%s)',
  async (_label, failFirst) => {
    await recordLocalAuthorization(old, D1); // session and authority exist: the next setItem is the grant
    const held = deferred();
    const release = deferred();
    const set = AsyncStorage.setItem.bind(AsyncStorage);
    jest.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(async (k, v) => {
      held.resolve();
      await release.promise;
      await set(k, v);
    });
    const chain = holdChainRevocation(failFirst);
    const writing = recordLocalAuthorization(fresh, D2).then(
      () => 'resolved',
      (e: unknown) => e,
    );
    await held.promise;
    const signingOut = retireOnDeviceStateAtSignOut();
    release.resolve();
    await chain.reached.promise;
    // The grant write was handed to the native module before sign-out began,
    // so it lands (no fence can undo it), bound to the revoked authority.
    let committed: string | null = null;
    let atExit: unknown = 'unset';
    let inRun: unknown = 'unset';
    try {
      committed = JSON.parse((await AsyncStorage.getItem(grantKey)) ?? 'null')?.connectionId ?? null;
      atExit = await restart().getLocalAuthorization(fresh.userId, fresh.source);
      inRun = await Promise.race([
        getLocalAuthorization(fresh.userId, fresh.source),
        tick().then(() => 'pending'),
      ]);
    } finally {
      chain.release.resolve();
    }
    await signingOut;
    expect(await writing).toBe('resolved');
    expect(committed).toBe(fresh.connectionId);
    expect(atExit).toBeNull();
    expect(inRun === null || inRun === 'pending').toBe(true);
    expect(await getLocalAuthorization(fresh.userId, fresh.source)).toBeNull();
    expect(await restart().getLocalAuthorization(fresh.userId, fresh.source)).toBeNull();
  },
);

it('H9-4: two Connect writes, the first running and the second queued at sign-out: both stop, no consent', async () => {
  const held = deferred();
  const release = deferred();
  const get = AsyncStorage.getItem.bind(AsyncStorage);
  jest.spyOn(AsyncStorage, 'getItem').mockImplementationOnce(async (k) => {
    const value = await get(k);
    held.resolve();
    await release.promise;
    return value;
  });
  const first = recordLocalAuthorization(old, D2).then(
    () => null,
    (e: unknown) => e,
  );
  const second = recordLocalAuthorization(fresh, D3).then(
    () => null,
    (e: unknown) => e,
  );
  await held.promise;
  const signingOut = retireOnDeviceStateAtSignOut();
  release.resolve();
  await signingOut;
  expect(await first).toBeInstanceOf(OnDeviceSessionChangedError);
  expect(await second).toBeInstanceOf(OnDeviceSessionChangedError);
  expect(await healthKeys()).toEqual([]);
  expect(await SecureStore.getItemAsync(ON_DEVICE_CONSENT_AUTHORITY_KEY)).toBeNull();
  expect(await restart().getLocalAuthorization(old.userId, old.source)).toBeNull();
});

it('H9-5 liveness: a Connect and a progress save started after sign-out finished work normally, in this run and after a restart', async () => {
  await recordLocalAuthorization(old, D1);
  await retireOnDeviceStateAtSignOut();
  const sessionAfterSignOut = await AsyncStorage.getItem(ON_DEVICE_CONSENT_SESSION_KEY);
  await expect(recordLocalAuthorization(fresh, D2)).resolves.toEqual(
    expect.objectContaining({ connectionId: fresh.connectionId }),
  );
  expect(await getLocalAuthorization(fresh.userId, fresh.source)).toEqual(
    expect.objectContaining({ connectionId: fresh.connectionId }),
  );
  expect(await restart().getLocalAuthorization(fresh.userId, fresh.source)).toEqual(
    expect.objectContaining({ connectionId: fresh.connectionId }),
  );
  // The new grant reuses the session sign-out wrote and binds a NEW authority.
  expect(await AsyncStorage.getItem(ON_DEVICE_CONSENT_SESSION_KEY)).toBe(sessionAfterSignOut);
  expect(await SecureStore.getItemAsync(ON_DEVICE_CONSENT_AUTHORITY_KEY)).not.toBeNull();
  const scope = { userId: fresh.userId, connectionId: fresh.connectionId, source: fresh.source };
  await setSyncProgress(scope, { v: 1, completedThrough: { Steps: D2.toISOString() }, resume: {} });
  expect((await getSyncProgress(scope)).completedThrough.Steps).toBe(D2.toISOString());
});

it('H9-6 (opus119f C-362-12 replay at the new contract): a first grant write in flight at sign-out rejects as stopped and leaves no key and no grant', async () => {
  const commit = deferred();
  const set = AsyncStorage.setItem.bind(AsyncStorage);
  jest.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(async (k: string, v: string) => {
    await commit.promise;
    await set(k, v);
  });
  const writing = recordLocalAuthorization(old, D3).then(
    () => null,
    (e: unknown) => e,
  );
  await tick();
  const retired = retireOnDeviceStateAtSignOut();
  commit.resolve();
  await retired;
  expect(await writing).toBeInstanceOf(OnDeviceSessionChangedError);
  expect(await healthKeys()).toEqual([]);
  expect(await getLocalAuthorization(old.userId, old.source)).toBeNull();
  expect(await restart().getLocalAuthorization(old.userId, old.source)).toBeNull();
});
