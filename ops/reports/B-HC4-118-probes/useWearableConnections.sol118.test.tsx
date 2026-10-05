/**
 * AUD-SOL-H45-118: actual hook, local retirement, paged client and session fence.
 * Network/native edges are synthetic; no real health data or account is used.
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
jest.mock('../utils/logger', () => ({
  logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
}));
let mockSignedIn = 'audit-a';
jest.mock('../lib/userCache', () => ({
  readUserCache: jest.fn(async () => ({ id: mockSignedIn })),
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
import { logger } from '../utils/logger';
import { authEvents } from '../utils/authEvents';
import { beginSessionFence } from '../services/health/sessionFence';
import {
  getLocalAuthorization,
  recordLocalAuthorization,
  type OnDeviceScope,
} from '../services/health/onDeviceState';
import { healthConnectClient } from '../services/health/healthConnect/healthConnectClient';
import { syncHealthConnect } from '../services/health/healthConnect/healthConnectSyncService';

const scope: OnDeviceScope = {
  userId: 'audit-a', connectionId: 'audit-connection-a', source: 'HEALTH_CONNECT',
};
const oldOS = Platform.OS;
const clients: QueryClient[] = [];
function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  clients.push(qc);
  return ({ children }: { children: React.ReactNode }) =>
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
function deferred<T>() {
  let resolve: (x: T) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { resolve, reject, promise };
}
beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  mockSignedIn = 'audit-a';
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
  mockDisconnect.mockReset();
  mockDisconnect.mockResolvedValue({ success: true, provider: 'HEALTH_CONNECT' });
  mockReadRecords.mockReset();
});
afterEach(() => {
  jest.restoreAllMocks();
  clients.splice(0).forEach((qc) => qc.clear());
  Object.defineProperty(Platform, 'OS', { configurable: true, value: oldOS });
});

describe('AUD-SOL-118 disconnect boundaries', () => {
  it.each([
    new Error('AUDIT_PRIVATE_WEIGHT_81_6_KG'),
    { message: 'AUDIT_PRIVATE_WEIGHT_81_6_KG', key: 'wearables_on_device:auth:HEALTH_CONNECT:audit-a' },
  ])('retirement rejection never crosses the logger boundary (%p)', async (rejection) => {
    jest.spyOn(AsyncStorage, 'getAllKeys').mockRejectedValueOnce(rejection);
    const { result } = await renderHook(() => useDisconnectProvider(), { wrapper: wrapper() });
    await act(async () => { await result.current.mutateAsync('HEALTH_CONNECT'); });
    await waitFor(() => expect(logger.warn).toHaveBeenCalled());
    const payload = jest.mocked(logger.warn).mock.calls.map((args) =>
      args.map((x) => x instanceof Error ? `${x.name}:${x.message}` : JSON.stringify(x)).join(' '),
    ).join('\n');
    expect(payload).not.toContain('AUDIT_PRIVATE_WEIGHT_81_6_KG');
  });

  it('old A disconnect completion does not retire B new authorization', async () => {
    const response = deferred<{ success: boolean; provider: 'HEALTH_CONNECT' }>();
    mockDisconnect.mockReturnValueOnce(response.promise);
    await recordLocalAuthorization(scope);
    const { result } = await renderHook(() => useDisconnectProvider(), { wrapper: wrapper() });
    let pending: Promise<unknown> = Promise.resolve();
    await act(async () => { pending = result.current.mutateAsync('HEALTH_CONNECT'); });
    await waitFor(() => expect(mockDisconnect).toHaveBeenCalledTimes(1));
    mockSignedIn = 'audit-b';
    authEvents.emit('login');
    const scopeB = { ...scope, userId: 'audit-b', connectionId: 'audit-connection-b' };
    await recordLocalAuthorization(scopeB);
    const remove = jest.spyOn(AsyncStorage, 'removeMany');
    await act(async () => {
      response.resolve({ success: true, provider: 'HEALTH_CONNECT' });
      await pending;
    });
    await waitFor(() => expect(remove).toHaveBeenCalled());
    expect((await getLocalAuthorization('audit-b', 'HEALTH_CONNECT'))?.connectionId)
      .toBe('audit-connection-b');
  });

  it.each([false, true])(
    'a held real native page starts another page only if not disconnected (disconnect=%p)',
    async (disconnect) => {
      await recordLocalAuthorization(scope);
      const fence = await beginSessionFence();
      if (fence == null) throw new Error('probe setup missing fence');
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
      }).then(() => undefined, () => undefined);
      await waitFor(() => expect(mockReadRecords).toHaveBeenCalledTimes(1));
      if (disconnect) {
        const { result } = await renderHook(() => useDisconnectProvider(), { wrapper: wrapper() });
        await act(async () => { await result.current.mutateAsync('HEALTH_CONNECT'); });
        await waitFor(async () => expect(await getLocalAuthorization('audit-a', 'HEALTH_CONNECT')).toBeNull());
      }
      first.resolve({ records: [], pageToken: 'audit-next-page' });
      await syncing;
      expect(mockReadRecords).toHaveBeenCalledTimes(disconnect ? 1 : 2);
    },
  );
});
