/**
 * B-HC5-119 (Sol B-362-2, B-362-6): Disconnect against account switches and newer Connects
 * during every storage await. The four Sol119 cases are the AUD-SOL-H46-119 probe (run
 * 37229474471) unchanged; the rest pin the error class, the newer connection's progress and
 * another account's grant. Only the network and native edges are doubles.
 */
import React from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { healthConnectEnabled: true } } },
}));
jest.mock('../utils/logger', () => ({ logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() } }));
let mockSignedIn: string | null = 'user-a';
jest.mock('../lib/userCache', () => ({
  readUserCache: jest.fn(async () => (mockSignedIn == null ? null : { id: mockSignedIn })),
}));
const mockDisconnect = jest.fn();
jest.mock('../api/wearablesConnectionsApi', () => ({
  wearablesConnectionsApi: { disconnect: (...args: unknown[]) => mockDisconnect(...args) },
}));
const mockReadRecords = jest.fn();
jest.mock('react-native-health-connect', () => ({
  readRecords: (...args: unknown[]) => mockReadRecords(...args),
}));

import { useDisconnectProvider } from './useWearableConnections';
import { isOnDeviceStop } from '../services/health/sessionFence';
import { authEvents } from '../utils/authEvents';
import {
  getLocalAuthorization,
  getSyncProgress,
  emptyProgress,
  recordLocalAuthorization,
  retireOnDeviceSource,
  setSyncProgress,
} from '../services/health/onDeviceState';
import { readUserCache } from '../lib/userCache';

const scope = { userId: 'user-a', connectionId: 'conn-a', source: 'HEALTH_CONNECT' as const };
const oldOS = Platform.OS;
const clients: QueryClient[] = [];
async function disconnectHook() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  clients.push(qc);
  const invalidate = jest.spyOn(qc, 'invalidateQueries');
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const { result } = await renderHook(() => useDisconnectProvider(), { wrapper });
  return { result, invalidate };
}
function deferred<T>() {
  let resolve: (x: T) => void = () => undefined;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { resolve, promise };
}
beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  mockSignedIn = 'user-a';
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
  mockDisconnect.mockReset().mockImplementation(async (provider: string) => ({ provider }));
  mockReadRecords.mockReset();
});
afterEach(() => {
  jest.restoreAllMocks();
  clients.splice(0).forEach((qc) => qc.clear());
  Object.defineProperty(Platform, 'OS', { configurable: true, value: oldOS });
});

