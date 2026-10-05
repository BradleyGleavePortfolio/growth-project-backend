/**
 * Real signOut, Connect/Refresh orchestration, session fence and state module.
 * Synthetic native-commit scheduler; no native build, network or health data.
 * Unrelated signOut integrations use the established authActions test seams.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { signOut } from '../authActions';
import { authEvents } from '../../utils/authEvents';
import {
  beginOnDeviceConnect,
  connectOnDevice,
  refreshOnDevice,
} from '../health/onDeviceSync';
import {
  emptyProgress,
  getLocalAuthorization,
  localAuthorizationSeq,
  recordLocalAuthorization,
  setSyncProgress,
  retireOnDeviceState,
  ON_DEVICE_STATE_PREFIX,
} from '../health/onDeviceState';
import { OnDeviceSessionChangedError } from '../health/sessionFence';
import type { WearableConnection } from '../../api/wearablesConnectionsApi';

jest.mock('../api', () => ({
  usersApi: { updatePushToken: jest.fn(async () => ({ data: {} })) },
  profileApi: { get: jest.fn(async () => ({ data: {} })) },
}));
jest.mock('../sentry', () => ({ setSentryUser: jest.fn() }));
jest.mock('../../lib/analytics', () => ({ reset: jest.fn() }));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
}));
jest.mock('../../lib/userCache', () => ({
  readUserCacheSync: jest.fn(() => ({ id: 'health-queue-user' })),
  readUserCache: jest.fn(async () => ({ id: 'health-queue-user' })),
  clearUserCache: jest.fn(async () => undefined),
}));
jest.mock('../../offline/sync/sync-engine', () => ({
  deleteWorkoutLogsForUser: jest.fn(async () => 0),
}));
jest.mock('../../storage/mmkv', () => {
  const storage = () => ({
    getString: () => undefined,
    getStringAsync: async () => undefined,
    getAllKeys: async () => [],
    delete: async () => undefined,
    set: async () => undefined,
  });
  return {
    clearAllStorage: jest.fn(async () => undefined),
    prefsStorage: storage(),
    cacheStorage: storage(),
    secureStorage: storage(),
  };
});
jest.mock('../queryClient', () => ({
  purgePersistedQueryCacheForAllUsers: jest.fn(async () => undefined),
  retireAndDrainIdentityPersistences: jest.fn(async () => undefined),
  settleAndClearQueryCache: jest.fn(async () => undefined),
}));
jest.mock('../../lib/consultation/storage', () => ({
  LEGACY_DRAFT_PREFIX: 'consultation_v1:',
  purgeConsultationDraft: jest.fn(async () => undefined),
}));
jest.mock('../../db/fastingDb', () => ({
  getActiveFast: jest.fn(async () => null),
  getFastingHistory: jest.fn(async () => []),
  startFast: jest.fn(async () => undefined),
  endFast: jest.fn(async () => undefined),
}));

const scope = {
  userId: 'health-queue-user',
  source: 'HEALTH_CONNECT' as const,
  connectionId: 'health-queue-connection',
};
const row: WearableConnection = {
  id: scope.connectionId,
  user_id: scope.userId,
  provider: scope.source,
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
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
};
const readUserId = async () => scope.userId;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((yes) => (resolve = yes));
  return { promise, resolve };
}

beforeEach(async () => {
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});
afterEach(() => jest.restoreAllMocks());

/**
 * Fresh JS module lifetime with the SAME disk service. This deliberately
 * resets signOutEpoch/authWrittenAt, not the stored keys. A positive control
 * proves that the isolated orchestrator sees the same persisted grant.
 */
function coldModules() {
  jest.doMock('@react-native-async-storage/async-storage', () => ({
    __esModule: true,
    default: AsyncStorage,
  }));
  let state: typeof import('../health/onDeviceState') | undefined;
  let sync: typeof import('../health/onDeviceSync') | undefined;
  jest.isolateModules(() => {
    state = require('../health/onDeviceState');
    sync = require('../health/onDeviceSync');
  });
  if (!state || !sync) throw new Error('cold module setup failed');
  return { state, sync };
}

it.each(['getAllKeys', 'removeMany'] as const)(
  '%s rejection: completed actual signOut must not resurrect an old grant after restart',
  async (operation) => {
    await recordLocalAuthorization(scope);
    if (operation === 'getAllKeys') {
      jest.spyOn(AsyncStorage, 'getAllKeys').mockRejectedValueOnce(new Error('synthetic transient I/O'));
    } else {
      const remove = AsyncStorage.removeMany.bind(AsyncStorage);
      jest.spyOn(AsyncStorage, 'removeMany').mockImplementation(async (keys) => {
        if (keys.some((key) => key.startsWith(ON_DEVICE_STATE_PREFIX))) {
          throw new Error('synthetic health-key removal failure');
        }
        await remove(keys);
      });
    }
    await signOut(scope.userId);
    expect(await getLocalAuthorization(scope.userId, scope.source)).toBeNull();
    const retained = (await AsyncStorage.getAllKeys()).filter((key) =>
      key.startsWith(`${ON_DEVICE_STATE_PREFIX}auth:`),
    );
    expect(retained).toHaveLength(1);
    jest.restoreAllMocks(); // I/O recovered before the new app lifetime.
    const cold = coldModules();
    const syncHealthConnect = jest.fn(async () => ({ normalizedCount: 0, complete: true }));
    const result = await cold.sync.refreshOnDevice(scope.source, [row], {
      readUserId,
      syncHealthConnect,
    });
    expect(result.kind).toBe('not_authorized');
    expect(syncHealthConnect).not.toHaveBeenCalled();
    expect(await cold.state.getLocalAuthorization(scope.userId, scope.source)).toBeNull();
  },
);

