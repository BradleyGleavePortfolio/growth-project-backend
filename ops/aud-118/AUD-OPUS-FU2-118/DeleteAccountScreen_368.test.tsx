/**
 * DeleteAccountScreen tests
 *
 * Tests render, confirmation gate, success flow, and error flow.
 */

import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../../services/api', () => ({
  deletionApi: {
    issueRecentAuthToken: jest.fn(),
    requestDeletion: jest.fn(),
    getDeletionStatus: jest.fn(),
    cancelDeletion: jest.fn(),
  },
  isAccountDeletedError: (err: { response?: { status?: number; data?: { code?: string } } }) =>
    err?.response?.status === 403 && err.response.data?.code === 'ACCOUNT_DELETED',
}));

jest.mock('../../../utils/googleReauth', () => ({
  reauthenticateWithGoogle: jest.fn(),
}));

jest.mock('../../../utils/authProviders', () => ({
  getSignInProviders: jest.fn(),
}));

jest.mock('../../../utils/appleAuth', () => ({
  isAppleAuthAvailable: jest.fn(),
  reauthenticateWithApple: jest.fn(),
}));

jest.mock('../../../services/authActions', () => ({
  signOut: jest.fn(),
}));

jest.mock('../../../hooks/useCurrentUser', () => ({
  useCurrentUser: jest.fn(),
}));

jest.mock('../../../utils/haptics', () => ({
  warningTap: jest.fn(),
  successTap: jest.fn(),
}));

// Provide a minimal theme so styled components don't crash
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

// ─── Import after mocks ────────────────────────────────────────────────────────

import DeleteAccountScreen, { APPLE_FALLBACK } from '../DeleteAccountScreen';
import { deletionApi } from '../../../services/api';
import { signOut } from '../../../services/authActions';
import { useCurrentUser } from '../../../hooks/useCurrentUser';
import { isAppleAuthAvailable, reauthenticateWithApple } from '../../../utils/appleAuth';
import { reauthenticateWithGoogle } from '../../../utils/googleReauth';
import { getSignInProviders } from '../../../utils/authProviders';

const mockedDeletionApi = deletionApi as jest.Mocked<typeof deletionApi>;
const mockedSignOut = signOut as jest.Mock;
const mockedUseCurrentUser = useCurrentUser as jest.Mock;
const mockedAppleAvailable = isAppleAuthAvailable as jest.Mock;
const mockedAppleReauth = reauthenticateWithApple as jest.Mock;
const mockedGoogleReauth = reauthenticateWithGoogle as jest.Mock;
const mockedProviders = getSignInProviders as jest.Mock;

