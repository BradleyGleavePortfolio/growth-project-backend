// Which preference column gates a notification kind, shared by the inbox
// writer (NotificationsService) and the push worker (PushDeliveryService).
//
// B-NOTIF-6 (Sol B-648-9): a push can wait in the outbox (quiet hours, the
// burst cap, a provider retry). The worker re-reads the recipient's current
// preferences right before it hands the push to Expo, through the SAME
// mapping and the SAME rule the enqueue gate uses, so a switch turned off
// (or "mute all", for a kind it mutes) while a push waits suppresses it.

import { MONEY_NOTIFICATION_KINDS } from '../notification-kind';
import { SAFETY_ALERT_PUSH_BODY } from './lock-screen-copy';

// DUNNING-KIND-FIX: kinds with no column of their own keep their own name as the prefix, so only `muted`
// stops them, and only their non-money pushes (muteAllStops; src/notifications/README.md defaults tables).
// On the 'digest' default (in-app and push off) a default user lost the payment blocker row, the meal plan
// row and five community inbox rows.
const NO_COLUMN_KINDS: ReadonlySet<string> = new Set([
  'dunning_blocker',
  'meal_plan_assigned',
  'coach_client_moved',
  'community_dm_received',
  'community_post_replied',
  'community_event_starting_soon',
  'community_challenge_milestone',
  'community_moderation_action_against_me',
  'community_membership_changed',
]);

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
  // FU-WORKLOG-126 R2 (B-814-1) — WORKOUT_ASSIGNED shares the
  // workout_reminder_* prefs columns (push + inapp default TRUE, and the
  // client can still switch them off). Without this branch the kind fell
  // through to the 'digest' safe default, whose _push and _inapp defaults
  // are FALSE, so every assignment push AND its notification-centre row
  // were dropped before enqueue for a client with default preferences.
  if (kind.startsWith('workout_assigned')) return 'workout_reminder';
  if (NO_COLUMN_KINDS.has(kind)) return kind;
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
  // RENEWAL-BE: the client's "plan renewal reminders" switch (plan_renewal_push, default on).
  if (kind === 'plan_renewal') return 'plan_renewal';
  // PUSH-KIND-FIX (b#1138): every space chat push (unread, reply, High alert). No prefs column: only `muted` and
  // the space's own setting (Mute all, silence) stop it; on 'digest' (push default off) none was ever sent.
  if (kind === 'community_message_received') return 'community_message';
  if (kind.startsWith('fasting')) return 'fasting';
  if (kind.includes('digest')) return 'digest';
  return 'digest'; // safe default — falls back to digest prefs
}

/**
 * FR-1154 (owner #171-3): the pass a money push of a shared kind (a payout notice or the Day 7 payment
 * alert, both `coach_alert`) carries in its push context. A push context is stored with the outbox row,
 * so the enqueue gate and both send-time re-checks read the same pass.
 */
export const MUTE_ALL_PASS = { passesMuteAll: true } as const;
export type MuteAllPass = { passesMuteAll?: true };

/** Owner #168-18 (a Roman safety alert, any SAFETY_ALERT_PUSH_BODY type) and owner #171-3 (MUTE_ALL_PASS). */
function contextPassesMuteAll(context: unknown): boolean {
  const c = (context ?? {}) as { passesMuteAll?: unknown; safetyAlert?: unknown };
  if (c.passesMuteAll === true) return true;
  const safety = c.safetyAlert;
  return typeof safety === 'string' && Object.prototype.hasOwnProperty.call(SAFETY_ALERT_PUSH_BODY, safety);
}

/**
 * MUTE-PAY (owner #171-3): whether "Mute all notifications" (`muted`) stops
 * this kind on this channel. Never an in-app row, never a money kind
 * (MONEY_NOTIFICATION_KINDS) on any channel, never a push whose context is a
 * safety alert or carries MUTE_ALL_PASS; every other push and email, yes.
 */
export function muteAllStops(
  prefs: Record<string, unknown> | null | undefined,
  kind: string,
  channel: 'push' | 'email' | 'inapp',
  context?: unknown,
): boolean {
  if (prefs?.muted !== true || channel === 'inapp' || MONEY_NOTIFICATION_KINDS.has(kind)) return false;
  return !contextPassesMuteAll(context);
}

/**
 * True when the recipient's preferences allow a device push of this kind.
 * Same rule as the enqueue gate: no preferences row means the defaults
 * (allowed); `muted` blocks every push but a money or safety one (muteAllStops,
 * with the push's stored context); `<prefix>_push === false` blocks the kind.
 * A kind without a column (first payment) is never blocked by it.
 */
export function pushAllowedByPreferences(
  prefs: Record<string, unknown> | null | undefined,
  kind: string,
  context?: unknown,
): boolean {
  if (!prefs) return true;
  if (muteAllStops(prefs, kind, 'push', context)) return false;
  return prefs[`${notificationPrefsPrefix(kind)}_push`] !== false;
}
