/**
 * AUD-OPUS-H46-119 probe (never merge): Disconnect invariants at #364 529ba345 / #362 b3bc0ce4.
 * Real hook, local state and session fence; only network and native edges are doubles.
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
jest.mock('react-native-health-connect', () => ({ readRecords: jest.fn() }));

import { useDisconnectProvider, WEARABLE_CONNECTIONS_QUERY_KEY } from './useWearableConnections';
import { beginSessionFence } from '../services/health/sessionFence';
import { getLocalAuthorization, recordLocalAuthorization } from '../services/health/onDeviceState';

const hcA = { userId: 'user-a', connectionId: 'conn-a', source: 'HEALTH_CONNECT' as const };
const hcB = { userId: 'user-b', connectionId: 'conn-b', source: 'HEALTH_CONNECT' as const };
const akA = { userId: 'user-a', connectionId: 'conn-ak', source: 'APPLE_HEALTHKIT' as const };
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

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  mockSignedIn = 'user-a';
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
  mockDisconnect.mockReset().mockImplementation(async (provider: string) => ({ provider }));
});
afterEach(() => {
  jest.restoreAllMocks();
  clients.splice(0).forEach((qc) => qc.clear());
  Object.defineProperty(Platform, 'OS', { configurable: true, value: oldOS });
});

describe('AUD-OPUS-H46-119 Disconnect probes', () => {
  it('CONTROL+INVARIANT Samsung row on Android: server HEALTH_CONNECT, own grant retired, other account kept, list refetched', async () => {
    await recordLocalAuthorization(hcA);
    await recordLocalAuthorization(hcB);
    const fence = await beginSessionFence();
    const { result, invalidate } = await disconnectHook();
    await act(async () => {
      await result.current.mutateAsync('SAMSUNG_HEALTH');
    });
    expect(mockDisconnect).toHaveBeenCalledWith('HEALTH_CONNECT');
    expect(() => fence?.throwIfStopped()).toThrow();
    await waitFor(async () => expect(await getLocalAuthorization('user-a', 'HEALTH_CONNECT')).toBeNull());
    expect((await getLocalAuthorization('user-b', 'HEALTH_CONNECT'))?.connectionId).toBe('conn-b');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: WEARABLE_CONNECTIONS_QUERY_KEY });
  });

  it('INVARIANT iPhone: disconnecting the Samsung/Health Connect row does not stop Apple Health reads or touch its grant', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    await recordLocalAuthorization(akA);
    const fence = await beginSessionFence();
    if (fence == null) throw new Error('setup: no fence');
    const { result } = await disconnectHook();
    await act(async () => {
      await result.current.mutateAsync('SAMSUNG_HEALTH');
    });
    expect(mockDisconnect).toHaveBeenCalledWith('HEALTH_CONNECT');
    expect(() => fence.throwIfStopped()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect((await getLocalAuthorization('user-a', 'APPLE_HEALTHKIT'))?.connectionId).toBe('conn-ak');
  });

  it('INVARIANT a failed server Disconnect stops nothing and keeps the grant (still connected)', async () => {
    await recordLocalAuthorization(hcA);
    const fence = await beginSessionFence();
    if (fence == null) throw new Error('setup: no fence');
    mockDisconnect.mockRejectedValueOnce(new Error('network'));
    const { result } = await disconnectHook();
    await act(async () => {
      await result.current.mutateAsync('HEALTH_CONNECT').catch(() => undefined);
    });
    expect(() => fence.throwIfStopped()).not.toThrow();
    expect((await getLocalAuthorization('user-a', 'HEALTH_CONNECT'))?.connectionId).toBe('conn-a');
  });

  it('INVARIANT a cloud provider Disconnect never stops on-device reads', async () => {
    await recordLocalAuthorization(hcA);
    const fence = await beginSessionFence();
    if (fence == null) throw new Error('setup: no fence');
    const { result } = await disconnectHook();
    await act(async () => {
      await result.current.mutateAsync('OURA');
    });
    expect(mockDisconnect).toHaveBeenCalledWith('OURA');
    expect(() => fence.throwIfStopped()).not.toThrow();
    expect((await getLocalAuthorization('user-a', 'HEALTH_CONNECT'))?.connectionId).toBe('conn-a');
  });
});
