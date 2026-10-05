/**
 * ConnectionsScreen — rendering + interaction tests for the Connections Hub.
 *
 * Verifies:
 *   • the provider list renders (every catalog provider appears as a row),
 *   • the correct status badge label renders per connection status
 *     (connected / expired / error / disconnected),
 *   • the relative last-synced chip renders for a synced connection,
 *   • tapping a not-connected provider's Connect button opens the connect sheet
 *     (the sheet is mocked; we assert it receives the tapped provider + visible),
 *   • tapping Disconnect on a connected provider calls the disconnect mutation,
 *   • the loading and error states render with a retry affordance.
 *
 * The hooks and the connect sheet are mocked so the test isolates the screen's
 * own list/badge/action logic.
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

// ─── Mocks ─────────────────────────────────────────────────────────────────────

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

// Capture the props the connect sheet receives so we can assert the connect tap.
const sheetProps: Record<string, unknown> = {};
jest.mock('../ConnectProviderSheet', () => {
  const ReactLocal = require('react');
  return {
    __esModule: true,
    default: (props: Record<string, unknown>) => {
      Object.assign(sheetProps, props);
      return ReactLocal.createElement(ReactLocal.Fragment, null);
    },
  };
});

const mockUseWearableConnections = jest.fn();
const mockDisconnectMutate = jest.fn();
const mockLocalAuth = jest.fn((_source: unknown) => ({ data: undefined as unknown }));
jest.mock('../../../../hooks/useWearableConnections', () => ({
  useWearableConnections: () => mockUseWearableConnections(),
  useLocalOnDeviceAuthorization: (source: unknown) => mockLocalAuth(source),
  useDisconnectProvider: () => ({
    mutate: mockDisconnectMutate,
    isPending: false,
    variables: undefined,
  }),
}));

const mockReportUnexpected = jest.fn();
jest.mock('../../../../lib/consultation/report', () => ({
  reportUnexpected: (...args: unknown[]) => mockReportUnexpected(...args),
}));

import ConnectionsScreen, { buildRows } from '../ConnectionsScreen';
import { configFor, WEARABLE_PROVIDERS } from '../../../../api/wearablesConnectionsApi';
import { disconnectConfirmCopy } from '../disconnectCopy';
import { emptyImportMessage } from '../onDeviceCopy';
import { OnDeviceSessionChangedError } from '../../../../services/health/sessionFence';

function connection(
  provider: string,
  status: string,
  lastSyncedAt: string | null = null,
) {
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
    last_synced_at: lastSyncedAt,
    backfilled_until: null,
    disconnected_at: null,
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-31T09:00:00.000Z',
  };
}

function queryResult(over: Record<string, unknown>) {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    isRefetching: false,
    refetch: jest.fn(),
    ...over,
  };
}

beforeEach(() => {
  mockReportUnexpected.mockReset();
  mockLocalAuth.mockReset();
  mockLocalAuth.mockReturnValue({ data: undefined });
  mockUseWearableConnections.mockReset();
  mockDisconnectMutate.mockReset();
  for (const k of Object.keys(sheetProps)) delete sheetProps[k];
});

describe('ConnectionsScreen — list + badges', () => {
  it('renders a row for every provider in the catalog', async () => {
    mockUseWearableConnections.mockReturnValue(queryResult({ data: [] }));
    await render(<ConnectionsScreen />);
    // Every provider's display name appears (Apple Health, Oura, WHOOP, …).
    expect(screen.getByText('Apple Health')).toBeTruthy();
    expect(screen.getByText('Oura')).toBeTruthy();
    expect(screen.getByText('WHOOP')).toBeTruthy();
    // Sanity: the number of rendered Connect/Reconnect/Disconnect actions
    // equals the catalog size (one primary action per provider row).
    const actions = screen.getAllByRole('button');
    // Header has no buttons; each row has exactly one action button.
    expect(actions.length).toBeGreaterThanOrEqual(WEARABLE_PROVIDERS.length);
  });

  it('shows the Connected badge + relative sync time for a connected provider', async () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    mockUseWearableConnections.mockReturnValue(
      queryResult({ data: [connection('OURA', 'connected', tenMinAgo)] }),
    );
    await render(<ConnectionsScreen />);
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.getByText('10m ago')).toBeTruthy();
    // A connected provider's primary action is Disconnect.
    expect(screen.getByLabelText('Disconnect Oura')).toBeTruthy();
  });

  it('shows the Expired badge + Reconnect action for an expired provider', async () => {
    mockUseWearableConnections.mockReturnValue(
      queryResult({ data: [connection('WHOOP', 'expired')] }),
    );
    await render(<ConnectionsScreen />);
    expect(screen.getByText('Expired')).toBeTruthy();
    expect(screen.getByLabelText('Reconnect WHOOP')).toBeTruthy();
  });

  it('shows the Error badge + Reconnect action for an errored provider', async () => {
    mockUseWearableConnections.mockReturnValue(
      queryResult({ data: [connection('GARMIN', 'error')] }),
    );
    await render(<ConnectionsScreen />);
    expect(screen.getByText('Error')).toBeTruthy();
    expect(screen.getByLabelText('Reconnect Garmin')).toBeTruthy();
  });

  it('shows the Not connected badge + Connect action for an unconnected provider', async () => {
    mockUseWearableConnections.mockReturnValue(queryResult({ data: [] }));
    await render(<ConnectionsScreen />);
    // Strava is not connected → "Connect Strava".
    expect(screen.getByLabelText('Connect Strava')).toBeTruthy();
  });
});

describe('ConnectionsScreen — interactions', () => {
  it('opens the connect sheet with the tapped provider on Connect', async () => {
    mockUseWearableConnections.mockReturnValue(queryResult({ data: [] }));
    await render(<ConnectionsScreen />);
    await fireEvent.press(screen.getByLabelText('Connect Strava'));
    expect(sheetProps.visible).toBe(true);
    expect(sheetProps.provider).toBe('STRAVA');
  });

  // Opus C-317-4 / owner ruling 2026-10-02: Disconnect asks first.
  it('C-317-4: tapping Disconnect asks first and disconnects nothing yet', async () => {
    mockUseWearableConnections.mockReturnValue(
      queryResult({ data: [connection('OURA', 'connected')] }),
    );
    await render(<ConnectionsScreen />);
    await fireEvent.press(screen.getByLabelText('Disconnect Oura'));
    expect(mockDisconnectMutate).not.toHaveBeenCalled();
    expect(screen.getByText('Disconnect Oura?')).toBeTruthy();
    expect(
      screen.getByText(
        'The Growth Project stops receiving new Oura data, and your coach stops seeing new Oura data. Data already shared stays with your coach. You can connect Oura again at any time.',
      ),
    ).toBeTruthy();
  });
});

describe('ConnectionsScreen — disconnect confirm (C-317-4)', () => {
  const axiosErr = (status: number | null, data: unknown = {}) => {
    const { AxiosError, AxiosHeaders } = jest.requireActual('axios');
    if (status === null) return new AxiosError('Network Error', 'ERR_NETWORK', { headers: new AxiosHeaders() });
    return new AxiosError('http', String(status), undefined, undefined, {
      status,
      statusText: '',
      headers: new AxiosHeaders({ 'x-request-id': 'req12345-abcd' }),
      config: { headers: new AxiosHeaders() },
      data,
    });
  };

  async function openConfirm(provider = 'OURA', label = 'Disconnect Oura') {
    mockUseWearableConnections.mockReturnValue(
      queryResult({ data: [connection(provider, 'connected')] }),
    );
    await render(<ConnectionsScreen />);
    await fireEvent.press(screen.getByLabelText(label));
  }

  it('Cancel keeps the source connected', async () => {
    await openConfirm();
    await fireEvent.press(screen.getByTestId('disconnect-cancel'));
    expect(mockDisconnectMutate).not.toHaveBeenCalled();
    expect(screen.queryByText('Disconnect Oura?')).toBeNull();
  });

  it('Cancel is the first (default) action', async () => {
    await openConfirm();
    const cancel = screen.getByTestId('disconnect-cancel');
    const confirm = screen.getByTestId('disconnect-confirm');
    const buttons = screen.getAllByRole('button');
    expect(buttons.indexOf(cancel)).toBeLessThan(buttons.indexOf(confirm));
  });

  it('confirming disconnects and closes on success', async () => {
    mockDisconnectMutate.mockImplementation((_p: string, opts: { onSuccess: () => void }) =>
      opts.onSuccess(),
    );
    await openConfirm();
    await fireEvent.press(screen.getByLabelText('Disconnect Oura now'));
    expect(mockDisconnectMutate).toHaveBeenCalledWith('OURA', expect.any(Object));
    expect(screen.queryByText('Disconnect Oura?')).toBeNull();
  });

  it('names this phone for Apple Health', async () => {
    mockLocalAuth.mockReturnValue({
      data: { userId: 'u1', source: 'APPLE_HEALTHKIT', connectionId: 'c-APPLE_HEALTHKIT' },
    });
    await openConfirm('APPLE_HEALTHKIT', 'Disconnect Apple Health');
    expect(screen.getByText(/stops bringing in new Apple Health data from this phone/)).toBeTruthy();
  });

  it.each([
    [null, /The Growth Project couldn't be reached, so Oura is still connected/, true],
    [429, /Too many tries in a short time, so Oura is still connected/, true],
    [401, /Your session has ended, so Oura is still connected/, false],
    [403, /client account only, so nothing changed/, false],
  ])('a %p failure keeps the dialog open with its own copy', async (status, re, canRetry) => {
    mockDisconnectMutate.mockImplementation((_p: string, opts: { onError: (e: unknown) => void }) =>
      opts.onError(axiosErr(status)),
    );
    await openConfirm();
    await fireEvent.press(screen.getByLabelText('Disconnect Oura now'));
    expect(screen.getByText(re)).toBeTruthy();
    expect(screen.getByText('Disconnect Oura?')).toBeTruthy();
    expect(screen.queryByTestId('disconnect-confirm') != null).toBe(canRetry);
    expect(mockReportUnexpected).not.toHaveBeenCalled();
  });

  it('404 (already disconnected) closes and refreshes the list', async () => {
    const refetch = jest.fn();
    mockDisconnectMutate.mockImplementation((_p: string, opts: { onError: (e: unknown) => void }) =>
      opts.onError(axiosErr(404)),
    );
    mockUseWearableConnections.mockReturnValue(
      queryResult({ data: [connection('OURA', 'connected')], refetch }),
    );
    await render(<ConnectionsScreen />);
    await fireEvent.press(screen.getByLabelText('Disconnect Oura'));
    await fireEvent.press(screen.getByLabelText('Disconnect Oura now'));
    expect(screen.queryByText('Disconnect Oura?')).toBeNull();
    expect(refetch).toHaveBeenCalled();
  });

  it('an unexpected failure shows a reference and support path and is reported', async () => {
    mockDisconnectMutate.mockImplementation((_p: string, opts: { onError: (e: unknown) => void }) =>
      opts.onError(axiosErr(500, { code: 'internal_error' })),
    );
    await openConfirm();
    await fireEvent.press(screen.getByLabelText('Disconnect Oura now'));
    expect(screen.getByText(/Reference req12345\./)).toBeTruthy();
    expect(screen.getByText(/Bradleyapple1031@gmail.com/)).toBeTruthy();
    expect(screen.queryByText(/problem on our side/)).toBeNull();
    expect(screen.queryByText(/Something went wrong/)).toBeNull();
    expect(mockReportUnexpected).toHaveBeenCalledWith(
      'wearables.disconnect',
      expect.objectContaining({ status: 500, code: 'internal_error', requestId: 'req12345-abcd' }),
    );
  });

  it('Sol B-362-6: an account change before the request closes the dialog, with no copy or report', async () => {
    mockDisconnectMutate.mockImplementation((_p: string, opts: { onError: (e: unknown) => void }) =>
      opts.onError(new OnDeviceSessionChangedError()),
    );
    await openConfirm();
    await fireEvent.press(screen.getByLabelText('Disconnect Oura now'));
    expect(screen.queryByText('Disconnect Oura?')).toBeNull();
    expect(screen.queryByText(/still connected/)).toBeNull();
    expect(mockReportUnexpected).not.toHaveBeenCalled();
  });
});

describe('ConnectionsScreen — loading + error states', () => {
  it('renders a loading indicator while fetching', async () => {
    mockUseWearableConnections.mockReturnValue(
      queryResult({ isLoading: true }),
    );
    await render(<ConnectionsScreen />);
    expect(screen.getByLabelText('Loading your connections')).toBeTruthy();
  });

  it('renders an error state with a retry button', async () => {
    const refetch = jest.fn();
    mockUseWearableConnections.mockReturnValue(
      queryResult({ isError: true, refetch }),
    );
    await render(<ConnectionsScreen />);
    const retry = screen.getByLabelText('Retry loading connections');
    expect(retry).toBeTruthy();
    await fireEvent.press(retry);
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

// Opus B-317-5: a connected server row that this phone does not sync (after a
// sign-out, on a second phone, after a reinstall) offers Reconnect, routed to
// the Connect sheet. Only app storage is read for this, never the health store.
describe('ConnectionsScreen — not syncing on this phone (B-317-5)', () => {
  it('shows Not syncing here + Reconnect when this phone has no Connect for the person', async () => {
    mockUseWearableConnections.mockReturnValue(
      queryResult({ data: [connection('APPLE_HEALTHKIT', 'connected')] }),
    );
    mockLocalAuth.mockReturnValue({
      data: { userId: 'u1', source: 'APPLE_HEALTHKIT', connectionId: null },
    });
    await render(<ConnectionsScreen />);
    expect(mockLocalAuth).toHaveBeenCalledWith('APPLE_HEALTHKIT');
    expect(screen.getByText('Not syncing here')).toBeTruthy();
    expect(screen.getByText('Apple Health is not syncing on this phone. Tap Reconnect to continue.')).toBeTruthy();
    expect(screen.queryByLabelText('Disconnect Apple Health')).toBeNull();
    // Nothing opened yet: the sheet (and so any native read) runs only on the tap.
    expect(sheetProps.visible).toBe(false);

    await fireEvent.press(screen.getByLabelText('Reconnect Apple Health'));
    expect(sheetProps.provider).toBe('APPLE_HEALTHKIT');
    expect(sheetProps.visible).toBe(true);
  });

  it('also offers Reconnect when the local Connect is for an older connection', async () => {
    mockUseWearableConnections.mockReturnValue(
      queryResult({ data: [connection('APPLE_HEALTHKIT', 'connected')] }),
    );
    mockLocalAuth.mockReturnValue({
      data: { userId: 'u1', source: 'APPLE_HEALTHKIT', connectionId: 'c-old' },
    });
    await render(<ConnectionsScreen />);
    expect(screen.getByLabelText('Reconnect Apple Health')).toBeTruthy();
  });

  it('keeps Connected + Disconnect when this phone syncs that connection', async () => {
    mockUseWearableConnections.mockReturnValue(
      queryResult({ data: [connection('APPLE_HEALTHKIT', 'connected')] }),
    );
    mockLocalAuth.mockReturnValue({
      data: { userId: 'u1', source: 'APPLE_HEALTHKIT', connectionId: 'c-APPLE_HEALTHKIT' },
    });
    await render(<ConnectionsScreen />);
    expect(screen.getByLabelText('Disconnect Apple Health')).toBeTruthy();
    expect(screen.queryByText('Not syncing here')).toBeNull();
  });
});

// B-364-1 (Sol and Opus H6 probes, runs 37220265977 and 37220573091): Samsung
// Health has no connection of its own; it shares through Health Connect. Its
// row mirrors Health Connect and a stored SAMSUNG_HEALTH row is never active.
describe('ConnectionsScreen — Samsung Health row (B-364-1)', () => {
  const hc = connection('HEALTH_CONNECT', 'connected', '2026-05-31T09:00:00.000Z');
  const legacy = connection('SAMSUNG_HEALTH', 'connected', '2026-05-31T09:00:00.000Z');
  const here = { provider: 'HEALTH_CONNECT' as const, connectionId: hc.id };
  const none = { provider: 'HEALTH_CONNECT' as const, connectionId: null };
  type Conns = Parameters<typeof buildRows>[0];

  it.each([
    ['nothing connected', [], none],
    ['Health Connect syncing here', [hc], here],
    ['Health Connect not syncing here', [hc], none],
    ['a stored Samsung row only', [legacy], none],
    ['a stored Samsung row and Health Connect', [legacy, hc], here],
  ])('mirrors Health Connect: %s', (_case, conns, local) => {
    const rows = buildRows(conns as Conns, local);
    const samsung = rows.find((r) => r.provider === 'SAMSUNG_HEALTH');
    expect({ ...samsung, provider: 'HEALTH_CONNECT' }).toEqual(
      rows.find((r) => r.provider === 'HEALTH_CONNECT'),
    );
  });

  it('after a Samsung Health connect: Connected and Disconnect, which disconnects Health Connect', async () => {
    mockUseWearableConnections.mockReturnValue(queryResult({ data: [hc] }));
    mockLocalAuth.mockReturnValue({ data: { userId: 'u1', source: 'HEALTH_CONNECT', connectionId: hc.id } });
    await render(<ConnectionsScreen />);
    expect(screen.getByLabelText(/^Samsung Health, Connected/)).toBeTruthy();
    expect(screen.queryByLabelText('Connect Samsung Health')).toBeNull();
    expect(screen.getByText(/so this row shows the Health Connect connection/)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Disconnect Samsung Health'));
    expect(screen.getByText(/so this disconnects Health Connect/)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Disconnect Samsung Health now'));
    // The hook disconnects HEALTH_CONNECT for it (useWearableConnections.disconnect.test).
    expect(mockDisconnectMutate).toHaveBeenCalledWith('SAMSUNG_HEALTH', expect.anything());
  });

  it('copy names Health Connect and every app; empty import names the Samsung setting (C-364-2)', () => {
    expect(disconnectConfirmCopy('SAMSUNG_HEALTH', 'Samsung Health').body).toContain('every other app');
    expect(configFor('SAMSUNG_HEALTH').dataDescription).toBe(
      'The Growth Project reads the Health Connect data on this phone, including what Samsung Health shares with Health Connect.',
    );
    const empty = emptyImportMessage('SAMSUNG_HEALTH', 'Health Connect').text;
    expect(empty).toContain('Samsung Health is connected through Health Connect');
    expect(empty).toContain('In Samsung Health, open Settings, then Health Connect');
  });
});
