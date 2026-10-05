/**
 * AUD-OPUS-H46E-119 probe (Claude Opus 5.5 lens, agent 119): the onDeviceState
 * serial storage queue (FIX ROUND 4, df44285d). Synthetic storage scheduler on
 * the jest AsyncStorage mock; no native build, no network.
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
  setSyncProgress,
} from '../onDeviceState';

const source = 'HEALTH_CONNECT' as const;
const old = { userId: 'opus-e-user', source, connectionId: 'old-connection' };
const fresh = { ...old, connectionId: 'fresh-connection' };
const D1 = '2026-10-01T00:00:00.000Z';
const D2 = '2026-10-02T00:00:00.000Z';
const D3 = '2026-10-03T00:00:00.000Z';

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((yes) => (resolve = yes));
  return { resolve, promise };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Same sweep shape as authActions.signOut (getAllKeys + prefix filter + removeMany). */
async function signOutPrefixSweep() {
  const all = await AsyncStorage.getAllKeys();
  const matching = all.filter((k) => k.startsWith(ON_DEVICE_STATE_PREFIX));
  if (matching.length) await AsyncStorage.removeMany(matching);
}

beforeEach(async () => {
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});
afterEach(() => jest.restoreAllMocks());

it('a rejected grant write reaches its caller; reads, removals and writes queued behind it still run', async () => {
  const prior = await recordLocalAuthorization(old, new Date(D1));
  const failure = new Error('disk full');
  jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(failure);
  const failing = recordLocalAuthorization(fresh, new Date(D2));
  const behind = setSyncProgress(old, { ...emptyProgress(), completedThrough: { Steps: D2 } });
  await expect(failing).rejects.toBe(failure);
  await behind;
  expect((await getLocalAuthorization(old.userId, source))?.grantedAt).toBe(prior.grantedAt);
  expect((await getSyncProgress(old)).completedThrough.Steps).toBe(D2);
  await retireOnDeviceSource(old.userId, source, prior.grantedAt, localAuthorizationSeq());
  expect(await getLocalAuthorization(old.userId, source)).toBeNull();
});

it('a rejected progress write after a removal never stalls the next grant write', async () => {
  const prior = await recordLocalAuthorization(old, new Date(D1));
  jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('io'));
  const retiring = retireOnDeviceSource(old.userId, source, prior.grantedAt, localAuthorizationSeq());
  await retiring;
  await expect(setSyncProgress(old, emptyProgress())).rejects.toThrow('io');
  await recordLocalAuthorization(fresh, new Date(D2));
  expect((await getLocalAuthorization(old.userId, source))?.connectionId).toBe(fresh.connectionId);
});

it('two overlapping Disconnects (owner and no-session) and a Connect mid-removal: one native op at a time, the Connect survives', async () => {
  const prior = await recordLocalAuthorization(old, new Date(D1));
  await setSyncProgress(old, { ...emptyProgress(), completedThrough: { Steps: D1 } });
  const since = localAuthorizationSeq();
  let inFlight = 0;
  let maxInFlight = 0;
  let started = 0;
  const track = async <T,>(op: () => Promise<T>): Promise<T> => {
    inFlight += 1;
    started += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    try {
      return await op();
    } finally {
      inFlight -= 1;
    }
  };
  const set = AsyncStorage.setItem.bind(AsyncStorage);
  const remove = AsyncStorage.removeMany.bind(AsyncStorage);
  jest.spyOn(AsyncStorage, 'setItem').mockImplementation((k: string, v: string) => track(() => set(k, v)));
  jest.spyOn(AsyncStorage, 'removeMany').mockImplementation((keys: string[]) => track(() => remove(keys)));
  const a = retireOnDeviceSource(old.userId, source, prior.grantedAt, since);
  const b = retireOnDeviceSource(null, source, null, since);
  while (started === 0) await tick();
  const connecting = recordLocalAuthorization(fresh, new Date(D2));
  const progressing = setSyncProgress(fresh, { ...emptyProgress(), completedThrough: { Steps: D2 } });
  await Promise.all([a, b, connecting, progressing]);
  expect(maxInFlight).toBe(1);
  expect((await getLocalAuthorization(old.userId, source))?.connectionId).toBe(fresh.connectionId);
  expect((await getSyncProgress(fresh)).completedThrough.Steps).toBe(D2);
  expect(await getSyncProgress(old)).toEqual(emptyProgress());
});

it('a grant read waits for a held grant write and then returns it (read-after-write)', async () => {
  await recordLocalAuthorization(old, new Date(D1));
  const commit = deferred();
  const set = AsyncStorage.setItem.bind(AsyncStorage);
  jest.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(async (k: string, v: string) => {
    await commit.promise;
    await set(k, v);
  });
  const writing = recordLocalAuthorization(fresh, new Date(D2));
  let read: string | null | undefined;
  const reading = getLocalAuthorization(old.userId, source).then((r) => (read = r?.connectionId ?? null));
  await tick();
  await tick();
  expect(read).toBeUndefined(); // still waiting on the queue
  commit.resolve();
  await Promise.all([writing, reading]);
  expect(read).toBe(fresh.connectionId);
});

it('DOCUMENTS C-362-12: a grant write in flight during the sign-out prefix sweep survives the sweep', async () => {
  const commit = deferred();
  const set = AsyncStorage.setItem.bind(AsyncStorage);
  jest.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(async (k: string, v: string) => {
    await commit.promise;
    await set(k, v);
  });
  const writing = recordLocalAuthorization(old, new Date(D3));
  await tick();
  await signOutPrefixSweep(); // outside the onDeviceState queue
  commit.resolve();
  await writing;
  expect((await getLocalAuthorization(old.userId, source))?.grantedAt).toBe(D3);
});

it('control for C-362-12: a sweep that first drains the queue leaves no grant', async () => {
  const commit = deferred();
  const set = AsyncStorage.setItem.bind(AsyncStorage);
  jest.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(async (k: string, v: string) => {
    await commit.promise;
    await set(k, v);
  });
  const writing = recordLocalAuthorization(old, new Date(D3));
  await tick();
  commit.resolve();
  await writing; // stands in for "await the onDeviceState tail"
  await signOutPrefixSweep();
  expect(await getLocalAuthorization(old.userId, source)).toBeNull();
});

it('C-362-13 repaired: a Disconnect older than a REJECTED grant write retires the old grant', async () => {
  const prior = await recordLocalAuthorization(old, new Date(D1));
  const since = localAuthorizationSeq();
  jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk full'));
  await expect(recordLocalAuthorization(fresh, new Date(D2))).rejects.toThrow('disk full');
  await retireOnDeviceSource(old.userId, source, prior.grantedAt, since);
  // A rejected grant must not count as a successful later Connect.
  expect(await getLocalAuthorization(old.userId, source)).toBeNull();
});
