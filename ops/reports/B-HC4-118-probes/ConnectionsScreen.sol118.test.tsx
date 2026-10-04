/**
 * AUD-SOL-H45-118: mount the real ConnectionsScreen with the real connect sheet.
 * Only provider/service/query edges are doubles. No native or HTTP calls occur.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => {
  const R = require('react');
  const { View } = require('react-native');
  return {
    SafeAreaView: ({ children }: { children: React.ReactNode }) => R.createElement(View, null, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});
const mockImport = jest.fn();
const mockInvalidate = jest.fn();
jest.mock('../../../../hooks/useWearableConnections', () => ({
  useWearableConnections: () => ({ data: [], isLoading: false, isError: false, refetch: jest.fn(), isRefetching: false }),
  useLocalOnDeviceAuthorization: () => ({ data: null }),
  useDisconnectProvider: () => ({ mutate: jest.fn(), isPending: false }),
  useStartOauth: () => ({ mutateAsync: jest.fn() }),
  useInvalidateWearableConnections: () => mockInvalidate,
}));
jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }));
jest.mock('../../../../services/authActions', () => ({ signOut: jest.fn() }));
jest.mock('../../../../services/health/onDeviceConnect', () => ({
  connectOnDeviceProvider: async () => 'granted',
  openHealthConnectPermissions: jest.fn(),
  openHealthConnectStore: jest.fn(),
}));
jest.mock('../../../../services/health/onDeviceSync', () => {
  const actual = jest.requireActual('../../../../services/health/onDeviceSync');
  return {
    ...actual,
    beginOnDeviceConnect: async () => ({
      userId: 'audit-a', assertCurrent: async () => undefined,
      throwIfStopped: () => undefined, cancel: () => undefined,
    }),
    deviceSourceFor: () => 'APPLE_HEALTHKIT',
    connectOnDevice: (...args: unknown[]) => mockImport(...args),
  };
});
import ConnectionsScreen from '../ConnectionsScreen';

beforeEach(() => {
  mockImport.mockReset();
  mockInvalidate.mockClear();
});
describe('AUD-SOL-118 actual parent/sheet empty history outcome', () => {
  it.each([0, 5])('first import with %p posted samples has the correct visible result', async (postedCount) => {
    mockImport.mockResolvedValue({
      kind: 'imported', source: 'APPLE_HEALTHKIT', connectionId: 'audit-connection',
      complete: true, postedCount,
    });
    await render(<ConnectionsScreen />);
    await fireEvent.press(screen.getByLabelText('Connect Apple Health'));
    await fireEvent.press(screen.getByLabelText('Continue connecting Apple Health'));
    await waitFor(() => expect(mockImport).toHaveBeenCalledTimes(1));
    if (postedCount === 0) {
      expect(screen.getByText(/no data from the last 30 days to bring in/)).toBeTruthy();
      expect(screen.getByLabelText('Close')).toBeTruthy();
    } else {
      await waitFor(() => expect(screen.queryByText('Connect Apple Health')).toBeNull());
      expect(mockInvalidate).toHaveBeenCalledTimes(1);
    }
  });
});
