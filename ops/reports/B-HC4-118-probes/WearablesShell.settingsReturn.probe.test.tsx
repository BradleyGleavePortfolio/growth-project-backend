/**
 * AUD-OPUS-H45-118 probe (never merge): the Health screen notice for a Health
 * Connect refresh that finds every read permission off.
 *
 * Copy under test (onDeviceCopy connectFailureMessage, HealthConnectPermissionDeniedError):
 * "... Tap Open Health Connect, choose App permissions, then The Growth Project, and allow
 * access. Then tap Try again." The shell renders one button, "Open Health Connect". The probe
 * asserts the step the copy names exists on this surface once Health Connect was opened.
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

// The bucket screens render their `aiPanelSlot` so the test can assert the
// HK-5b AI panel is mounted into each bucket (the shell pipes a
// <ClientWearableInsightPanel/> into that slot).
jest.mock('../HealthFitnessScreen', () => {
  const ReactLocal = require('react');
  const { Text, View } = require('react-native');
  return {
    __esModule: true,
    default: ({ aiPanelSlot }: { aiPanelSlot?: React.ReactNode }) =>
      ReactLocal.createElement(
        View,
        null,
        ReactLocal.createElement(Text, null, 'FITNESS_OVERVIEW'),
        aiPanelSlot,
      ),
  };
});

jest.mock('../SleepRecoveryScreen', () => {
  const ReactLocal = require('react');
  const { Text, View } = require('react-native');
  return {
    __esModule: true,
    default: ({ aiPanelSlot }: { aiPanelSlot?: React.ReactNode }) =>
      ReactLocal.createElement(
        View,
        null,
        ReactLocal.createElement(Text, null, 'RECOVERY_OVERVIEW'),
        aiPanelSlot,
      ),
  };
});

// Stub the AI panel to a bucket-tagged marker so we can assert which bucket it
// was mounted for without exercising the real React Query hook here.
jest.mock('../ClientWearableInsightPanel', () => {
  const ReactLocal = require('react');
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ bucket }: { bucket: string }) =>
      ReactLocal.createElement(Text, null, `AI_PANEL_${bucket}`),
  };
});

const mockUseWearableConnections = jest.fn();
const mockInvalidateWearables = jest.fn();
jest.mock('../../../../hooks/useWearableConnections', () => ({
  useWearableConnections: () => mockUseWearableConnections(),
  useInvalidateWearableConnections: () => mockInvalidateWearables,
}));

// S14: the AI panel is behind a default-off flag (D2 consent); the getter
// lets each test choose the value without re-importing the shell.
let mockAiInsightsFlag = true;
jest.mock('../../../../config/featureFlags', () => ({
  featureFlags: {
    get wearableAiInsights() {
      return mockAiInsightsFlag;
    },
  },
}));

// S14: refresh-on-open runs the on-device import seam.
const mockImportHistory = jest.fn();
let mockDeviceSource: string | null = 'APPLE_HEALTHKIT';
jest.mock('../../../../services/health/onDeviceSync', () => {
  const actual = jest.requireActual('../../../../services/health/onDeviceSync');
  return {
    OnDeviceNotSignedInError: actual.OnDeviceNotSignedInError,
    OnDeviceStepError: actual.OnDeviceStepError,
    deviceSourceForPlatform: () => mockDeviceSource,
    refreshOnDevice: (...args: unknown[]) => mockImportHistory(...args),
  };
});

const mockSignOut = jest.fn(async () => undefined);
jest.mock('../../../../services/authActions', () => ({
  signOut: () => mockSignOut(),
}));
const mockOpenHcPermissions = jest.fn(async () => true);
jest.mock('../../../../services/health/onDeviceConnect', () => ({
  openHealthConnectPermissions: () => mockOpenHcPermissions(),
  openHealthConnectStore: jest.fn(async () => true),
}));

const mockReportUnexpected = jest.fn();
jest.mock('../../../../lib/consultation/report', () => ({
  reportUnexpected: (...args: unknown[]) => mockReportUnexpected(...args),
}));

jest.mock('../../../../utils/logger', () => ({
  logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Reduce-motion ON ⇒ the shell takes its documented instant-swap path, so the
// bucket switch is synchronous and the test asserts on the settled UI without
// coupling to the 200ms cross-fade animation timing.
jest.mock('../components/useReduceMotion', () => ({
  useReduceMotion: () => true,
}));

const mockNavigate = jest.fn();
const mockSetParams = jest.fn();
let mockRouteParams: { bucket?: 'fitness' | 'recovery' } = {};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, setParams: mockSetParams }),
  useRoute: () => ({ params: mockRouteParams }),
}));

import WearablesShell from '../WearablesShell';
import { HealthConnectPermissionDeniedError } from '../../../../services/health/healthConnect/errors';

function hcConnection() {
  return {
    id: 'c-hc',
    user_id: 'u1',
    provider: 'HEALTH_CONNECT',
    external_account_id: null,
    access_token_expires_at: null,
    scopes: [],
    webhook_subscription_id: null,
    channel_expires_at: null,
    status: 'connected',
    last_error: null,
    last_synced_at: new Date().toISOString(),
    backfilled_until: null,
    disconnected_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  mockAiInsightsFlag = false;
  mockDeviceSource = 'HEALTH_CONNECT';
  mockImportHistory.mockReset();
  mockOpenHcPermissions.mockClear();
  mockUseWearableConnections.mockReturnValue({ data: [hcConnection()] });
});

describe('probe: every Health Connect permission off, from the Health screen', () => {
  it('the copy says "Then tap Try again": after Open Health Connect, a Try again control exists', async () => {
    mockImportHistory.mockRejectedValue(new HealthConnectPermissionDeniedError(['Steps']));
    await render(<WearablesShell />);
    await waitFor(() =>
      expect(screen.getByText(/access is turned off for The Growth Project/)).toBeTruthy(),
    );
    expect(screen.getByText(/Then tap Try again\./)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Open Health Connect'));
    expect(mockOpenHcPermissions).toHaveBeenCalledTimes(1);
    // The person allowed access in Health Connect and came back: the step the
    // copy names must be on screen and must re-run the refresh.
    await waitFor(() => expect(screen.getByText('Try again')).toBeTruthy());
  });
});