describe('useDisconnectProvider: session epoch and grant generation', () => {
  it.each([false, true])(
    'Sol119 identity capture held, switch=%p: an obsolete action never sends a new-session Disconnect',
    async (switchAccount) => {
      await recordLocalAuthorization(scope);
      const identity = deferred<{ id: string }>();
      jest.mocked(readUserCache).mockImplementationOnce(() => identity.promise as never);
      const { result } = await disconnectHook();
      let pending: Promise<unknown> = Promise.resolve();
      await act(async () => {
        pending = result.current.mutateAsync('HEALTH_CONNECT').catch(() => undefined);
      });
      await waitFor(() => expect(readUserCache).toHaveBeenCalled());
      expect(mockDisconnect).not.toHaveBeenCalled();
      if (switchAccount) {
        mockSignedIn = 'user-b';
        authEvents.emit('login');
        await recordLocalAuthorization({ ...scope, userId: 'user-b', connectionId: 'conn-b' });
      }
      await act(async () => {
        identity.resolve({ id: 'user-a' });
        await pending;
      });
      expect(mockDisconnect).toHaveBeenCalledTimes(switchAccount ? 0 : 1);
      if (switchAccount) {
        expect((await getLocalAuthorization('user-b', scope.source))?.connectionId).toBe('conn-b');
      }
    },
  );

  it.each([false, true])(
    'Sol119 local grant capture held, switch=%p: an obsolete action never sends a new-session Disconnect',
    async (switchAccount) => {
      await recordLocalAuthorization(scope);
      const old = await AsyncStorage.getItem('wearables_on_device:auth:HEALTH_CONNECT:user-a');
      const stored = deferred<string | null>();
      jest.spyOn(AsyncStorage, 'getItem').mockClear().mockImplementationOnce(() => stored.promise);
      const { result } = await disconnectHook();
      let pending: Promise<unknown> = Promise.resolve();
      await act(async () => {
        pending = result.current.mutateAsync('HEALTH_CONNECT').catch(() => undefined);
      });
      await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
      expect(mockDisconnect).not.toHaveBeenCalled();
      if (switchAccount) {
        mockSignedIn = 'user-b';
        authEvents.emit('login');
        await recordLocalAuthorization({ ...scope, userId: 'user-b', connectionId: 'conn-b' });
      }
      await act(async () => {
        stored.resolve(old);
        await pending;
      });
      expect(mockDisconnect).toHaveBeenCalledTimes(switchAccount ? 0 : 1);
    },
  );

  it.each([false, true])(
    'Sol119 cleanup enumeration held, new Connect=%p: retirement cannot delete a newer consent',
    async (reconnect) => {
      const prior = await recordLocalAuthorization(scope, new Date('2026-10-01T00:00:00.000Z'));
      const keys = await AsyncStorage.getAllKeys();
      const enumeration = deferred<string[]>();
      jest.spyOn(AsyncStorage, 'getAllKeys').mockClear().mockImplementationOnce(() => enumeration.promise);
      const retiring = retireOnDeviceSource(scope.userId, scope.source, prior.grantedAt);
      await waitFor(() => expect(AsyncStorage.getAllKeys).toHaveBeenCalled());
      if (reconnect) {
        await recordLocalAuthorization(
          { ...scope, connectionId: 'conn-new' },
          new Date('2026-10-02T00:00:00.000Z'),
        );
      }
      enumeration.resolve(keys);
      await retiring;
      expect((await getLocalAuthorization(scope.userId, scope.source))?.connectionId ?? null).toBe(
        reconnect ? 'conn-new' : null,
      );
    },
  );

  it.each([false, true])(
    'Sol119 no-session cleanup held, switch=%p: late cleanup must not retire the next account',
    async (switchAccount) => {
      await recordLocalAuthorization({ ...scope, userId: 'user-b', connectionId: 'old-b' });
      mockSignedIn = null;
      const keys = await AsyncStorage.getAllKeys();
      const enumeration = deferred<string[]>();
      jest.spyOn(AsyncStorage, 'getAllKeys').mockClear().mockImplementationOnce(() => enumeration.promise);
      const { result } = await disconnectHook();
      await act(async () => {
        await result.current.mutateAsync('HEALTH_CONNECT');
      });
      await waitFor(() => expect(AsyncStorage.getAllKeys).toHaveBeenCalled());
      if (switchAccount) {
        mockSignedIn = 'user-b';
        authEvents.emit('login');
        await recordLocalAuthorization({ ...scope, userId: 'user-b', connectionId: 'new-b' });
      }
      await act(async () => {
        enumeration.resolve(keys);
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect((await getLocalAuthorization('user-b', scope.source))?.connectionId ?? null).toBe(
        switchAccount ? 'new-b' : null,
      );
    },
  );

  it('an account switch during identity capture rejects with the session-change class and sends nothing', async () => {
    await recordLocalAuthorization(scope);
    const identity = deferred<{ id: string }>();
    jest.mocked(readUserCache).mockImplementationOnce(() => identity.promise as never);
    const { result } = await disconnectHook();
    let outcome: unknown = 'pending';
    let pending: Promise<unknown> = Promise.resolve();
    await act(async () => {
      pending = result.current.mutateAsync('SAMSUNG_HEALTH').then(
        () => (outcome = 'resolved'),
        (err: unknown) => (outcome = err),
      );
    });
    await waitFor(() => expect(readUserCache).toHaveBeenCalled());
    mockSignedIn = 'user-b';
    authEvents.emit('login');
    await act(async () => {
      identity.resolve({ id: 'user-a' });
      await pending;
    });
    expect(isOnDeviceStop(outcome)).toBe(true);
    expect(mockDisconnect).not.toHaveBeenCalled();
    expect((await getLocalAuthorization('user-a', scope.source))?.connectionId).toBe('conn-a');
  });

  it('a newer Connect during enumeration keeps its grant and its import progress', async () => {
    const prior = await recordLocalAuthorization(scope, new Date('2026-10-01T00:00:00.000Z'));
    await setSyncProgress(scope, { ...emptyProgress(), completedThrough: { Steps: '2026-10-01T00:00:00.000Z' } });
    const enumeration = deferred<string[]>();
    jest.spyOn(AsyncStorage, 'getAllKeys').mockClear().mockImplementationOnce(() => enumeration.promise);
    const retiring = retireOnDeviceSource(scope.userId, scope.source, prior.grantedAt);
    await waitFor(() => expect(AsyncStorage.getAllKeys).toHaveBeenCalled());
    const fresh = { ...scope, connectionId: 'conn-new' };
    await recordLocalAuthorization(fresh, new Date('2026-10-02T00:00:00.000Z'));
    await setSyncProgress(fresh, { ...emptyProgress(), completedThrough: { Steps: '2026-10-02T00:00:00.000Z' } });
    enumeration.resolve(await AsyncStorage.getAllKeys());
    await retiring;
    expect((await getLocalAuthorization(scope.userId, scope.source))?.connectionId).toBe('conn-new');
    expect((await getSyncProgress(fresh)).completedThrough.Steps).toBe('2026-10-02T00:00:00.000Z');
  });

  it('no-session Disconnect retires every older grant but keeps one written after it started', async () => {
    await recordLocalAuthorization({ ...scope, userId: 'user-b', connectionId: 'old-b' });
    await recordLocalAuthorization({ ...scope, userId: 'user-c', connectionId: 'old-c' });
    mockSignedIn = null;
    const enumeration = deferred<string[]>();
    jest.spyOn(AsyncStorage, 'getAllKeys').mockClear().mockImplementationOnce(() => enumeration.promise);
    const { result } = await disconnectHook();
    await act(async () => {
      await result.current.mutateAsync('HEALTH_CONNECT');
    });
    await waitFor(() => expect(AsyncStorage.getAllKeys).toHaveBeenCalled());
    await recordLocalAuthorization({ ...scope, userId: 'user-b', connectionId: 'new-b' });
    const keys = await AsyncStorage.getAllKeys();
    await act(async () => {
      enumeration.resolve(keys);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await getLocalAuthorization('user-b', scope.source))?.connectionId).toBe('new-b');
    expect(await getLocalAuthorization('user-c', scope.source)).toBeNull();
  });
});
