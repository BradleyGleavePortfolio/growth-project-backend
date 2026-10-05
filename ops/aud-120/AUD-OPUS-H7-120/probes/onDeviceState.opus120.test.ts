/**
 * AUD-OPUS-H7-120 probe (Claude Opus 5.5 lens, agent 120): mobile #369 @ 3252ec79
 * consent session + SecureStore authority. Synthetic storage on the jest
 * AsyncStorage / expo-secure-store mocks; a restart is a fresh module lifetime
 * over the same two stores. No native build, network or health data.
 * Cases prefixed "DOCUMENTS" assert the CURRENT behaviour behind a C finding.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import {
  ON_DEVICE_CONSENT_AUTHORITY_KEY,
  ON_DEVICE_CONSENT_SESSION_KEY,
  ON_DEVICE_STATE_PREFIX,
  getLocalAuthorization,
  localAuthorizationSeq,
  recordLocalAuthorization,
  retireOnDeviceSource,
  retireOnDeviceStateAtSignOut,
} from '../onDeviceState';

const source = 'HEALTH_CONNECT' as const;
const old = { userId: 'opus-h7-user', source, connectionId: 'old-connection' };
const fresh = { ...old, connectionId: 'fresh-connection' };
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

/** Every AsyncStorage mutation rejects; reads still work. */
function asyncStorageMutationOutage() {
  const failure = new Error('synthetic backing-store mutation outage');
  jest.spyOn(AsyncStorage, 'setItem').mockRejectedValue(failure);
  jest.spyOn(AsyncStorage, 'removeItem').mockRejectedValue(failure);
  jest.spyOn(AsyncStorage, 'removeMany').mockRejectedValue(failure);
}

