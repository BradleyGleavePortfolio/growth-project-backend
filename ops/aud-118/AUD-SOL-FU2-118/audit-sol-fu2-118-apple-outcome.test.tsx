/** AUD-SOL-FU2-118: the new unconditional Apple note must stay true when provider discovery is unavailable. */
import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('../../../services/api', () => ({
  deletionApi: {
    issueRecentAuthToken: jest.fn(),
    requestDeletion: jest.fn(),
    getDeletionStatus: jest.fn(),
    cancelDeletion: jest.fn(),
  },
  isAccountDeletedError: () => false,
}));
jest.mock('../../../utils/googleReauth', () => ({ reauthenticateWithGoogle: jest.fn() }));
jest.mock('../../../utils/authProviders', () => ({ getSignInProviders: jest.fn() }));
jest.mock('../../../utils/appleAuth', () => ({
  isAppleAuthAvailable: jest.fn(),
  reauthenticateWithApple: jest.fn(),
}));
jest.mock('../../../services/authActions', () => ({ signOut: jest.fn() }));
jest.mock('../../../hooks/useCurrentUser', () => ({ useCurrentUser: jest.fn() }));
jest.mock('../../../utils/haptics', () => ({
  warningTap: jest.fn(),
  successTap: jest.fn(),
}));
jest.mock('../../../lib/consultation/storage', () => ({
  purgeConsultationDraft: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../theme/ThemeProvider', () => ({
  useTheme: () => ({
    colors: {
      background: '#F5EFE4',
      surface: '#F1E8D5',
      surfaceElevated: '#E8DCC8',
      textPrimary: '#1A1A18',
      textSecondary: '#5C5C5A',
      textMuted: '#B1A89F',
      textOnPrimary: '#F5EFE4',
      primary: '#2C4A36',
      primaryDark: '#1E3326',
      border: '#D9CEBC',
      error: '#4A0404',
      warning: '#C5A253',
      success: '#2C4A36',
      divider: '#E8DCC8',
    },
  }),
}));
jest.mock('expo-font', () => ({ isLoaded: () => true, loadAsync: jest.fn() }));

import DeleteAccountScreen from '../DeleteAccountScreen';
import { deletionApi } from '../../../services/api';
import { useCurrentUser } from '../../../hooks/useCurrentUser';
import { isAppleAuthAvailable, reauthenticateWithApple } from '../../../utils/appleAuth';
import { getSignInProviders } from '../../../utils/authProviders';

function fake<T>(value: unknown): T {
  return value as T;
}

beforeEach(() => {
  jest.clearAllMocks();
  (useCurrentUser as jest.Mock).mockReturnValue({
    id: 'user-probe',
    email: 'probe@example.test',
    name: 'Synthetic Probe',
    role: 'student',
  });
  (deletionApi.getDeletionStatus as jest.Mock).mockResolvedValue({
    data: { state: 'none', grace_days: 14 },
  });
  (getSignInProviders as jest.Mock).mockResolvedValue(null);
  (isAppleAuthAvailable as jest.Mock).mockResolvedValue(true);
  (reauthenticateWithApple as jest.Mock).mockResolvedValue({
    success: true,
    identityToken: 'synthetic-apple-identity',
    authorizationCode: null,
  });
  (deletionApi.issueRecentAuthToken as jest.Mock).mockResolvedValue({
    data: { token: 'synthetic-recent-token' },
  });
});

it.each(['not_requested', undefined])(
  'B-368-1: Apple confirmation with unknown providers and outcome %s still explains the manual removal promised on the form',
  async (outcome) => {
    (deletionApi.requestDeletion as jest.Mock).mockResolvedValue({
      data: {
        state: 'confirmed',
        requested_at: '2026-10-04T12:00:00.000Z',
        confirmed_at: '2026-10-04T12:00:00.000Z',
        purge_after: '2026-10-18T12:00:00.000Z',
        grace_days: 14,
        cancellable: true,
        ...(outcome === undefined ? {} : { apple_revocation: outcome }),
      },
    });
    const navigation = {
      goBack: jest.fn(),
      addListener: jest.fn(() => jest.fn()),
    };
    const ui = await render(
      <DeleteAccountScreen
        navigation={fake<React.ComponentProps<typeof DeleteAccountScreen>['navigation']>(navigation)}
      />,
    );
    await waitFor(() => ui.getByTestId('apple-confirm-button'));
    expect(ui.getByTestId('apple-note').props.children).toMatch(
      /you will see whether Apple removed this app’s access/,
    );
    await act(async () => {
      fireEvent.changeText(ui.getByTestId('confirm-input'), 'DELETE');
    });
    await act(async () => {
      fireEvent.press(ui.getByTestId('apple-confirm-button'));
    });
    await waitFor(() => ui.getByTestId('deletion-date'));
    expect(deletionApi.requestDeletion).toHaveBeenCalled();
    expect(ui.queryByTestId('apple-revoked')).toBeNull();
    expect(ui.queryByTestId('apple-fallback')).not.toBeNull();
  },
);
