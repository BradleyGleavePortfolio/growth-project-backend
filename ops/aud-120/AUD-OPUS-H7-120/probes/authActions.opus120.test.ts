/**
 * AUD-OPUS-H7-120 probe (Claude Opus 5.5 lens, agent 120): mobile #369 @ 3252ec79,
 * the real signOut() with the SecureStore consent authority. Unrelated signOut
 * integrations use the established authActions test seams. Synthetic storage
 * only; no native build, network or health data.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { signOut } from '../authActions';
import { authEvents } from '../../utils/authEvents';
import {
  ON_DEVICE_CONSENT_AUTHORITY_KEY,
  getLocalAuthorization,
  recordLocalAuthorization,
} from '../health/onDeviceState';
import { secureStorage } from '../secureStorage';

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
  readUserCacheSync: jest.fn(() => ({ id: 'opus-h7-signout-user' })),
  readUserCache: jest.fn(async () => ({ id: 'opus-h7-signout-user' })),
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
  userId: 'opus-h7-signout-user',
  source: 'HEALTH_CONNECT' as const,
  connectionId: 'opus-h7-signout-connection',
};
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

function restartState(): typeof import('../health/onDeviceState') {
  let state: typeof import('../health/onDeviceState') | undefined;
  jest.isolateModules(() => {
    jest.doMock('@react-native-async-storage/async-storage', () => ({
      __esModule: true,
      default: AsyncStorage,
    }));
    jest.doMock('expo-secure-store', () => SecureStore);
    state = require('../health/onDeviceState');
  });
  if (!state) throw new Error('restart setup failed');
  return state;
}

const logout = jest.fn();
beforeEach(async () => {
  jest.restoreAllMocks();
  resetSecureStoreMock();
  await AsyncStorage.clear();
  secureMap.clear();
  logout.mockClear();
  authEvents.on('logout', logout);
});
afterEach(() => {
  authEvents.off('logout', logout);
  jest.restoreAllMocks();
});

it('signOut revokes the consent authority synchronously, before its first await', async () => {
  await recordLocalAuthorization(scope);
  secure.deleteItemAsync.mockClear();
  const signingOut = signOut(scope.userId);
  const revokedBeforeAwait = secure.deleteItemAsync.mock.calls.some(
    ([k]) => k === ON_DEVICE_CONSENT_AUTHORITY_KEY,
  );
  await signingOut;
  expect(revokedBeforeAwait).toBe(true);
  expect(logout).toHaveBeenCalledTimes(1);
  expect(secureMap.has(ON_DEVICE_CONSENT_AUTHORITY_KEY)).toBe(false);
});

it('locked iOS Keychain at sign-out (delete resolves without deleting; token deletes too): logout fires, the grant is void after a restart through the session', async () => {
  await recordLocalAuthorization(scope);
  await secureStorage.setItem('supabase_token', 'opaque-token');
  secure.deleteItemAsync.mockReset().mockImplementation(async () => undefined);
  await expect(signOut(scope.userId)).resolves.toBeUndefined();
  expect(logout).toHaveBeenCalledTimes(1);
  resetSecureStoreMock();
  // The token survived as well: sign-out itself was not durable in SecureStore.
  expect(secureMap.get('supabase_token')).toBe('opaque-token');
  expect(await restartState().getLocalAuthorization(scope.userId, scope.source)).toBeNull();
});

it('Android-faithful SecureStore failure (delete and replacement write reject) with working AsyncStorage: logout fires, grant void after a restart', async () => {
  await recordLocalAuthorization(scope);
  secure.deleteItemAsync.mockReset().mockRejectedValue(new Error('synthetic DeleteException'));
  secure.setItemAsync.mockReset().mockRejectedValue(new Error('synthetic EncryptException'));
  await expect(signOut(scope.userId)).resolves.toBeUndefined();
  expect(logout).toHaveBeenCalledTimes(1);
  resetSecureStoreMock();
  expect(await restartState().getLocalAuthorization(scope.userId, scope.source)).toBeNull();
});

it('SecureStore unavailable (every call rejects, as on web): signOut still resolves and emits logout once', async () => {
  secure.deleteItemAsync.mockReset().mockRejectedValue(new Error('UnavailabilityError'));
  secure.setItemAsync.mockReset().mockRejectedValue(new Error('UnavailabilityError'));
  secure.getItemAsync.mockReset().mockRejectedValue(new Error('UnavailabilityError'));
  await expect(signOut(scope.userId)).resolves.toBeUndefined();
  expect(logout).toHaveBeenCalledTimes(1);
  expect(await getLocalAuthorization(scope.userId, scope.source)).toBeNull();
});

it('control: the same account without a sign-out keeps its consent across a restart', async () => {
  await recordLocalAuthorization(scope);
  expect((await restartState().getLocalAuthorization(scope.userId, scope.source))?.connectionId).toBe(
    scope.connectionId,
  );
});
