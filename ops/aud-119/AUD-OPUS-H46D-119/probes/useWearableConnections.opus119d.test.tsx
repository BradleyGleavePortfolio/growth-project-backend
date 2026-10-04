/**
 * AUD-OPUS-H46D-119 probe (never merge): #362 FIX ROUND 3 (73dbefbc) Disconnect fences.
 * Real hook -> real provider API -> real Axios interceptors -> synthetic adapter; real local state.
 * 1) 401 refresh-and-retry: the retry never leaves when the session moved during the refresh.
 * 2) A newer grant written during the pre-request identity read (after `since` was captured)
 *    survives the Disconnect; control: the start grant is retired.
 */
import React from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { healthConnectEnabled: true } } },
}));
jest.mock('react-native-health-connect', () => ({ readRecords: jest.fn() }));
let mockUser = 'user-a';
let mockToken = 'synthetic-session-a';
jest.mock('../lib/userCache', () => ({
  readUserCache: jest.fn(async () => ({ id: mockUser })),
}));
jest.mock('../services/secureStorage', () => ({
  secureStorage: {
    getItem: jest.fn(async (key: string) => {
      if (key === 'supabase_token') return mockToken;
      if (key === 'supabase_refresh_token') return 'synthetic-refresh';
      return null;
    }),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));
jest.mock('../utils/logger', () => ({
  logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
}));

import api, { __resetRefreshStateForTests, __setRefreshSessionForTests } from '../services/api';
import { useDisconnectProvider } from './useWearableConnections';
import { readUserCache } from '../lib/userCache';
import { authEvents } from '../utils/authEvents';
import { getLocalAuthorization, recordLocalAuthorization } from '../services/health/onDeviceState';
import { isOnDeviceStop } from '../services/health/sessionFence';

const oldOS = Platform.OS;
const oldAdapter = api.defaults.adapter;
afterEach(() => {
  api.defaults.adapter = oldAdapter;
  __resetRefreshStateForTests();
  Object.defineProperty(Platform, 'OS', { configurable: true, value: oldOS });
});

async function hook() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const view = await renderHook(() => useDisconnectProvider(), { wrapper });
  return { qc, view };
}

it.each([false, true])(
  'Opus H46D 401 retry, session moved during refresh=%p: the retry leaves only for the same session',
  async (moved) => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    mockUser = 'user-a';
    mockToken = 'synthetic-session-a';
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    const dispatched: string[] = [];
    api.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      dispatched.push(String(config.headers.get('Authorization')));
      if (dispatched.length === 1) {
        throw new AxiosError('unauthorized', 'ERR_BAD_REQUEST', config, null, {
          status: 401, statusText: 'Unauthorized', headers: {}, config, data: {},
        });
      }
      return {
        status: 200, statusText: 'OK', config, headers: {},
        data: { success: true, provider: 'OURA' },
      };
    };
    __setRefreshSessionForTests(async () => {
      if (moved) {
        mockUser = 'user-b';
        mockToken = 'synthetic-session-b';
        authEvents.emit('login');
      } else {
        mockToken = 'synthetic-session-a2';
      }
      return { data: { session: { access_token: mockToken, refresh_token: 'r2' } }, error: null };
    });
    const { qc, view } = await hook();
    let outcome: unknown = 'pending';
    await act(async () => {
      await view.result.current.mutateAsync('OURA').then(
        () => (outcome = 'resolved'),
        (err: unknown) => (outcome = err),
      );
    });
    await view.unmount();
    qc.clear();
    if (moved) {
      expect(dispatched).toEqual(['Bearer synthetic-session-a']);
      expect(isOnDeviceStop(outcome)).toBe(true);
    } else {
      expect(dispatched).toEqual(['Bearer synthetic-session-a', 'Bearer synthetic-session-a2']);
      expect(outcome).toBe('resolved');
    }
  },
);

it.each([false, true])(
  'Opus H46D newer grant written during the identity read=%p: kept; otherwise the start grant is retired',
  async (newer) => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    mockUser = 'user-a';
    mockToken = 'synthetic-session-a';
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    await recordLocalAuthorization(
      { userId: 'user-a', source: 'HEALTH_CONNECT', connectionId: 'conn-old' },
      new Date('2026-10-01T00:00:00Z'),
    );
    const dispatched: string[] = [];
    api.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      dispatched.push(String(config.url));
      return {
        status: 200, statusText: 'OK', config, headers: {},
        data: { success: true, provider: 'HEALTH_CONNECT' },
      };
    };
    let release: (value: { id: string }) => void = () => undefined;
    jest.mocked(readUserCache).mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve as (value: { id: string }) => void; }),
    );
    const { qc, view } = await hook();
    let pending: Promise<unknown> = Promise.resolve();
    await act(async () => {
      pending = view.result.current.mutateAsync('HEALTH_CONNECT').catch((e: unknown) => e);
    });
    await waitFor(() => expect(readUserCache).toHaveBeenCalledTimes(1));
    if (newer) {
      await recordLocalAuthorization(
        { userId: 'user-a', source: 'HEALTH_CONNECT', connectionId: 'conn-new' },
        new Date('2026-10-04T00:00:00Z'),
      );
    }
    await act(async () => {
      release({ id: 'user-a' });
      await pending;
    });
    expect(dispatched).toEqual(['/v1/wearables/connections/HEALTH_CONNECT']);
    // Let the fire-and-forget retirement settle.
    await act(async () => {
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
    const now = await getLocalAuthorization('user-a', 'HEALTH_CONNECT');
    if (newer) expect(now?.connectionId).toBe('conn-new');
    else expect(now).toBeNull();
    await view.unmount();
    qc.clear();
  },
);