it('restart control: a genuinely authorized persisted grant survives module reload before logout', async () => {
  await recordLocalAuthorization(scope);
  const cold = coldModules();
  expect((await cold.state.getLocalAuthorization(scope.userId, scope.source))?.connectionId)
    .toBe(scope.connectionId);
  const syncHealthConnect = jest.fn(async () => ({ normalizedCount: 0, complete: true }));
  expect((await cold.sync.refreshOnDevice(scope.source, [row], {
    readUserId, syncHealthConnect,
  })).kind).toBe('imported');
  expect(syncHealthConnect).toHaveBeenCalled();
});

it('restart control: successful actual signOut removes grants from a fresh app lifetime', async () => {
  await recordLocalAuthorization(scope);
  await signOut(scope.userId);
  const cold = coldModules();
  const syncHealthConnect = jest.fn(async () => ({ normalizedCount: 0, complete: true }));
  expect((await cold.sync.refreshOnDevice(scope.source, [row], {
    readUserId, syncHealthConnect,
  })).kind).toBe('not_authorized');
  expect(syncHealthConnect).not.toHaveBeenCalled();
});

it.each(['in-flight native grant', 'queued grant behind native progress'] as const)(
  '%s: completed signOut must require a new Connect after same-account login',
  async (mode) => {
    // Pre-existing key ensures enumeration can see the exact key; the defect
    // is effect ordering, not only omission of a not-yet-created key.
    await recordLocalAuthorization(scope);
    const invoked = deferred();
    const commit = deferred();
    const set = AsyncStorage.setItem.bind(AsyncStorage);
    jest.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(async (key, value) => {
      invoked.resolve();
      await commit.promise;
      await set(key, value);
    });
    const syncHealthConnect = jest.fn(async (_scope, fence) => {
      await fence.assertCurrent();
      return { normalizedCount: 0, complete: true };
    });
    const fence = await beginOnDeviceConnect({ readUserId });
    const seq = localAuthorizationSeq();
    const progressing =
      mode === 'queued grant behind native progress'
        ? setSyncProgress(scope, { ...emptyProgress(), completedThrough: { Steps: row.created_at } })
        : Promise.resolve();
    const connecting = connectOnDevice(scope.source, fence, {
      readUserId,
      register: async () => row,
      syncHealthConnect,
    }).then(
      () => null,
      (err: unknown) => err,
    );
    await invoked.promise;
    for (let i = 0; i < 20 && localAuthorizationSeq() === seq; i += 1) await tick();
    expect(localAuthorizationSeq()).toBeGreaterThan(seq);
    // Release independently of either queued Connect or signOut: correct
    // draining cleanup can wait for native completion without driver deadlock.
    const signingOut = signOut(scope.userId);
    for (let i = 0; i < 5; i += 1) await tick();
    commit.resolve();
    await Promise.all([progressing, signingOut]);
    expect(await connecting).toBeInstanceOf(OnDeviceSessionChangedError);
    syncHealthConnect.mockClear();
    authEvents.emit('login');
    const outcome = await refreshOnDevice(scope.source, [row], { readUserId, syncHealthConnect });
    expect(outcome.kind).toBe('not_authorized');
    expect(syncHealthConnect).not.toHaveBeenCalled();
    expect(await getLocalAuthorization(scope.userId, scope.source)).toBeNull();
  },
);

it('control: settled Connect is removed by completed signOut, same-account refresh is unauthorized', async () => {
  await recordLocalAuthorization(scope);
  await signOut(scope.userId);
  authEvents.emit('login');
  const syncHealthConnect = jest.fn(async () => ({ normalizedCount: 0, complete: true }));
  expect(
    (await refreshOnDevice(scope.source, [row], { readUserId, syncHealthConnect })).kind,
  ).toBe('not_authorized');
  expect(syncHealthConnect).not.toHaveBeenCalled();
});

it.each(['grant', 'progress'] as const)(
  'control: rejected %s write is observable and does not poison unconditional retirement or later writes',
  async (kind) => {
    const failure = new Error('synthetic storage failure');
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(failure);
    await expect(
      kind === 'grant' ? recordLocalAuthorization(scope) : setSyncProgress(scope, emptyProgress()),
    ).rejects.toBe(failure);
    await recordLocalAuthorization(scope);
    await retireOnDeviceState();
    expect(await getLocalAuthorization(scope.userId, scope.source)).toBeNull();
    await recordLocalAuthorization(scope);
    expect((await getLocalAuthorization(scope.userId, scope.source))?.connectionId).toBe(scope.connectionId);
  },
);
