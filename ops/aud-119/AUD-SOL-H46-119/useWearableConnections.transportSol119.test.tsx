/** Real hook -> real provider API -> real Axios interceptor -> synthetic adapter. No network. */
import React from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let mockUser = 'user-a';
let mockToken = 'synthetic-session-a';
jest.mock('../lib/userCache', () => ({
  readUserCache: jest.fn(async () => ({ id: mockUser })),
}));
jest.mock('../services/secureStorage', () => ({
  secureStorage: {
    getItem: jest.fn(async (key: string) => key === 'supabase_token' ? mockToken : null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));
jest.mock('../utils/logger', () => ({
  logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
}));

import api from '../services/api';
import { useDisconnectProvider } from './useWearableConnections';
import { readUserCache } from '../lib/userCache';
import { authEvents } from '../utils/authEvents';
import { recordLocalAuthorization } from '../services/health/onDeviceState';

const oldOS = Platform.OS;
const oldAdapter = api.defaults.adapter;
afterEach(() => {
  api.defaults.adapter = oldAdapter;
  Object.defineProperty(Platform, 'OS', { configurable: true, value: oldOS });
});

it.each([false, true])(
  'Sol119 real transport switch=%p: A Disconnect cannot leave with B Authorization',
  async (switchAccount) => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    mockUser = 'user-a';
    mockToken = 'synthetic-session-a';
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    await recordLocalAuthorization({
      userId: 'user-a', source: 'HEALTH_CONNECT', connectionId: 'conn-a',
    });
    const dispatched: { authorization: string; url?: string }[] = [];
    api.defaults.adapter = async (config) => {
      dispatched.push({ authorization: String(config.headers.get('Authorization')), url: config.url });
      return {
        status: 200, statusText: 'OK', config, headers: {},
        data: { success: true, provider: 'HEALTH_CONNECT' },
      };
    };
    let release: (value: { id: string }) => void = () => undefined;
    jest.mocked(readUserCache).mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const view = await renderHook(() => useDisconnectProvider(), { wrapper });
    let pending: Promise<unknown> = Promise.resolve();
    await act(async () => {
      pending = view.result.current.mutateAsync('HEALTH_CONNECT').catch(() => undefined);
    });
    await waitFor(() => expect(readUserCache).toHaveBeenCalledTimes(1));
    expect(dispatched).toEqual([]);
    if (switchAccount) {
      mockUser = 'user-b';
      mockToken = 'synthetic-session-b';
      authEvents.emit('login');
    }
    await act(async () => {
      release({ id: 'user-a' });
      await pending;
    });
    await view.unmount();
    qc.clear();
    expect(dispatched).toEqual(switchAccount ? [] : [{
      authorization: 'Bearer synthetic-session-a',
      url: '/v1/wearables/connections/HEALTH_CONNECT',
    }]);
  },
);
