/**
 * AUD-OPUS-H45-118 probe (never merge): the REAL ConnectionsScreen hosting the
 * REAL ConnectProviderSheet, wired exactly as in production
 * (`onClose={closeSheet} onConnected={closeSheet}`).
 *
 * Claim under test (S-WEAR-3, ConnectProviderSheet handleImportOutcome): a first
 * Connect that finished with nothing to bring in "says so and where to check,
 * instead of closing as if data had arrived". On iPhone this is also what
 * turning every category off looks like (HealthKit never reports a denial).
 *
 * Expected at a correct head: after Continue, the empty-import copy is visible
 * and the sheet is still open. Control: a complete import with data closes.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

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

const mockInvalidate = jest.fn();
jest.mock('../../../../hooks/useWearableConnections', () => ({
  useWearableConnections: () => ({
    data: [],
    isLoading: false,
    isError: false,
    isRefetching: false,
    refetch: jest.fn(),
  }),
  useLocalOnDeviceAuthorization: () => ({ data: undefined }),
  useDisconnectProvider: () => ({ mutate: jest.fn(), isPending: false, variables: undefined }),
  useStartOauth: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useInvalidateWearableConnections: () => mockInvalidate,
}));

jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }));

const mockConnectOnDeviceProvider = jest.fn();
jest.mock('../../../../services/health/onDeviceConnect', () => ({
  connectOnDeviceProvider: (...args: unknown[]) => mockConnectOnDeviceProvider(...args),
  openHealthConnectPermissions: jest.fn(async () => true),
  openHealthConnectStore: jest.fn(async () => true),
}));

jest.mock('../../../../services/authActions', () => ({ signOut: jest.fn(async () => undefined) }));
jest.mock('../../../../lib/consultation/report', () => ({ reportUnexpected: jest.fn() }));

const mockFence = {
  userId: 'user-a',
  assertCurrent: jest.fn(async () => undefined),
  throwIfStopped: jest.fn(),
  cancel: jest.fn(),
};
const mockConnectOnDevice = jest.fn();
jest.mock('../../../../services/health/onDeviceSync', () => {
  const actual = jest.requireActual('../../../../services/health/onDeviceSync');
  return {
    ...actual,
    deviceSourceForPlatform: () => 'APPLE_HEALTHKIT',
    deviceSourceFor: () => 'APPLE_HEALTHKIT',
    beginOnDeviceConnect: async () => mockFence,
    connectOnDevice: (...args: unknown[]) => mockConnectOnDevice(...args),
    resumeOnDeviceImport: jest.fn(),
  };
});

import ConnectionsScreen from '../ConnectionsScreen';

beforeEach(() => {
  mockInvalidate.mockReset();
  mockConnectOnDeviceProvider.mockReset();
  mockConnectOnDevice.mockReset();
  mockConnectOnDeviceProvider.mockResolvedValue('granted');
});

async function connectAppleHealth() {
  await render(<ConnectionsScreen />);
  await fireEvent.press(screen.getByLabelText('Connect Apple Health'));
  await waitFor(() => expect(screen.getByLabelText('Continue connecting Apple Health')).toBeTruthy());
  await fireEvent.press(screen.getByLabelText('Continue connecting Apple Health'));
  await waitFor(() => expect(mockConnectOnDevice).toHaveBeenCalledTimes(1));
}

describe('probe: empty first import in the production host', () => {
  it('control: a complete import with data closes the sheet', async () => {
    mockConnectOnDevice.mockResolvedValue({
      kind: 'imported',
      source: 'APPLE_HEALTHKIT',
      connectionId: 'conn-a',
      postedCount: 3,
      complete: true,
    });
    await connectAppleHealth();
    await waitFor(() => expect(screen.queryByLabelText('Continue connecting Apple Health')).toBeNull());
  });

  it('an empty first import keeps the sheet open and shows where to check', async () => {
    mockConnectOnDevice.mockResolvedValue({
      kind: 'imported',
      source: 'APPLE_HEALTHKIT',
      connectionId: 'conn-a',
      postedCount: 0,
      complete: true,
    });
    await connectAppleHealth();
    await waitFor(() =>
      expect(screen.getByText(/no data from the last 30 days to bring in/)).toBeTruthy(),
    );
    expect(screen.getByText(/open the Health app, tap your profile picture/)).toBeTruthy();
  });
});