/** Typed test double: lets a partial fixture stand in for a full type. */
function stub<T>(value: unknown): T {
  return value as T;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const focusListeners: Array<() => void> = [];
const mockNavigation = {
  goBack: jest.fn(),
  navigate: jest.fn(),
  addListener: jest.fn((event: string, cb: () => void) => {
    if (event === 'focus') focusListeners.push(cb);
    return jest.fn();
  }),
};

const PURGE_AFTER = '2026-10-14T12:00:00.000Z';
const PURGE_DATE_TEXT = 'October 14, 2026';

function scheduledResponse(over: Record<string, unknown> = {}) {
  return {
    data: {
      state: 'confirmed',
      already_scheduled: false,
      message: 'scheduled',
      requested_at: '2026-09-30T12:00:00.000Z',
      confirmed_at: '2026-09-30T12:00:00.000Z',
      grace_days: 14,
      purge_after: PURGE_AFTER,
      completes_by: '2026-10-15T12:00:00.000Z',
      cancellable: true,
      apple_revocation: 'not_requested',
      ...over,
    },
  };
}

function axiosError(status: number, message?: string, code?: string) {
  return Object.assign(new Error('Request failed'), {
    response: { status, data: { ...(message ? { message } : {}), ...(code ? { code } : {}) } },
  });
}

async function renderScreen() {
  const utils = await render(
    <DeleteAccountScreen navigation={stub<React.ComponentProps<typeof DeleteAccountScreen>['navigation']>(mockNavigation)} />,
  );
  // Wait for the initial status load to settle.
  await waitFor(() => expect(mockedDeletionApi.getDeletionStatus).toHaveBeenCalled());
  return utils;
}

function isDisabled(node: { props: { accessibilityState?: { disabled?: boolean }; disabled?: boolean } }) {
  return node.props.accessibilityState?.disabled ?? node.props.disabled;
}

async function fillForm(
  utils: Awaited<ReturnType<typeof renderScreen>>,
  opts: { confirm?: string; password?: string } = {},
) {
  await waitFor(() => utils.getByTestId('confirm-input'));
  await act(async () => {
    fireEvent.changeText(utils.getByTestId('confirm-input'), opts.confirm ?? 'DELETE');
  });
  if (opts.password !== undefined) {
    await act(async () => {
      fireEvent.changeText(utils.getByTestId('password-input'), opts.password as string);
    });
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

function statusOf<T>(data: Record<string, unknown>): T {
  return stub<T>({ data });
}
const tokenOk = () =>
  mockedDeletionApi.issueRecentAuthToken.mockResolvedValue(
    stub({ data: { token: 'recent-tok', expires_in_ms: 300000 } }),
  );

describe('DeleteAccountScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    focusListeners.length = 0;
    mockedUseCurrentUser.mockReturnValue({
      id: 'user-1',
      email: 'test@example.com',
      name: 'Test User',
      role: 'student',
    });
    mockedDeletionApi.getDeletionStatus.mockResolvedValue(statusOf({ state: 'none', grace_days: 14 }));
    mockedAppleAvailable.mockResolvedValue(false);
    mockedProviders.mockResolvedValue(['email']);
    jest.spyOn(Alert, 'alert');
  });

  describe('request form', () => {
    it('renders server grace period and the manifest-derived lists', async () => {
      const { getByText, getAllByText } = await renderScreen();
      await waitFor(() => getByText(/Your profile, body measurements/i));
      expect(getAllByText('Delete account').length).toBeGreaterThan(0);
      expect(getAllByText(/14-day grace period/i).length).toBeGreaterThan(0);
      expect(getByText(/Payment and tax records that Stripe keeps/i)).toBeTruthy();
      expect(getByText(/One deletion record with a random reference/i)).toBeTruthy();
      expect(getByText(/clients are not deleted/i)).toBeTruthy();
      expect(getAllByText(/cancelled when the deletion completes/i).length).toBeGreaterThan(0);
      expect(getByText(/conversations with Roman/i)).toBeTruthy();
      expect(getByText(/usually within a day/i)).toBeTruthy();
    });

    it('C-313-1: uses the grace period the server reports', async () => {
      mockedDeletionApi.getDeletionStatus.mockResolvedValue(statusOf({ state: 'none', grace_days: 30 }));
      const { getAllByText, queryByText } = await renderScreen();
      await waitFor(() => getAllByText(/30-day grace period/i));
      expect(queryByText(/14-day/i)).toBeNull();
    });

    it('B-313-2/B-313-4: never claims Apple access is revoked, nor a universal anonymization promise', async () => {
      const { toJSON, getByTestId } = await renderScreen();
      await waitFor(() => getByTestId('confirm-input'));
      const json = JSON.stringify(toJSON());
      expect(json).not.toMatch(/access to your Apple ID is also revoked/i);
      expect(json).not.toMatch(/removed from all retained records/i);
      expect(json).not.toMatch(/confirmation email|Contact support/i);
    });

    it('does not contain forbidden tokens (emoji, exclamation marks, income, finance, netWorth)', async () => {
      const { toJSON, getByTestId } = await renderScreen();
      await waitFor(() => getByTestId('confirm-input'));
      const json = JSON.stringify(toJSON());
      const forbiddenTokens = new RegExp(
        ['income', 'finance', 'netWorth', 'conf' + 'etti', '\\ud83c', '[a-z]!'].join('|'),
      );
      expect(json).not.toMatch(forbiddenTokens);
    });

    it('keeps the delete button disabled until DELETE and a password are entered', async () => {
      const utils = await renderScreen();
      await waitFor(() => utils.getByTestId('confirm-button'));
      expect(isDisabled(utils.getByTestId('confirm-button'))).toBe(true);
      await fillForm(utils, { confirm: 'delete' });
      expect(isDisabled(utils.getByTestId('confirm-button'))).toBe(true);
      await fillForm(utils, { confirm: 'delete', password: 'pw' });
      expect(isDisabled(utils.getByTestId('confirm-button'))).toBe(false);
    });

    it('accepts the account email (case-insensitive) instead of DELETE', async () => {
      const utils = await renderScreen();
      await fillForm(utils, { confirm: 'TEST@example.com', password: 'pw' });
      expect(isDisabled(utils.getByTestId('confirm-button'))).toBe(false);
    });

    it('rejects other confirmation text', async () => {
      const utils = await renderScreen();
      await fillForm(utils, { confirm: 'remove', password: 'pw' });
      expect(isDisabled(utils.getByTestId('confirm-button'))).toBe(true);
    });

    it('offers only the password for an email account without Apple available', async () => {
      const utils = await renderScreen();
      await waitFor(() => utils.getByTestId('confirm-input'));
      expect(utils.queryByTestId('apple-confirm-button')).toBeNull();
      expect(utils.queryByTestId('google-confirm-button')).toBeNull();
    });

    it('offers every platform option when the sign-in method is unknown', async () => {
      mockedProviders.mockResolvedValue(null);
      mockedAppleAvailable.mockResolvedValue(true);
      const utils = await renderScreen();
      await waitFor(() => utils.getByTestId('google-confirm-button'));
      expect(utils.getByTestId('password-input')).toBeTruthy();
      expect(utils.getByTestId('apple-confirm-button')).toBeTruthy();
    });
  });

  describe('password re-auth', () => {
    it('mints a recent-auth token, schedules deletion with it and shows the date and window', async () => {
      tokenOk();
      mockedDeletionApi.requestDeletion.mockResolvedValue(stub(scheduledResponse()));
      const utils = await renderScreen();
      await fillForm(utils, { password: 'hunter2' });
      await act(async () => {
        fireEvent.press(utils.getByTestId('confirm-button'));
      });
      await waitFor(() => utils.getByTestId('deletion-date'));
      expect(mockedDeletionApi.issueRecentAuthToken).toHaveBeenCalledWith({ password: 'hunter2' });
      expect(mockedDeletionApi.requestDeletion).toHaveBeenCalledWith('recent-tok', undefined);
      expect(utils.getByTestId('deletion-date').props.children).toBe(PURGE_DATE_TEXT);
      expect(utils.getByTestId('deletion-timing').props.children).toMatch(
        `After ${PURGE_DATE_TEXT}, your account and the data listed below are permanently deleted. This is finished within a day`,
      );
      expect(utils.getByTestId('keep-account-button')).toBeTruthy();
      expect(utils.queryByTestId('apple-fallback')).toBeNull();
      expect(mockedSignOut).not.toHaveBeenCalled();
    });

    it('purges the encrypted consultation draft as soon as deletion is scheduled (Sol A-04, C-310-10)', async () => {
      const { writeLocalState, readLocalState } = jest.requireActual('../../../lib/consultation/storage');
      await writeLocalState('user-1', { screenId: 'P4', answers: { P4: 'yes', P4_note: 'Sensitive screening note' } });
      expect((await readLocalState('user-1'))?.answers.P4_note).toBe('Sensitive screening note');
      tokenOk();
      mockedDeletionApi.requestDeletion.mockResolvedValue(stub(scheduledResponse()));
      const utils = await renderScreen();
      await fillForm(utils, { password: 'hunter2' });
      await act(async () => {
        fireEvent.press(utils.getByTestId('confirm-button'));
      });
      await waitFor(() => utils.getByTestId('deletion-date'));
      expect(await readLocalState('user-1')).toBeNull();
      expect(mockedSignOut).not.toHaveBeenCalled();
    });

    it('keeps the consultation draft when scheduling the deletion fails', async () => {
      const { writeLocalState, readLocalState } = jest.requireActual('../../../lib/consultation/storage');
      await writeLocalState('user-1', { screenId: 'P4', answers: { P4: 'no' } });
      tokenOk();
      mockedDeletionApi.requestDeletion.mockRejectedValue(axiosError(500));
      const utils = await renderScreen();
      await fillForm(utils, { password: 'hunter2' });
      await act(async () => {
        fireEvent.press(utils.getByTestId('confirm-button'));
      });
      await waitFor(() => expect(mockedDeletionApi.requestDeletion).toHaveBeenCalled());
      expect((await readLocalState('user-1'))?.answers.P4).toBe('no');
    });

    it('shows a wrong-password message on 401, does not request deletion and does not sign out', async () => {
      mockedDeletionApi.issueRecentAuthToken.mockRejectedValue(stub(axiosError(401)));
      const utils = await renderScreen();
      await fillForm(utils, { password: 'nope' });
      await act(async () => {
        fireEvent.press(utils.getByTestId('confirm-button'));
      });
      await waitFor(() => utils.getByText(/password is not correct/i));
      expect(mockedDeletionApi.requestDeletion).not.toHaveBeenCalled();
      expect(mockedSignOut).not.toHaveBeenCalled();
    });

    it('shows a rate-limit message on 429', async () => {
      mockedDeletionApi.issueRecentAuthToken.mockRejectedValue(stub(axiosError(429)));
      const utils = await renderScreen();
      await fillForm(utils, { password: 'pw' });
      await act(async () => {
        fireEvent.press(utils.getByTestId('confirm-button'));
      });
      await waitFor(() => utils.getByText(/Too many attempts/i));
    });

    it('an expired identity check when scheduling says so, offers to confirm again and stays on the form', async () => {
      tokenOk();
      mockedDeletionApi.requestDeletion.mockRejectedValue(
        stub(axiosError(401, 'Recent authentication required')),
      );
      const utils = await renderScreen();
      await fillForm(utils, { password: 'pw' });
      await act(async () => {
        fireEvent.press(utils.getByTestId('confirm-button'));
      });
      await waitFor(() =>
        utils.getByText('The check that it is you has expired. Confirm it is you again, then send the request.'),
      );
      expect(utils.queryByTestId('deletion-date')).toBeNull();
      expect(mockedSignOut).not.toHaveBeenCalled();
    });
  });

  describe('Sign in with Apple re-auth (B-313-2)', () => {
    beforeEach(() => {
      mockedAppleAvailable.mockResolvedValue(true);
      mockedProviders.mockResolvedValue(['apple']);
      mockedAppleReauth.mockResolvedValue({
        success: true,
        identityToken: 'apple-id',
        authorizationCode: 'apple-code',
      });
      tokenOk();
    });

    async function confirmWithApple(outcome: string) {
      mockedDeletionApi.requestDeletion.mockResolvedValue(
        stub(scheduledResponse({ apple_revocation: outcome })),
      );
      const utils = await renderScreen();
      await waitFor(() => utils.getByTestId('apple-confirm-button'));
      await fillForm(utils);
      await act(async () => {
        fireEvent.press(utils.getByTestId('apple-confirm-button'));
      });
      await waitFor(() => utils.getByTestId('deletion-date'));
      return utils;
    }

    it('re-authenticates with Apple and forwards the authorization code for revocation', async () => {
      const utils = await confirmWithApple('revoked');
      expect(mockedDeletionApi.issueRecentAuthToken).toHaveBeenCalledWith({
        provider: 'apple',
        provider_token: 'apple-id',
      });
      expect(mockedDeletionApi.requestDeletion).toHaveBeenCalledWith('recent-tok', 'apple-code');
      expect(utils.getByTestId('apple-revoked')).toBeTruthy();
      expect(utils.queryByTestId('apple-fallback')).toBeNull();
    });

    it.each(['not_configured', 'exchange_failed', 'revoke_failed', 'not_requested'])(
      'outcome %s: no revocation claim, shows the Apple Account settings fallback',
      async (outcome) => {
        const utils = await confirmWithApple(outcome);
        expect(utils.queryByTestId('apple-revoked')).toBeNull();
        expect(utils.getByTestId('apple-fallback').props.children).toMatch(/Sign in with Apple/);
        expect(JSON.stringify(utils.toJSON())).not.toMatch(/no longer has access/);
      },
    );

    // B-PRIV-FU-117 (agent 117): the copy uses Apple's current name, "Apple
    // Account", on every view, and the form's Apple note has no first person.
    it.each(['revoked', 'not_configured', 'revoke_failed'])(
      'outcome %s: the scheduled view says Apple Account, never Apple ID',
      async (outcome) => {
        const utils = await confirmWithApple(outcome);
        const json = JSON.stringify(utils.toJSON());
        expect(json).not.toMatch(/Apple ID/);
        expect(json).toMatch(/your Apple Account/);
      },
    );

    it('the revoked view names the Apple Account', async () => {
      const utils = await confirmWithApple('revoked');
      expect(utils.getByTestId('apple-revoked').props.children).toBe(
        'Apple confirmed that this app no longer has access to your Apple Account.',
      );
    });

    it('the form says Apple Account, and its Apple note has no first person', async () => {
      const utils = await renderScreen();
      await waitFor(() => utils.getByTestId('apple-confirm-button'));
      expect(JSON.stringify(utils.toJSON())).not.toMatch(/Apple ID/);
      const note = utils.getByTestId('apple-note');
      const text = [note.props.children].flat().join('');
      expect(text).toBe(
        'If you signed in with Apple, after you confirm you will see whether Apple removed this app’s access to your Apple Account, and how to remove it yourself if not.',
      );
      expect(text).not.toMatch(/\b(we|our|us)\b/i);
    });

    it('hides the password field for an Apple-only account', async () => {
      const utils = await renderScreen();
      await waitFor(() => utils.getByTestId('apple-confirm-button'));
      expect(utils.queryByTestId('password-input')).toBeNull();
    });

    it('stays silent when the user cancels the Apple sheet', async () => {
      mockedAppleReauth.mockResolvedValue({ success: false, cancelled: true });
      const utils = await renderScreen();
      await waitFor(() => utils.getByTestId('apple-confirm-button'));
      await fillForm(utils);
      await act(async () => {
        fireEvent.press(utils.getByTestId('apple-confirm-button'));
      });
      expect(mockedDeletionApi.issueRecentAuthToken).not.toHaveBeenCalled();
      expect(utils.queryByText(/Apple could not confirm/i)).toBeNull();
    });
  });

  describe('Google re-auth (B-313-1)', () => {
    beforeEach(() => {
      mockedProviders.mockResolvedValue(['google']);
    });

    async function pressGoogle() {
      const utils = await renderScreen();
      await waitFor(() => utils.getByTestId('google-confirm-button'));
      expect(utils.queryByTestId('password-input')).toBeNull();
      expect(isDisabled(utils.getByTestId('google-confirm-button'))).toBe(true);
      await fillForm(utils);
      await act(async () => {
        fireEvent.press(utils.getByTestId('google-confirm-button'));
      });
      return utils;
    }

    it('OAuth-only success: fresh Google session proof schedules the deletion', async () => {
      mockedGoogleReauth.mockResolvedValue({ success: true, accessToken: 'fresh-session' });
      tokenOk();
      mockedDeletionApi.requestDeletion.mockResolvedValue(stub(scheduledResponse()));
      const utils = await pressGoogle();
      await waitFor(() => utils.getByTestId('deletion-date'));
      expect(mockedDeletionApi.issueRecentAuthToken).toHaveBeenCalledWith({
        provider: 'google_session',
        provider_token: 'fresh-session',
      });
      expect(mockedDeletionApi.requestDeletion).toHaveBeenCalledWith('recent-tok', undefined);
    });

    it('cancel: stays on the form without an error', async () => {
      mockedGoogleReauth.mockResolvedValue({ success: false, cancelled: true });
      const utils = await pressGoogle();
      expect(mockedDeletionApi.issueRecentAuthToken).not.toHaveBeenCalled();
      expect(utils.queryByText(/Google could not confirm/i)).toBeNull();
    });

    it('stale or wrong account: the server 401 becomes a clear Google message', async () => {
      mockedGoogleReauth.mockResolvedValue({ success: true, accessToken: 'other-account' });
      mockedDeletionApi.issueRecentAuthToken.mockRejectedValue(stub(axiosError(401)));
      const utils = await pressGoogle();
      await waitFor(() => utils.getByText(/Google could not confirm it is you/i));
      expect(mockedDeletionApi.requestDeletion).not.toHaveBeenCalled();
      expect(mockedSignOut).not.toHaveBeenCalled();
    });

    it('provider error: shows the Google error text', async () => {
      mockedGoogleReauth.mockResolvedValue({ success: false, error: 'access_denied' });
      const utils = await pressGoogle();
      await waitFor(() => utils.getByText('access_denied'));
    });
  });

  describe('legacy requested state (B-313-3)', () => {
    it('is shown as not scheduled and can be completed with re-auth', async () => {
      mockedDeletionApi.getDeletionStatus.mockResolvedValue(
        statusOf({ state: 'requested', requested_at: '2026-01-01T00:00:00.000Z', grace_days: 14 }),
      );
      tokenOk();
      mockedDeletionApi.requestDeletion.mockResolvedValue(stub(scheduledResponse()));
      const utils = await renderScreen();
      await waitFor(() => utils.getByTestId('legacy-request-notice'));
      expect(utils.queryByTestId('deletion-date')).toBeNull();
      expect(utils.queryByText(/scheduled for deletion/i)).toBeNull();
      await fillForm(utils, { password: 'pw' });
      await act(async () => {
        fireEvent.press(utils.getByTestId('confirm-button'));
      });
      await waitFor(() => utils.getByTestId('deletion-date'));
      expect(mockedDeletionApi.requestDeletion).toHaveBeenCalledTimes(1);
    });
  });

  describe('status view', () => {
    beforeEach(() => {
      mockedDeletionApi.getDeletionStatus.mockResolvedValue(
        statusOf({ state: 'confirmed', purge_after: PURGE_AFTER, cancellable: true, grace_days: 14 }),
      );
    });

    it('shows the scheduled date instead of the form when deletion is already scheduled', async () => {
      const utils = await renderScreen();
      await waitFor(() => utils.getByTestId('deletion-date'));
      expect(utils.getByTestId('deletion-date').props.children).toBe(PURGE_DATE_TEXT);
      expect(utils.queryByTestId('confirm-input')).toBeNull();
    });

    it('cancels the deletion after confirmation and returns to the form', async () => {
      mockedDeletionApi.cancelDeletion.mockResolvedValue(stub({ data: { message: 'ok' } }));
      const utils = await renderScreen();
      await waitFor(() => utils.getByTestId('keep-account-button'));
      await act(async () => {
        fireEvent.press(utils.getByTestId('keep-account-button'));
      });
      const alertMock = Alert.alert as jest.Mock;
      const buttons = alertMock.mock.calls[0][2] as Array<{ text: string; onPress?: () => unknown }>;
      const keep = buttons.find((b) => b.text === 'Keep my account');
      mockedDeletionApi.getDeletionStatus.mockResolvedValue(statusOf({ state: 'none' }));
      await act(async () => {
        await keep?.onPress?.();
      });
      expect(mockedDeletionApi.cancelDeletion).toHaveBeenCalledTimes(1);
      await waitFor(() => utils.getByTestId('confirm-input'));
    });

    it('explains a 409 when the deletion is already being completed', async () => {
      mockedDeletionApi.cancelDeletion.mockRejectedValue(stub(axiosError(409)));
      const utils = await renderScreen();
      await waitFor(() => utils.getByTestId('keep-account-button'));
      await act(async () => {
        fireEvent.press(utils.getByTestId('keep-account-button'));
      });
      const buttons = (Alert.alert as jest.Mock).mock.calls[0][2] as Array<{
        text: string;
        onPress?: () => unknown;
      }>;
      await act(async () => {
        await buttons.find((b) => b.text === 'Keep my account')?.onPress?.();
      });
      await waitFor(() => utils.getByText(/already being completed/i));
    });

    it('hides cancel once the grace period can no longer be cancelled', async () => {
      mockedDeletionApi.getDeletionStatus.mockResolvedValue(
        statusOf({ state: 'confirmed', purge_after: PURGE_AFTER, cancellable: false }),
      );
      const utils = await renderScreen();
      await waitFor(() => utils.getByTestId('deletion-date'));
      expect(utils.queryByTestId('keep-account-button')).toBeNull();
    });

    it('signs out from the status view', async () => {
      const utils = await renderScreen();
      await waitFor(() => utils.getByTestId('sign-out-button'));
      await act(async () => {
        fireEvent.press(utils.getByTestId('sign-out-button'));
      });
      expect(mockedSignOut).toHaveBeenCalled();
    });
  });

  describe('completion and errors (B-313-5)', () => {
    it('a deleted status shows completion and signs out once', async () => {
      mockedDeletionApi.getDeletionStatus.mockResolvedValue(
        statusOf({ state: 'deleted', deleted_at: '2026-10-15T03:00:00.000Z' }),
      );
      const utils = await renderScreen();
      await waitFor(() => utils.getByTestId('deletion-complete'));
      await waitFor(() => expect(mockedSignOut).toHaveBeenCalledTimes(1));
    });

    it('a 403 ACCOUNT_DELETED from the API is treated as completion', async () => {
      mockedDeletionApi.getDeletionStatus.mockRejectedValue(
        stub(axiosError(403, 'Account has been deleted', 'ACCOUNT_DELETED')),
      );
      const utils = await renderScreen();
      await waitFor(() => utils.getByTestId('deletion-complete'));
      expect(mockedSignOut).toHaveBeenCalledTimes(1);
    });

    it('rechecks on focus and moves to completion when the deletion has finished', async () => {
      mockedDeletionApi.getDeletionStatus.mockResolvedValue(
        statusOf({ state: 'confirmed', purge_after: PURGE_AFTER, cancellable: true }),
      );
      const utils = await renderScreen();
      await waitFor(() => utils.getByTestId('deletion-date'));
      expect(mockNavigation.addListener).toHaveBeenCalledWith('focus', expect.any(Function));
      mockedDeletionApi.getDeletionStatus.mockResolvedValue(statusOf({ state: 'deleted' }));
      await act(async () => {
        focusListeners.forEach((cb) => cb());
      });
      await waitFor(() => utils.getByTestId('deletion-complete'));
      expect(mockedSignOut).toHaveBeenCalledTimes(1);
    });

    it('a status error shows a retry state, never the form, and does not sign out', async () => {
      mockedDeletionApi.getDeletionStatus.mockRejectedValueOnce(new Error('Network Error'));
      const utils = await renderScreen();
      await waitFor(() => utils.getByTestId('status-error'));
      expect(utils.queryByTestId('confirm-input')).toBeNull();
      expect(mockedSignOut).not.toHaveBeenCalled();
      mockedDeletionApi.getDeletionStatus.mockResolvedValue(statusOf({ state: 'none' }));
      await act(async () => {
        fireEvent.press(utils.getByTestId('status-retry'));
      });
      await waitFor(() => utils.getByTestId('confirm-input'));
    });
  });

  describe('navigation', () => {
    it('goes back from the header back button', async () => {
      const utils = await renderScreen();
      await waitFor(() => utils.getByLabelText('Go back'));
      fireEvent.press(utils.getByLabelText('Go back'));
      expect(mockNavigation.goBack).toHaveBeenCalled();
    });

    it('goes back from "Cancel — keep my account"', async () => {
      const utils = await renderScreen();
      await waitFor(() => utils.getByLabelText('Cancel, go back to Settings'));
      fireEvent.press(utils.getByLabelText('Cancel, go back to Settings'));
      expect(mockNavigation.goBack).toHaveBeenCalled();
    });
  });
});

