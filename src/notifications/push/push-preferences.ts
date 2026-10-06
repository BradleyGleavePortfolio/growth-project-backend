// Which preference column gates a notification kind, shared by the inbox
// writer (NotificationsService) and the push worker (PushDeliveryService).
//
// B-NOTIF-6 (Sol B-648-9): a push can wait in the outbox (quiet hours, the
// burst cap, a provider retry). The worker re-reads the recipient's current
// preferences right before it hands the push to Expo, through the SAME
// mapping and the SAME rule the enqueue gate uses, so a switch turned off
// (or "mute all") while a push waits suppresses it.

/**
 * Maps a NotificationKind value to the base preferences key prefix.
 * E.g. 'milestone_reached' -> 'milestone'
 */
export function notificationPrefsPrefix(kind: string): string {
  // NUDGE-V1 — most specific match wins. Nudge kinds are 'nudge_<trigger>'
  // so the prefs prefix maps 1:1 (e.g. nudge_missed_checkin_inapp). Tested
  // separately so a stray rename here fails the suite loudly.
  if (kind === 'nudge_missed_checkin') return 'nudge_missed_checkin';
  // Streak-broken kind maps to 'practice_paused' column prefix (doctrine).
  if (kind === 'nudge_streak_broken') return 'nudge_practice_paused';
  if (kind === 'nudge_onboarding_abandoned') return 'nudge_onboarding_abandoned';
  if (kind === 'nudge_inactive') return 'nudge_inactive';
  if (kind.startsWith('milestone')) return 'milestone';
  if (kind.startsWith('message')) return 'message';
  if (kind.startsWith('missed_checkin')) return 'missed_checkin';
  if (kind.startsWith('weight_trend')) return 'weight_trend';
  if (kind.startsWith('checkin_submitted')) return 'checkin_submitted';
  if (kind.startsWith('build_week')) return 'build_week';
  if (kind.startsWith('coach_alert')) return 'coach_alert';
  if (kind.startsWith('booking')) return 'booking';
  // PR-10 — DRIP_RELEASED (buyer content-unlocked alert). Routes to
  // the `drip_released_*` prefs columns (migration
  // 20261205000000_pr10_scheduled_drop_retry_lock); defaults are
  // push+inapp ON, email OFF. Without this branch the kind fell
  // through to the 'digest' safe-default whose _inapp + _push
  // defaults are FALSE, silently short-circuiting every in-app row
  // write — the PR-10 R1 P2 fix.
  if (kind.startsWith('drip_released')) return 'drip_released';
  // C05 item 7 — WORKOUT_REMINDER routes to workout_reminder_* (default ON).
  if (kind.startsWith('workout_reminder')) return 'workout_reminder';
  // PR-15A — COACH_NEW_PURCHASE routes to the dedicated
  // coach_new_purchase_* prefs columns (migration
  // 20261208000000_pr15_coach_new_purchase_prefs); defaults push+inapp
  // ON, email OFF. Without this branch the kind falls through to the
  // 'digest' safe-default (push+inapp default FALSE), silently
  // short-circuiting every COACH_NEW_PURCHASE row write — the exact
  // PR-10 R1 P2 bug the brief calls out.
  if (kind.startsWith('coach_new_purchase')) return 'coach_new_purchase';
  // Roman P4 (Option C) — FIRST_PAYMENT. Code-level kind with NO
  // NotificationPreferences migration (the first-payment celebration is a
  // once-ever coach moment that is not opt-out-able), so this prefix has no
  // matching `first_payment_*` prefs columns. Returning a dedicated prefix
  // (rather than letting it fall through to the 'digest' safe-default, whose
  // _push / _inapp defaults are FALSE) means the per-kind gate reads
  // `prefs['first_payment_<channel>']` which is `undefined` — and the gate
  // only blocks on an explicit `=== false`, so the row is written. Without
  // this branch FIRST_PAYMENT would silently short-circuit on the 'digest'
  // false defaults (the PR-10 R1 P2 silent-drop bug, 50-Failures #36).
  if (kind.startsWith('first_payment')) return 'first_payment';
  // B-TRIALS (OR-113-2) — TRIAL_ENDING is a billing notice with no prefs
  // columns (same reasoning as FIRST_PAYMENT): a dedicated prefix keeps it
  // off the 'digest' false defaults so the notice is always written and sent.
  if (kind.startsWith('trial_ending')) return 'trial_ending';
  if (kind.startsWith('fasting')) return 'fasting';
  if (kind.includes('digest')) return 'digest';
  return 'digest'; // safe default — falls back to digest prefs
}

/**
 * True when the recipient's preferences allow a device push of this kind.
 * Same rule as the enqueue gate: no preferences row means the defaults
 * (allowed); `muted` blocks everything; `<prefix>_push === false` blocks the
 * kind. A kind without a column (first payment) is never blocked by it.
 */
export function pushAllowedByPreferences(
  prefs: Record<string, unknown> | null | undefined,
  kind: string,
): boolean {
  if (!prefs) return true;
  if (prefs.muted === true) return false;
  return prefs[`${notificationPrefsPrefix(kind)}_push`] !== false;
}
