/**
 * AUD-OPUS-H6-118 probe (lens only; never merged) — mobile #364 @ a3206441.
 *
 * Invariant: after a person connects through the Samsung Health row, the
 * Connections list must not tell them Samsung Health is "Not connected" and
 * offer "Connect" again while its data is being read (through Health
 * Connect) and shared with the coach.
 *
 * Facts used (controls below): the sheet's Samsung Health Connect tap maps
 * to the HEALTH_CONNECT device source (deviceSourceFor), so the server holds
 * only a HEALTH_CONNECT row afterwards; the empty-import copy for the
 * Samsung row says "Samsung Health is connected".
 */

import React from 'react';
import { Platform } from 'react-native';
import { render, screen } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => {
  const ReactLocal = require('react');
  const { View } = require('react-native');
  return {
    SafeAreaView: ({ children, style }: { children: React.ReactNode; style?: object }) =>
      ReactLocal.createElement(View, { style }, children),
    SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

jest.mock('../ConnectProviderSheet', () => {
  const ReactLocal = require('react');
  return {
    __esModule: true,
    default: () => ReactLocal.createElement(ReactLocal.Fragment, null),
  };
});

const mockUseWearableConnections = jest.fn();
const mockLocalAuth = jest.fn((_source: unknown) => ({ data: undefined as unknown }));
jest.mock('../../../../hooks/useWearableConnections', () => ({
  useWearableConnections: () => mockUseWearableConnections(),
  useLocalOnDeviceAuthorization: (source: unknown) => mockLocalAuth(source),
  useDisconnectProvider: () => ({ mutate: jest.fn(), isPending: false, variables: undefined }),
}));

jest.mock('../../../../lib/consultation/report', () => ({
  reportUnexpected: jest.fn(),
}));

import ConnectionsScreen from '../ConnectionsScreen';
import { emptyImportMessage } from '../onDeviceCopy';
import { deviceSourceFor } from '../../../../services/health/onDeviceSync';

function setPlatform(os: string): void {
  Object.defineProperty(Platform, 'OS', { get: () => os, configurable: true });
}

function connection(provider: string, status: string) {
  return {
    id: `c-${provider}`,
    user_id: 'u1',
    provider,
    external_account_id: null,
    access_token_expires_at: null,
    scopes: [],
    webhook_subscription_id: null,
    channel_expires_at: null,
    status,
    last_error: null,
    last_synced_at: '2026-10-04T16:00:00.000Z',
    backfilled_until: null,
    disconnected_at: null,
    created_at: '2026-10-04T16:00:00.000Z',
    updated_at: '2026-10-04T16:00:00.000Z',
  };
}

function afterSamsungConnect() {
  // What the server and this phone hold after a successful Samsung Health
  // Connect tap: one HEALTH_CONNECT row, bound to this phone's local grant.
  mockUseWearableConnections.mockReturnValue({
    data: [connection('HEALTH_CONNECT', 'connected')],
    isLoading: false,
    isError: false,
    isRefetching: false,
    refetch: jest.fn(),
  });
  mockLocalAuth.mockReturnValue({
    data: { userId: 'u1', source: 'HEALTH_CONNECT', connectionId: 'c-HEALTH_CONNECT' },
  });
}

beforeEach(() => {
  setPlatform('android');
  mockUseWearableConnections.mockReset();
  mockLocalAuth.mockReset();
});

describe('AUD-OPUS-H6-118: Samsung Health row after a Samsung Health connect', () => {
  it('control: a Samsung Health Connect tap registers the HEALTH_CONNECT source on Android', () => {
    expect(deviceSourceFor('SAMSUNG_HEALTH')).toBe('HEALTH_CONNECT');
  });

  it('control: the Samsung empty-import copy says Samsung Health is connected', () => {
    expect(emptyImportMessage('SAMSUNG_HEALTH', 'Samsung Health').text).toContain(
      'Samsung Health is connected',
    );
  });

  it('control: the Health Connect row shows Connected with Disconnect', async () => {
    afterSamsungConnect();
    await render(<ConnectionsScreen />);
    expect(screen.getByLabelText(/^Health Connect, Connected/)).toBeTruthy();
    expect(screen.getByLabelText('Disconnect Health Connect')).toBeTruthy();
  });

  it('INVARIANT: the Samsung Health row is not shown as Not connected', async () => {
    afterSamsungConnect();
    await render(<ConnectionsScreen />);
    expect(screen.queryByLabelText(/^Samsung Health, Not connected/)).toBeNull();
  });

  it('INVARIANT: the Samsung Health row does not offer Connect again while its data is read', async () => {
    afterSamsungConnect();
    await render(<ConnectionsScreen />);
    expect(screen.queryByLabelText('Connect Samsung Health')).toBeNull();
  });
});