// B-PRIV-FU-117 (agent 117): the removal steps are Apple's own (Apple Support
// 102571, https://support.apple.com/en-us/102571) and match the backend's
// SIGN_IN_WITH_APPLE_DELETION_TEXT (#611, C-611-18). The iPhone path
// (Settings > your name > Sign in with Apple) is the iOS 18 and later one;
// the app supports iOS 16.4 and later, so earlier versions get the
// account.apple.com steps, which do not depend on the iOS version.
describe('APPLE_FALLBACK: Apple’s current names and steps (B-PRIV-FU-117)', () => {
  it('is pinned word for word', () => {
    expect(APPLE_FALLBACK).toBe(
      'You can also remove this app from your Apple Account yourself. ' +
        'On an iPhone with iOS 18 or later, open Settings, tap your name, then Sign in with Apple, choose this app, tap Delete and follow the steps on screen to confirm. ' +
        'On an earlier version of iOS, or on any other device, sign in at account.apple.com, go to Sign-In & Security, select Sign in with Apple, choose this app and stop using Sign in with Apple for it.',
    );
  });

  it('says iOS 18 or later before the first iPhone step', () => {
    const iphone = APPLE_FALLBACK.split('. ').find((sentence) => sentence.includes('open Settings'));
    expect(iphone).toBeDefined();
    expect(iphone?.indexOf('iOS 18 or later')).toBeGreaterThanOrEqual(0);
    expect(iphone?.indexOf('iOS 18 or later')).toBeLessThan(iphone?.indexOf('open Settings') ?? -1);
    // Sign-In & Security is the web menu, not an iPhone step.
    expect(iphone).not.toMatch(/Sign-In & Security/);
  });

  it('gives earlier iOS versions and other devices the web steps', () => {
    // Match the phrase, not a bare host name (CodeQL js/incomplete-url-substring-sanitization).
    const web = APPLE_FALLBACK.split('. ').filter((sentence) =>
      sentence.includes('sign in at account.apple.com, go to'),
    );
    expect(web).toHaveLength(1);
    expect(web[0]).toMatch(/^On an earlier version of iOS, or on any other device, /);
    expect(web[0]).toMatch(/Sign-In & Security/);
    expect(web[0]).not.toMatch(/Settings,/);
  });

  it('uses no old Apple names, no first person and no exclamation mark', () => {
    expect(APPLE_FALLBACK).not.toMatch(/Apple ID/);
    expect(APPLE_FALLBACK).not.toMatch(/Password (and|&) Security|Apps Using/);
    expect(APPLE_FALLBACK).not.toMatch(/\b(we|our|us)\b/i);
    expect(APPLE_FALLBACK).not.toMatch(/!/);
  });
});