/** expo-secure-store 56.0.4 iOS: deleteValueWithKeyAsync ignores the SecItemDelete status (locked Keychain = silent no-op). */
function iosSilentKeychainDeleteFailure() {
  secure.deleteItemAsync.mockReset().mockImplementation(async () => undefined);
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

it('CLOSED C-362-14 (flipped opus119f): a failed sign-out removal stays void after a restart; another account reads nothing', async () => {
  await recordLocalAuthorization(old, D1);
  jest.spyOn(AsyncStorage, 'removeMany').mockRejectedValueOnce(new Error('synthetic removal failure'));
  await retireOnDeviceStateAtSignOut();
  expect(await getLocalAuthorization(old.userId, source)).toBeNull();
  expect((await healthKeys()).length).toBeGreaterThan(0); // the grant is still on disk
  const next = restart();
  expect(await next.getLocalAuthorization(old.userId, source)).toBeNull();
  expect(await next.getLocalAuthorization('opus-h7-other', source)).toBeNull();
});

it('CLOSED C-362-15 (flipped opus119f): two overlapping grant writes that both fail; an older Disconnect still retires the old grant', async () => {
  const prior = await recordLocalAuthorization(old, D1);
  const since = localAuthorizationSeq();
  jest
    .spyOn(AsyncStorage, 'setItem')
    .mockRejectedValueOnce(new Error('disk full'))
    .mockRejectedValueOnce(new Error('disk full'));
  const a = recordLocalAuthorization(fresh, D2).then(() => null, (e: unknown) => e);
  const b = recordLocalAuthorization(fresh, D3).then(() => null, (e: unknown) => e);
  expect(await a).toBeInstanceOf(Error);
  expect(await b).toBeInstanceOf(Error);
  await retireOnDeviceSource(old.userId, source, prior.grantedAt, since);
  expect(await getLocalAuthorization(old.userId, source)).toBeNull();
});

it('iOS-faithful: a silent Keychain delete failure with working AsyncStorage still voids the grant after a restart (session path)', async () => {
  await recordLocalAuthorization(old, D1);
  iosSilentKeychainDeleteFailure();
  await retireOnDeviceStateAtSignOut();
  resetSecureStoreMock();
  expect(await SecureStore.getItemAsync(ON_DEVICE_CONSENT_AUTHORITY_KEY)).toEqual(expect.any(String));
  expect(await healthKeys()).toEqual([]);
  expect(await restart().getLocalAuthorization(old.userId, source)).toBeNull();
});

it('DOCUMENTS C-369-4: iOS-faithful silent Keychain delete failure never reaches the replacement write; with an AsyncStorage mutation outage too, the old grant is honoured after a restart', async () => {
  await recordLocalAuthorization(old, D1);
  const authorityBefore = secureMap.get(ON_DEVICE_CONSENT_AUTHORITY_KEY);
  secure.setItemAsync.mockClear(); // count only sign-out's writes
  iosSilentKeychainDeleteFailure();
  asyncStorageMutationOutage();
  await retireOnDeviceStateAtSignOut();
  const replacementWrites = secure.setItemAsync.mock.calls.filter(
    ([k]) => k === ON_DEVICE_CONSENT_AUTHORITY_KEY,
  ).length;
  jest.restoreAllMocks();
  resetSecureStoreMock();
  expect(replacementWrites).toBe(0);
  expect(secureMap.get(ON_DEVICE_CONSENT_AUTHORITY_KEY)).toBe(authorityBefore);
  expect((await restart().getLocalAuthorization(old.userId, source))?.connectionId).toBe(
    old.connectionId,
  );
});

it('a Connect made right after sign-out (queued behind the held sign-out chain) survives the in-chain second revocation and a restart', async () => {
  await recordLocalAuthorization(old, D1);
  const invoked = deferred();
  const commit = deferred();
  const set = AsyncStorage.setItem.bind(AsyncStorage);
  jest.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(async (k, v) => {
    invoked.resolve();
    await commit.promise;
    await set(k, v);
  });
  const held = recordLocalAuthorization(old, D2).then(() => null, (e: unknown) => e); // in flight
  await invoked.promise;
  const signingOut = retireOnDeviceStateAtSignOut();
  // Next person (here the same account) signs in and taps Connect at once.
  const reconnect = recordLocalAuthorization(fresh, D3);
  await tick();
  commit.resolve();
  await Promise.all([held, signingOut, reconnect]);
  expect((await getLocalAuthorization(old.userId, source))?.connectionId).toBe(fresh.connectionId);
  expect((await restart().getLocalAuthorization(old.userId, source))?.connectionId).toBe(
    fresh.connectionId,
  );
});

it('an in-flight grant write that read the old authority before sign-out: an app exit before the chain runs leaves it void after a restart', async () => {
  await recordLocalAuthorization(old, D1); // session + authority exist
  const invoked = deferred();
  const commit = deferred();
  const set = AsyncStorage.setItem.bind(AsyncStorage);
  jest.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(async (k, v) => {
    invoked.resolve();
    await commit.promise;
    await set(k, v); // the grant bound to the OLD authority reaches disk
  });
  const writing = recordLocalAuthorization(fresh, D2).then(() => null, (e: unknown) => e);
  await invoked.promise; // authority already read
  const signingOut = retireOnDeviceStateAtSignOut();
  commit.resolve();
  await writing; // the grant reached disk, the chain op has not completed yet
  const afterExit = await restart().getLocalAuthorization(old.userId, source);
  await signingOut;
  expect(afterExit).toBeNull();
});

it('a failed sign-out (AsyncStorage outage) then the same account signs in again in the same run: no grant until a new Connect, which survives a restart', async () => {
  await recordLocalAuthorization(old, D1);
  asyncStorageMutationOutage();
  await retireOnDeviceStateAtSignOut();
  jest.restoreAllMocks();
  resetSecureStoreMock();
  expect(await getLocalAuthorization(old.userId, source)).toBeNull();
  expect(await restart().getLocalAuthorization(old.userId, source)).toBeNull();
  await recordLocalAuthorization(fresh, D2);
  expect((await getLocalAuthorization(old.userId, source))?.connectionId).toBe(fresh.connectionId);
  expect((await restart().getLocalAuthorization(old.userId, source))?.connectionId).toBe(
    fresh.connectionId,
  );
});

it('control: Disconnect then Connect again keeps working across a restart (Disconnect does not touch the authority)', async () => {
  const prior = await recordLocalAuthorization(old, D1);
  const authority = secureMap.get(ON_DEVICE_CONSENT_AUTHORITY_KEY);
  await retireOnDeviceSource(old.userId, source, prior.grantedAt, localAuthorizationSeq());
  expect(await getLocalAuthorization(old.userId, source)).toBeNull();
  expect(secureMap.get(ON_DEVICE_CONSENT_AUTHORITY_KEY)).toBe(authority);
  await recordLocalAuthorization(fresh, D2);
  expect((await restart().getLocalAuthorization(old.userId, source))?.connectionId).toBe(
    fresh.connectionId,
  );
});

it('a sign-out with no stored authority writes none (no spurious SecureStore value)', async () => {
  await retireOnDeviceStateAtSignOut();
  expect(secureMap.has(ON_DEVICE_CONSENT_AUTHORITY_KEY)).toBe(false);
  expect(secure.setItemAsync).not.toHaveBeenCalled();
  expect(await AsyncStorage.getItem(ON_DEVICE_CONSENT_SESSION_KEY)).toEqual(expect.any(String));
});

it('an unreadable authority after a restart (locked Keychain) reads null without removing anything; once readable the same consent authorizes again', async () => {
  await recordLocalAuthorization(old, D1);
  const next = restart();
  secure.getItemAsync.mockRejectedValueOnce(new Error('synthetic errSecInteractionNotAllowed'));
  expect(await next.getLocalAuthorization(old.userId, source)).toBeNull();
  expect((await healthKeys()).length).toBe(1);
  expect((await next.getLocalAuthorization(old.userId, source))?.connectionId).toBe(old.connectionId);
});

it('another account never reads a grant bound to the current authority and session', async () => {
  await recordLocalAuthorization(old, D1);
  const raw = JSON.parse((await AsyncStorage.getItem(`${ON_DEVICE_STATE_PREFIX}auth:${source}:${old.userId}`)) ?? '{}');
  // A copy under another account's key (same session and authority) still needs userId to match.
  await AsyncStorage.setItem(`${ON_DEVICE_STATE_PREFIX}auth:${source}:opus-h7-other`, JSON.stringify(raw));
  expect(await getLocalAuthorization('opus-h7-other', source)).toBeNull();
});
