/**
 * B-HC4-118 (Sol B-362-1/2/3, Opus C-362-1/3, B-364-1): Disconnect with the real hook, local
 * state, session fence and paged Health Connect sync. Adapted from the AUD-SOL-H45-118 probe
 * (run 37219439582). Only the network and native edges are doubles.
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
import type { WearableProvider } from '../api/wearablesConnectionsApi';
import { logger } from '../utils/logger';
import { authEvents } from '../utils/authEvents';
import { beginSessionFence } from '../services/health/sessionFence';
import {
  getLocalAuthorization,
  recordLocalAuthorization,
  retireOnDeviceSource,
} from '../services/health/onDeviceState';
import { readUserCache } from '../lib/userCache';
import { healthConnectClient } from '../services/health/healthConnect/healthConnectClient';
import { syncHealthConnect } from '../services/health/healthConnect/healthConnectSyncService';

const PRIVATE = 'PRIVATE_WEIGHT_81_6_KG';
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
/** Starts a Disconnect whose server response is held; returns its release. */
async function heldDisconnect() {
  const response = deferred<{ success: boolean }>();
  mockDisconnect.mockReturnValueOnce(response.promise);
  const hook = await disconnectHook();
  let pending: Promise<unknown> = Promise.resolve();
  await act(async () => {
    pending = hook.result.current.mutateAsync('HEALTH_CONNECT');
  });
  await waitFor(() => expect(mockDisconnect).toHaveBeenCalledTimes(1));
  const release = async () =>
    act(async () => {
      response.resolve({ success: true });
      await pending;
    });
  return { ...hook, release };
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

describe('useDisconnectProvider: on-device cleanup', () => {
  it.each([false, true])(
    'Sol119 identity capture held, switch=%p: an obsolete action never sends a new-session Disconnect',
    async (switchAccount) => {
      await recordLocalAuthorization(scope);
      const identity = deferred<{ id: string }>();
      jest.mocked(readUserCache).mockImplementationOnce(() => identity.promise);
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
      const enumeration = deferred<readonly string[]>();
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
      const enumeration = deferred<readonly string[]>();
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

  it.each([new Error(PRIVATE), { message: PRIVATE, key: 'wearables_on_device:auth:x' }])(
    'a failed cleanup logs a fixed class only (%p)',
    async (rejection) => {
      jest.spyOn(AsyncStorage, 'getAllKeys').mockRejectedValueOnce(rejection);
      const { result } = await disconnectHook();
      await act(async () => {
        await result.current.mutateAsync('HEALTH_CONNECT');
      });
      await waitFor(() => expect(logger.warn).toHaveBeenCalled());
      const payload = JSON.stringify(jest.mocked(logger.warn).mock.calls);
      expect(payload).not.toContain(PRIVATE);
      expect(payload).not.toContain('wearables_on_device');
      expect(logger.warn).toHaveBeenCalledWith('[wearables] retire on-device state failed', {
        error: rejection instanceof Error ? 'error' : 'other',
      });
    },
  );

  it("a response that lands after an account switch retires A's records only", async () => {
    await recordLocalAuthorization(scope);
    const { invalidate, release } = await heldDisconnect();
    mockSignedIn = 'user-b';
    authEvents.emit('login');
    await recordLocalAuthorization({ ...scope, userId: 'user-b', connectionId: 'conn-b' });
    await release();
    await waitFor(async () => expect(await getLocalAuthorization('user-a', scope.source)).toBeNull());
    expect((await getLocalAuthorization('user-b', scope.source))?.connectionId).toBe('conn-b');
    expect(invalidate).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('with no readable session, a current Disconnect still retires the source (Sol H6 probe)', async () => {
    await recordLocalAuthorization(scope);
    mockSignedIn = null;
    const { result } = await disconnectHook();
    await act(async () => {
      await result.current.mutateAsync('SAMSUNG_HEALTH');
    });
    expect(mockDisconnect).toHaveBeenCalledWith('HEALTH_CONNECT');
    await waitFor(async () => expect(await getLocalAuthorization('user-a', scope.source)).toBeNull());
  });

  it('a newer Connect by the same person during the Disconnect is kept', async () => {
    await recordLocalAuthorization(scope, new Date('2026-10-01T00:00:00.000Z'));
    const { release } = await heldDisconnect();
    const newer = { ...scope, connectionId: 'conn-a2' };
    await recordLocalAuthorization(newer, new Date('2026-10-02T00:00:00.000Z'));
    await release();
    await new Promise((r) => setTimeout(r, 0));
    expect((await getLocalAuthorization('user-a', scope.source))?.connectionId).toBe('conn-a2');
  });

  it.each<[WearableProvider | null, string | null, number]>([
    ['HEALTH_CONNECT', 'HEALTH_CONNECT', 1],
    ['SAMSUNG_HEALTH', 'HEALTH_CONNECT', 1],
    ['APPLE_HEALTHKIT', 'APPLE_HEALTHKIT', 2],
    ['OURA', 'OURA', 2],
    [null, null, 2],
  ])('a held native page: Disconnect %p (server %p) leaves %p read(s)', async (provider, server, reads) => {
    await recordLocalAuthorization(scope);
    const fence = await beginSessionFence();
    if (fence == null) throw new Error('setup: no fence');
    const first = deferred<{ records: unknown[]; pageToken: string }>();
    mockReadRecords.mockReturnValueOnce(first.promise).mockResolvedValue({ records: [] });
    const syncing = syncHealthConnect(scope, {
      fence,
      client: {
        ...healthConnectClient,
        initialize: async () => true,
        getGrantedPermissions: async () => [{ accessType: 'read', recordType: 'Steps' }],
      },
      ingestApi: { ingest: jest.fn().mockResolvedValue({ inserted: 0, skipped: 0 }) },
    }).catch(() => undefined);
    await waitFor(() => expect(mockReadRecords).toHaveBeenCalledTimes(1));
    if (provider != null) {
      const { result } = await disconnectHook();
      await act(async () => {
        await result.current.mutateAsync(provider);
      });
      expect(mockDisconnect).toHaveBeenCalledWith(server);
    }
    first.resolve({ records: [], pageToken: 'next-page' });
    await syncing;
    expect(mockReadRecords).toHaveBeenCalledTimes(reads);
    expect((await getLocalAuthorization('user-a', scope.source)) == null).toBe(reads === 1);
  });
});
