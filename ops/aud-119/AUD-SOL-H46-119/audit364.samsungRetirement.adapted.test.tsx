/**
 * AUD-SOL-H6-118: synthetic compatibility probes on the exact H1-H6 tree.
 * Actual row builder, local authorization, refresh orchestrator and mutation;
 * only API transport, native sync and the unrelated sheet are replaced.
 */
import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

jest.mock('../ConnectProviderSheet', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('../../../../api/wearablesConnectionsApi', () => {
  const actual = jest.requireActual('../../../../api/wearablesConnectionsApi');
  return {
    ...actual,
    wearablesConnectionsApi: {
      ...actual.wearablesConnectionsApi,
      disconnect: jest.fn(),
    },
  };
});

import { buildRows } from '../ConnectionsScreen';
import { disconnectConfirmCopy } from '../disconnectCopy';
import {
  wearablesConnectionsApi,
  type WearableConnection,
} from '../../../../api/wearablesConnectionsApi';
import { useDisconnectProvider } from '../../../../hooks/useWearableConnections';
import {
  beginOnDeviceConnect,
  connectOnDevice,
  deviceSourceFor,
  refreshOnDevice,
} from '../../../../services/health/onDeviceSync';
import { getLocalAuthorization } from '../../../../services/health/onDeviceState';

const userId = 'audit-user';
const readUserId = async () => userId;
function connection(provider: WearableConnection['provider']): WearableConnection {
  return {
    id: `audit-connection-${provider}`, user_id: userId, provider,
    external_account_id: 'on-device', access_token_expires_at: null,
    scopes: [], webhook_subscription_id: null, channel_expires_at: null,
    status: 'connected', last_error: null, last_synced_at: null,
    backfilled_until: null, disconnected_at: null,
    created_at: '2026-09-30T00:00:00.000Z', updated_at: '2026-09-30T00:00:00.000Z',
  };
}
const legacy = connection('SAMSUNG_HEALTH');
const hc = connection('HEALTH_CONNECT');
beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  Object.defineProperty(Platform, 'OS', { get: () => 'android', configurable: true });
});

it('does not advertise a retired Samsung connection as active when no supported refresh can use it', async () => {
  const row = buildRows([legacy], { provider: 'HEALTH_CONNECT', connectionId: null })
    .find((r) => r.provider === 'SAMSUNG_HEALTH');
  const sync = jest.fn().mockResolvedValue({ normalizedCount: 1, complete: true });
  const out = await refreshOnDevice('HEALTH_CONNECT', [legacy], { readUserId, syncHealthConnect: sync });
  expect(out.kind).toBe('not_authorized');
  expect(sync).not.toHaveBeenCalled();
  expect(row?.status).not.toBe('connected');
});

it('control: legacy Samsung alone never reads the phone without fresh local authorization', async () => {
  const sync = jest.fn().mockResolvedValue({ normalizedCount: 1, complete: true });
  const out = await refreshOnDevice('HEALTH_CONNECT', [legacy], { readUserId, syncHealthConnect: sync });
  expect(out.kind).toBe('not_authorized');
  expect(sync).not.toHaveBeenCalled();
});

it('a successful Samsung Connect does not return to a false Not connected Samsung row', async () => {
  const source = deviceSourceFor('SAMSUNG_HEALTH');
  expect(source).toBe('HEALTH_CONNECT');
  const fence = await beginOnDeviceConnect({ readUserId });
  const register = jest.fn().mockResolvedValue(hc);
  const out = await connectOnDevice('HEALTH_CONNECT', fence, {
    register, readUserId,
    syncHealthConnect: jest.fn().mockResolvedValue({ normalizedCount: 1, complete: true }),
  });
  expect(out.kind).toBe('imported');
  expect(register).toHaveBeenCalledWith('HEALTH_CONNECT');
  const rows = buildRows([hc], { provider: 'HEALTH_CONNECT', connectionId: hc.id });
  expect(rows.find((r) => r.provider === 'HEALTH_CONNECT')?.status).toBe('connected');
  expect(rows.find((r) => r.provider === 'SAMSUNG_HEALTH')?.status).not.toBe('disconnected');
});

it.each(['SAMSUNG_HEALTH', 'HEALTH_CONNECT'] as const)(
  'a visible successful Disconnect %s stops the Health Connect source used by that Connect path',
  async (provider) => {
    const fence = await beginOnDeviceConnect({ readUserId });
    await connectOnDevice('HEALTH_CONNECT', fence, {
      register: jest.fn().mockResolvedValue(hc), readUserId,
      syncHealthConnect: jest.fn().mockResolvedValue({ normalizedCount: 1, complete: true }),
    });
    expect((await getLocalAuthorization(userId, 'HEALTH_CONNECT'))?.connectionId).toBe(hc.id);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const Wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const disconnect = wearablesConnectionsApi.disconnect as jest.Mock;
    disconnect.mockResolvedValue({ success: true, provider });
    const { result, unmount } = await renderHook(() => useDisconnectProvider(), { wrapper: Wrapper });
    await result.current.mutateAsync(provider);
    // AUD-SOL-H46-119 applicability: Samsung is explicitly a Health Connect
    // mirror now; only this wire-identity expectation changes.
    expect(disconnect).toHaveBeenCalledWith('HEALTH_CONNECT');
    expect(disconnectConfirmCopy(provider, provider === 'SAMSUNG_HEALTH' ? 'Samsung Health' : 'Health Connect').body)
      .toContain('stops');
    if (provider === 'HEALTH_CONNECT') {
      await waitFor(async () => expect(await getLocalAuthorization(userId, 'HEALTH_CONNECT')).toBeNull());
    }
    const sync = jest.fn().mockResolvedValue({ normalizedCount: 1, complete: true });
    const out = await refreshOnDevice('HEALTH_CONNECT', [hc, { ...legacy, status: 'disconnected' }], {
      readUserId, syncHealthConnect: sync,
    });
    unmount();
    qc.clear();
    expect(out.kind).toBe('not_authorized');
    expect(sync).not.toHaveBeenCalled();
  },
);
