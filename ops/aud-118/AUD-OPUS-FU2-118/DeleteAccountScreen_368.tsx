/**
 * DeleteAccountScreen — in-app account deletion (Apple 5.1.1(v), GDPR/RCW
 * 19.373 right to deletion). Shared by the client and coach Settings.
 *
 * Flow (backend src/account-deletion/, PR #608):
 *  1. GET /me/delete-account/status on open, on screen focus and when the app
 *     returns to the foreground. `confirmed` shows the status view; `deleted`
 *     (or any 403 ACCOUNT_DELETED) shows the completion view and signs out;
 *     a legacy `requested` row is NOT scheduled and is finished from the form;
 *     a status error shows a retry state, never the form.
 *  2. The form explains what is deleted and kept, asks for DELETE or the
 *     account email, then a re-auth matching the account's sign-in methods:
 *     password, Sign in with Apple (iOS), or Google (Supabase OAuth again).
 *  3. POST /auth/recent-auth-token mints a single-use token from that proof;
 *     POST /me/delete-account with X-Recent-Auth-Token schedules the deletion
 *     in the same request. Apple users also send the authorization code so
 *     the server can revoke Sign in with Apple tokens.
 *  4. Timing copy uses the server's grace_days, purge_after and completes_by.
 *     Apple copy says access was removed only when the server reports
 *     `revoked`; otherwise it explains how to remove the app from the
 *     person's Apple Account (APPLE_FALLBACK).
 *
 * Copy rules: every claim must match the backend erasure manifest
 * (src/account-deletion/account-deletion.manifest.ts). No emoji, no
 * exclamation marks, theme tokens only, accessibilityLabel + accessibilityRole
 * on every control.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import HapticPressable from '../../components/HapticPressable';
import { useTheme, ThemeColors } from '../../theme/ThemeProvider';
import { useCurrentUser } from '../../hooks/useCurrentUser';
import { warningTap, successTap } from '../../utils/haptics';
import { signOut } from '../../services/authActions';
import { SESSION_ENDED_COPY, deletionErrorCopy, isSessionEnded401 } from './deletionErrors';
import {
  deletionApi,
  isAccountDeletedError,
  AppleRevocationOutcome,
  DeletionStatus,
  RecentAuthProof,
} from '../../services/api';
import { isAppleAuthAvailable, reauthenticateWithApple } from '../../utils/appleAuth';
import { reauthenticateWithGoogle } from '../../utils/googleReauth';
import { getSignInProviders, SignInProvider } from '../../utils/authProviders';
import { errorStatus } from '../../types/common';
import { purgeConsultationDraft } from '../../lib/consultation/storage';
import type { NavigationProp, ParamListBase } from '@react-navigation/native';

// The user must type this exact string (case-insensitive) OR their registered
// email address before the re-auth controls are enabled.
const REQUIRED_CONFIRMATION = 'DELETE';

// Mirrors the backend erasure manifest: deleted or irreversibly scrubbed when
// the deletion completes.
export const PERMANENTLY_DELETED: readonly string[] = [
  'Your profile, body measurements and consultation answers',
  'Food, water, fasting, weight and workout logs, check-ins and habits',
  'Health and activity data synced from Apple Health or connected devices, and bloodwork you entered, including uploaded files',
  'Your conversations with Roman, the AI assistant',
  'Your messages, community posts, comments, direct messages, voice notes and reactions',
  'Coach media, notes and briefs, if you coach',
  'Your targets, recipes, lists and preferences',
  'Notification settings and push notification tokens',
];

// Mirrors the manifest's retained rows (operator retention policy).
export const KEPT_RECORDS: readonly string[] = [
  'Payment and tax records that Stripe keeps for as long as the law requires. Our own copies keep only amounts, dates and payment references, with no name or contact details.',
  'One deletion record with a random reference, the date and the result. It holds no name, email or account details.',
  'If you coach: your clients are not deleted. They keep their own data and the plans you assigned, unchanged and without your contact details, and are no longer linked to you.',
];

export const BILLING_NOTE =
  'Any subscription or payment plan you have, as a client or as a coach, is cancelled when the deletion completes, and scheduled reminders and emails stop. Until then it stays active.';

// The steps are Apple's (Apple Support 102571) and match the backend's
// SIGN_IN_WITH_APPLE_DELETION_TEXT (#611, C-611-18). Settings > your name >
// Sign in with Apple is the iOS 18 and later path; the app supports iOS 16.4
// and later, so earlier versions get the account.apple.com steps, which do not
// depend on the iOS version. "Apple Account" is Apple's current name for what
// it used to call the Apple ID (B-PRIV-FU-117).
export const APPLE_FALLBACK =
  'You can also remove this app from your Apple Account yourself. ' +
  'On an iPhone with iOS 18 or later, open Settings, tap your name, then Sign in with Apple, choose this app, tap Delete and follow the steps on screen to confirm. ' +
  'On an earlier version of iOS, or on any other device, sign in at account.apple.com, go to Sign-In & Security, select Sign in with Apple, choose this app and stop using Sign in with Apple for it.';

// Shown on the form. True whatever the server reports: after confirming, the
// status view shows either Apple's confirmation or APPLE_FALLBACK.
export const APPLE_FORM_NOTE =
  'If you signed in with Apple, after you confirm you will see whether Apple removed this app’s access to your Apple Account, and how to remove it yourself if not.';

interface DeleteAccountScreenProps {
  navigation: NavigationProp<ParamListBase>;
}

type ReauthMethod = 'password' | 'apple' | 'google';
type LoadPhase = 'loading' | 'ready' | 'error' | 'deleted';

export function formatDeletionDate(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function reauthErrorMessage(err: unknown, method: ReauthMethod): string {
  const status = errorStatus(err);
  // C-313-6: a 401 from the auth guard means the session ended, not that the
  // password or provider proof was wrong.
  if (isSessionEnded401(err)) return SESSION_ENDED_COPY;
  if (status === 401) {
    if (method === 'password') return 'That password is not correct. Check it and enter it again.';
    if (method === 'apple') return 'Apple could not confirm it is you. Tap Sign in with Apple to try again.';
    return 'Google could not confirm it is you. Sign in with the Google account you use here and try again.';
  }
  return deletionErrorCopy(err, 'confirm', 'delete_account.reauth');
}

export default function DeleteAccountScreen({ navigation }: DeleteAccountScreenProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const currentUser = useCurrentUser();

  const [phase, setPhase] = useState<LoadPhase>('loading');
  const [statusError, setStatusError] = useState(
    'We could not check your account deletion status. Check your connection, then try again.',
  );
  const [status, setStatus] = useState<DeletionStatus | null>(null);
  const [appleOutcome, setAppleOutcome] = useState<AppleRevocationOutcome | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [password, setPassword] = useState('');
  const [appleAvailable, setAppleAvailable] = useState(false);
  const [providers, setProviders] = useState<SignInProvider[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signedOut = useRef(false);

  const userEmail = currentUser?.email ?? '';

  const confirmTextIsValid =
    confirmText.trim().toUpperCase() === REQUIRED_CONFIRMATION ||
    (userEmail !== '' && confirmText.trim().toLowerCase() === userEmail.toLowerCase());

  const markDeleted = useCallback(() => {
    setPhase('deleted');
  }, []);

  const loadStatus = useCallback(
    async (opts: { quiet?: boolean } = {}) => {
      if (!opts.quiet) setPhase('loading');
      try {
        const res = await deletionApi.getDeletionStatus();
        const next = res.data ?? null;
        setStatus(next);
        setPhase(next?.state === 'deleted' ? 'deleted' : 'ready');
      } catch (err) {
        if (isAccountDeletedError(err)) {
          markDeleted();
          return;
        }
        // Unknown state: never fall back to the request form.
        if (!opts.quiet) {
          setStatusError(deletionErrorCopy(err, 'check', 'delete_account.status'));
          setPhase('error');
        }
      }
    },
    [markDeleted],
  );

  useEffect(() => {
    loadStatus();
    let mounted = true;
    isAppleAuthAvailable()
      .then((ok) => {
        if (mounted) setAppleAvailable(ok);
      })
      .catch(() => setAppleAvailable(false));
    getSignInProviders()
      .then((list) => {
        if (mounted) setProviders(list);
      })
      .catch(() => setProviders(null));
    return () => {
      mounted = false;
    };
  }, [loadStatus]);

  // Recheck when the screen regains focus or the app returns to the
  // foreground: the deletion may have completed in the meantime.
  useEffect(() => {
    const unsubscribeFocus = navigation.addListener('focus', () => {
      loadStatus({ quiet: true });
    });
    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') loadStatus({ quiet: true });
    });
    return () => {
      unsubscribeFocus();
      appState.remove();
    };
  }, [navigation, loadStatus]);

  // Deletion completed: clear the local session once.
  useEffect(() => {
    if (phase === 'deleted' && !signedOut.current) {
      signedOut.current = true;
      signOut();
    }
  }, [phase]);

  const schedule = async (
    proof: RecentAuthProof,
    method: ReauthMethod,
    appleAuthorizationCode?: string | null,
  ) => {
    let token: string;
    try {
      const res = await deletionApi.issueRecentAuthToken(proof);
      token = res.data.token;
    } catch (err) {
      if (isAccountDeletedError(err)) return markDeleted();
      setError(reauthErrorMessage(err, method));
      return;
    }
    try {
      const res = await deletionApi.requestDeletion(token, appleAuthorizationCode);
      // Purge the local consultation draft (health answers) as soon as the
      // deletion is scheduled, independent of any later sign-out (Sol A-04;
      // merge-order note C-310-10 with #313).
      if (currentUser?.id) await purgeConsultationDraft(currentUser.id).catch(() => undefined);
      setPassword('');
      setConfirmText('');
      setAppleOutcome(res.data.apple_revocation ?? null);
      setStatus({
        state: 'confirmed',
        requested_at: res.data.requested_at,
        confirmed_at: res.data.confirmed_at,
        grace_days: res.data.grace_days,
        purge_after: res.data.purge_after,
        completes_by: res.data.completes_by ?? null,
        cancellable: res.data.cancellable,
      });
      setPhase('ready');
    } catch (err) {
      if (isAccountDeletedError(err)) return markDeleted();
      setError(deletionErrorCopy(err, 'schedule', 'delete_account.schedule'));
    }
  };

  const runReauth = async (method: ReauthMethod, task: () => Promise<void>) => {
    if (!confirmTextIsValid || busy) return;
    if (method === 'password' && !password) return;
    setError(null);
    setBusy(true);
    warningTap();
    try {
      await task();
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteWithPassword = () =>
    runReauth('password', () => schedule({ password }, 'password'));

  const handleDeleteWithApple = () =>
    runReauth('apple', async () => {
      const apple = await reauthenticateWithApple();
      if (!apple.success || !apple.identityToken) {
        if (!apple.cancelled) {
          setError(apple.error || 'Apple could not confirm it is you. Tap Sign in with Apple to try again.');
        }
        return;
      }
      await schedule(
        { provider: 'apple', provider_token: apple.identityToken },
        'apple',
        apple.authorizationCode,
      );
    });

  const handleDeleteWithGoogle = () =>
    runReauth('google', async () => {
      const google = await reauthenticateWithGoogle();
      if (!google.success || !google.accessToken) {
        if (!google.cancelled) {
          setError(google.error || 'Google could not confirm it is you. Tap Continue with Google to try again.');
        }
        return;
      }
      await schedule({ provider: 'google_session', provider_token: google.accessToken }, 'google');
    });

  const handleKeepAccount = () => {
    Alert.alert('Keep your account?', 'Your account will no longer be scheduled for deletion.', [
      { text: 'Back', style: 'cancel' },
      {
        text: 'Keep my account',
        onPress: async () => {
          setBusy(true);
          setError(null);
          try {
            await deletionApi.cancelDeletion();
            successTap();
            setAppleOutcome(null);
            await loadStatus();
            Alert.alert('Deletion cancelled', 'Your account is no longer scheduled for deletion.');
          } catch (err) {
            if (isAccountDeletedError(err)) {
              markDeleted();
              return;
            }
            if (errorStatus(err) === 409) {
              setError('Your deletion is already being completed and can no longer be cancelled.');
              return;
            }
            setError(deletionErrorCopy(err, 'cancel', 'delete_account.cancel'));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  const header = (
    <View style={styles.topBar}>
      <HapticPressable
        intent="light"
        onPress={() => navigation.goBack()}
        style={styles.backBtn}
        accessibilityRole="button"
        accessibilityLabel="Go back"
      >
        <Ionicons name="arrow-back" size={24} color={colors.textPrimary} />
      </HapticPressable>
      <Text style={styles.topTitle}>Delete account</Text>
      <View style={styles.backBtn} />
    </View>
  );

  const errorView = error ? (
    <Text style={styles.errorText} accessibilityLiveRegion="assertive">
      {error}
    </Text>
  ) : null;

  const deletedList = (
    <View style={styles.card}>
      {PERMANENTLY_DELETED.map((item) => (
        <View key={item} style={styles.listRow}>
          <Ionicons name="close-circle-outline" size={16} color={colors.error} />
          <Text style={styles.listText}>{item}</Text>
        </View>
      ))}
    </View>
  );

  const graceDays =
    typeof status?.grace_days === 'number' && status.grace_days > 0 ? status.grace_days : null;
  const gracePeriod = graceDays ? `${graceDays}-day grace period` : 'grace period';
  const isAppleAccount = providers?.includes('apple') ?? false;

  if (phase === 'loading') {
    return (
      <View style={styles.container}>
        {header}
        <View style={styles.centered}>
          <ActivityIndicator color={colors.primary} accessibilityLabel="Loading deletion status" />
        </View>
      </View>
    );
  }

  // ── Completed ──────────────────────────────────────────────────────────────
  if (phase === 'deleted') {
    return (
      <View style={styles.container}>
        {header}
        <View style={styles.centered}>
          <Text style={styles.statusDate} testID="deletion-complete">
            Your account has been deleted
          </Text>
          <Text style={[styles.bodyText, { marginTop: 12, textAlign: 'center' }]}>
            Your personal data has been removed. You are being signed out of this device.
          </Text>
        </View>
      </View>
    );
  }

  // ── Status unknown ─────────────────────────────────────────────────────────
  if (phase === 'error') {
    return (
      <View style={styles.container}>
        {header}
        <View style={styles.centered}>
          <Text style={styles.bodyText} testID="status-error">
            {statusError}
          </Text>
          <HapticPressable
            intent="light"
            style={styles.keepBtn}
            onPress={() => loadStatus()}
            accessibilityRole="button"
            accessibilityLabel="Try again"
            testID="status-retry"
          >
            <Text style={styles.keepBtnText}>Try again</Text>
          </HapticPressable>
        </View>
      </View>
    );
  }

  // ── Status view: deletion scheduled ────────────────────────────────────────
  if (status?.state === 'confirmed') {
    const date = formatDeletionDate(status.purge_after);
    const cancellable = status.cancellable !== false;
    const showAppleFallback =
      appleOutcome !== 'revoked' && (isAppleAccount || (appleOutcome !== null && appleOutcome !== 'not_requested'));
    return (
      <View style={styles.container}>
        {header}
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <View style={styles.warningBanner}>
            <Ionicons name="time-outline" size={20} color={colors.error} />
            <Text style={styles.warningText} testID="deletion-scheduled-banner">
              Your account is scheduled for deletion.
            </Text>
          </View>
          <Text style={styles.sectionHeading}>Permanent deletion date</Text>
          <View style={styles.card}>
            <Text style={styles.statusDate} testID="deletion-date">
              {date ?? 'When the grace period ends'}
            </Text>
            <Text style={[styles.bodyText, { marginTop: 12 }]} testID="deletion-timing">
              {date
                ? `After ${date}, your account and the data listed below are permanently deleted. This is finished within a day of that date and cannot be undone.`
                : 'When the grace period ends, your account and the data listed below are permanently deleted, usually within a day. This cannot be undone.'}
            </Text>
            <Text style={[styles.bodyText, { marginTop: 12 }]}>
              {cancellable
                ? 'Until then you can keep using the app, and you can cancel the deletion here at any time.'
                : 'The grace period has ended, so this deletion can no longer be cancelled.'}
            </Text>
          </View>
          {appleOutcome === 'revoked' ? (
            <View style={styles.card}>
              <Text style={styles.bodyText} testID="apple-revoked">
                Apple confirmed that this app no longer has access to your Apple Account.
              </Text>
            </View>
          ) : null}
          {showAppleFallback ? (
            <View style={styles.card}>
              <Text style={styles.bodyText} testID="apple-fallback">
                {APPLE_FALLBACK}
              </Text>
            </View>
          ) : null}
          <Text style={styles.sectionHeading}>Permanently deleted</Text>
          {deletedList}
          <Text style={styles.sectionHeading}>Subscriptions and payments</Text>
          <View style={styles.card}>
            <Text style={styles.bodyText}>{BILLING_NOTE}</Text>
          </View>
          {errorView}
          {cancellable ? (
            <HapticPressable
              intent="light"
              style={[styles.keepBtn, busy && styles.deleteBtnDisabled]}
              onPress={handleKeepAccount}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Cancel deletion and keep my account"
              testID="keep-account-button"
            >
              {busy ? (
                <ActivityIndicator color={colors.textOnPrimary} />
              ) : (
                <Text style={styles.keepBtnText}>Keep my account</Text>
              )}
            </HapticPressable>
          ) : null}
          <HapticPressable
            intent="light"
            style={styles.cancelBtn}
            onPress={() => signOut()}
            accessibilityRole="button"
            accessibilityLabel="Sign out"
            testID="sign-out-button"
          >
            <Text style={styles.cancelBtnText}>Sign out</Text>
          </HapticPressable>
        </ScrollView>
      </View>
    );
  }

  // ── Request form (also finishes a legacy unconfirmed request) ─────────────
  const known = providers ?? [];
  const offerAll = providers === null;
  let showPassword = offerAll || known.includes('email');
  let showApple = appleAvailable && (offerAll || known.includes('apple'));
  let showGoogle = offerAll || known.includes('google');
  if (!showPassword && !showApple && !showGoogle) {
    // No matching method on this device: offer everything the platform has.
    showPassword = true;
    showApple = appleAvailable;
    showGoogle = true;
  }
  const passwordEnabled = confirmTextIsValid && password.length > 0 && !busy;
  const providerEnabled = confirmTextIsValid && !busy;
  const methods = [
    showPassword ? 'enter your password' : null,
    showApple ? 'confirm with Apple' : null,
    showGoogle ? 'confirm with Google' : null,
  ].filter((m): m is string => m !== null);
  const methodsText =
    methods.length > 1
      ? `${methods.slice(0, -1).join(', ')} or ${methods[methods.length - 1]}`
      : methods[0];

  return (
    <View style={styles.container}>
      {header}
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {status?.state === 'requested' ? (
          <View style={styles.card}>
            <Text style={styles.bodyText} testID="legacy-request-notice">
              You asked to delete your account earlier, but that request was not confirmed, so
              nothing is scheduled yet. Confirm below to schedule the deletion.
            </Text>
          </View>
        ) : null}

        <View style={styles.warningBanner}>
          <Ionicons name="warning-outline" size={20} color={colors.error} />
          <Text style={styles.warningText}>
            Deletion becomes permanent when the {gracePeriod} ends.
          </Text>
        </View>

        <Text style={styles.sectionHeading}>What happens when you delete your account</Text>
        <View style={styles.card}>
          <Text style={styles.bodyText}>
            When you confirm below, deletion of the account{' '}
            <Text style={styles.bodyBold}>{userEmail}</Text> is scheduled straight away. You will
            see the exact date on the next screen.
          </Text>
          <Text style={[styles.bodyText, { marginTop: 12 }]}>
            There is a <Text style={styles.bodyBold}>{gracePeriod}</Text>. During that time you can
            keep using the app and cancel the deletion from Settings, Delete account.
          </Text>
          <Text style={[styles.bodyText, { marginTop: 12 }]}>
            When it ends, your personal data is permanently deleted, usually within a day. You will
            not be able to recover your account or any data after that.
          </Text>
        </View>

        <Text style={styles.sectionHeading}>Permanently deleted</Text>
        {deletedList}
        <Text
          style={[styles.bodyText, { marginTop: 8, fontSize: 13, color: colors.textMuted }]}
          testID="apple-note"
        >
          {APPLE_FORM_NOTE}
        </Text>

        <Text style={styles.sectionHeading}>What is kept</Text>
        <View style={styles.card}>
          {KEPT_RECORDS.map((item) => (
            <View key={item} style={styles.listRow}>
              <Ionicons name="shield-checkmark-outline" size={16} color={colors.textMuted} />
              <Text style={styles.listText}>{item}</Text>
            </View>
          ))}
        </View>

        <Text style={styles.sectionHeading}>Subscriptions and payments</Text>
        <View style={styles.card}>
          <Text style={styles.bodyText}>{BILLING_NOTE}</Text>
        </View>

        <View style={styles.exportReminder}>
          <Ionicons name="download-outline" size={18} color={colors.primary} />
          <Text style={styles.exportReminderText}>
            Before deleting, consider downloading a copy of your data from Settings under Data
            &amp; Privacy.
          </Text>
        </View>

        <Text style={styles.sectionHeading}>Step 1: Confirm your intent</Text>
        <View style={styles.card}>
          <Text style={styles.bodyText}>
            Type <Text style={styles.bodyBold}>DELETE</Text> or your email address to continue:
          </Text>
          <TextInput
            style={[styles.confirmInput, confirmTextIsValid && styles.confirmInputValid]}
            value={confirmText}
            onChangeText={(t) => {
              setConfirmText(t);
              setError(null);
            }}
            placeholder={userEmail ? `Type DELETE or ${userEmail}` : 'Type DELETE'}
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            accessibilityLabel="Type DELETE or your email to confirm account deletion"
            testID="confirm-input"
          />
        </View>

        <Text style={styles.sectionHeading}>Step 2: Confirm it is you</Text>
        <View style={styles.card}>
          <Text style={styles.bodyText} testID="reauth-methods">
            {`To continue, ${methodsText}.`}
          </Text>
          {showPassword ? (
            <TextInput
              style={styles.reauthInput}
              value={password}
              onChangeText={(t) => {
                setPassword(t);
                setError(null);
              }}
              placeholder="Password"
              placeholderTextColor={colors.textMuted}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="password"
              textContentType="password"
              accessibilityLabel="Your password"
              testID="password-input"
            />
          ) : null}
        </View>

        {errorView}

        {showPassword ? (
          <HapticPressable
            intent="warning"
            style={[styles.deleteBtn, !passwordEnabled && styles.deleteBtnDisabled]}
            onPress={handleDeleteWithPassword}
            disabled={!passwordEnabled}
            accessibilityRole="button"
            accessibilityLabel="Confirm with password and delete my account"
            accessibilityHint="Schedules deletion and starts the grace period"
            testID="confirm-button"
          >
            {busy ? (
              <ActivityIndicator color={colors.textOnPrimary} />
            ) : (
              <Text style={styles.deleteBtnText}>Delete my account</Text>
            )}
          </HapticPressable>
        ) : null}

        {showApple ? (
          <>
            {showPassword ? <Text style={styles.orText}>or</Text> : null}
            <HapticPressable
              intent="warning"
              style={[styles.appleBtn, !providerEnabled && styles.deleteBtnDisabled]}
              onPress={handleDeleteWithApple}
              disabled={!providerEnabled}
              accessibilityRole="button"
              accessibilityLabel="Confirm with Apple and delete my account"
              accessibilityHint="Opens Sign in with Apple, then schedules deletion"
              testID="apple-confirm-button"
            >
              <Ionicons name="logo-apple" size={18} color={colors.background} />
              <Text style={styles.appleBtnText}>Confirm with Apple and delete</Text>
            </HapticPressable>
          </>
        ) : null}

        {showGoogle ? (
          <>
            {showPassword || showApple ? <Text style={styles.orText}>or</Text> : null}
            <HapticPressable
              intent="warning"
              style={[styles.appleBtn, !providerEnabled && styles.deleteBtnDisabled]}
              onPress={handleDeleteWithGoogle}
              disabled={!providerEnabled}
              accessibilityRole="button"
              accessibilityLabel="Confirm with Google and delete my account"
              accessibilityHint="Opens Google sign-in, then schedules deletion"
              testID="google-confirm-button"
            >
              <Ionicons name="logo-google" size={18} color={colors.background} />
              <Text style={styles.appleBtnText}>Confirm with Google and delete</Text>
            </HapticPressable>
          </>
        ) : null}

        <HapticPressable
          intent="light"
          style={styles.cancelBtn}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Cancel, go back to Settings"
        >
          <Text style={styles.cancelBtnText}>Cancel — keep my account</Text>
        </HapticPressable>
      </ScrollView>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    topBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingTop: 56,
      paddingBottom: 12,
    },
    backBtn: {
      width: 40,
      height: 40,
      justifyContent: 'center',
      alignItems: 'center',
    },
    topTitle: {
      fontSize: 18,
      fontWeight: '500',
      color: colors.textPrimary,
    },
    content: {
      paddingHorizontal: 24,
      paddingBottom: 48,
    },
    warningBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      backgroundColor: colors.surface,
      borderRadius: 4,
      borderLeftWidth: 3,
      borderLeftColor: colors.error,
      paddingHorizontal: 14,
      paddingVertical: 12,
      marginBottom: 24,
    },
    warningText: {
      flex: 1,
      fontSize: 14,
      color: colors.error,
      fontWeight: '500',
    },
    sectionHeading: {
      fontSize: 13,
      fontWeight: '500',
      color: colors.textSecondary,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginBottom: 8,
      marginTop: 24,
    },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 4,
      padding: 16,
    },
    bodyText: {
      fontSize: 15,
      color: colors.textPrimary,
      lineHeight: 22,
    },
    bodyBold: {
      fontWeight: '600',
      color: colors.textPrimary,
    },
    listRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 10,
      paddingVertical: 5,
    },
    listText: {
      flex: 1,
      fontSize: 14,
      color: colors.textPrimary,
      lineHeight: 20,
    },
    exportReminder: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 10,
      backgroundColor: colors.surface,
      borderRadius: 4,
      borderLeftWidth: 3,
      borderLeftColor: colors.primary,
      padding: 14,
      marginTop: 24,
    },
    exportReminderText: {
      flex: 1,
      fontSize: 13,
      color: colors.textSecondary,
      lineHeight: 19,
    },
    confirmInput: {
      marginTop: 12,
      backgroundColor: colors.background,
      borderRadius: 2,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 15,
      color: colors.textPrimary,
    },
    confirmInputValid: {
      borderColor: colors.error,
    },
    errorText: {
      marginTop: 10,
      fontSize: 13,
      color: colors.error,
      textAlign: 'center',
    },
    deleteBtn: {
      marginTop: 28,
      backgroundColor: colors.error,
      borderRadius: 2,
      paddingVertical: 16,
      alignItems: 'center',
    },
    deleteBtnDisabled: {
      opacity: 0.4,
    },
    deleteBtnText: {
      fontSize: 16,
      fontWeight: '600',
      color: colors.textOnPrimary,
    },
    cancelBtn: {
      marginTop: 14,
      paddingVertical: 14,
      alignItems: 'center',
    },
    cancelBtnText: {
      fontSize: 15,
      color: colors.textSecondary,
    },
    reauthInput: {
      marginTop: 12,
      backgroundColor: colors.background,
      borderRadius: 2,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 15,
      color: colors.textPrimary,
    },
    orText: {
      marginTop: 14,
      fontSize: 13,
      color: colors.textMuted,
      textAlign: 'center',
    },
    appleBtn: {
      marginTop: 14,
      backgroundColor: colors.textPrimary,
      borderRadius: 2,
      paddingVertical: 16,
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'center',
      gap: 8,
    },
    appleBtnText: {
      fontSize: 16,
      fontWeight: '600',
      color: colors.background,
    },
    statusDate: {
      fontSize: 22,
      fontWeight: '600',
      color: colors.textPrimary,
      marginTop: 6,
    },
    keepBtn: {
      marginTop: 28,
      backgroundColor: colors.primary,
      borderRadius: 2,
      paddingVertical: 16,
      alignItems: 'center',
    },
    keepBtnText: {
      fontSize: 16,
      fontWeight: '600',
      color: colors.textOnPrimary,
    },
    centered: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
