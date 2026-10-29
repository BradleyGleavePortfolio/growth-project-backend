import { NotificationKind, type NotificationKindValue } from '../../src/notifications/notification-kind';
import { SAFETY_ALERT_PUSH_BODY, type PushContext } from '../../src/notifications/push/lock-screen-copy';
import { MUTE_ALL_PASS, type MuteAllPass } from '../../src/notifications/push/push-preferences';
import type { SendVia } from './notify-sender-scan';

/**
 * KT-4 sender registry (TRAPTEST-NOTIFY-BE). One row for every function in src/ that sends a device push or
 * writes an in-app notice, with the rules it follows. src/notifications/__tests__/sender-registry.spec.ts
 * reads src/ and fails when a send site is missing here, when a row here has no send site any more, and when a
 * sender does not do what its row says. Read that spec's header before you edit this file.
 *
 * The five rules (KT-4):
 * - Mute all (`NotificationPreferences.muted`, owner #171-3): stops every device push except money kinds
 *   (MONEY_NOTIFICATION_KINDS) and a push whose context passes (MUTE_ALL_PASS, or a safety alert key of
 *   SAFETY_ALERT_PUSH_BODY, owner #168-18). It never stops an in-app row.
 * - Quiet hours (21:00 to 08:00 in the recipient's zone, OR-113-5): a push waits to 08:00 unless it is urgent
 *   (quietHoursFor in push-quiet-hours.ts, or the nudge QuietHoursPolicy for the senders that use it).
 * - Thread and space mute: a muted or left thread or space hears nothing from there.
 * - Block and ban: nothing crosses a block either way between the person who acted and the recipient, and a
 *   banned member causes no push.
 * - Recipient: who may get it.
 */

/** What a sender does with one rule. `n/a`: the rule has nothing to act on for this sender. */
export type Does = 'stops' | 'passes' | 'held' | 'n/a';
export interface Rule {
  does: Does;
  why: string;
  /** Set when today's code misses this rule: the KNOWN_GAPS row. */
  gap?: KnownGapId;
}

/** A push the sender queues through NotificationsService.sendPush; the funnel table in the spec sends it. */
export interface FunnelPush {
  kind: NotificationKindValue;
  context?: (PushContext & MuteAllPass) | null;
  urgent?: boolean;
  /** Mute all on: `stops` (nothing queued) or `passes` (queued). */
  muteAll: 'stops' | 'passes';
  /** Inside quiet hours: `held` (waits to 08:00 local) or `passes` (due now). */
  quietHours: 'held' | 'passes';
  note: string;
}

/** The senders the spec runs through their real code (see DRIVERS in the spec). */
export type DriverName = 'broadcast' | 'churnIntervention' | 'scoutImport' | 'communityPush' | 'spacePush' | 'dunningClientPush';

export interface SenderRow {
  file: string;
  fn: string;
  /** The kinds of send site the scan finds in this function (each must be found at least once). */
  via: SendVia[];
  kinds: string[];
  /** What reaches the person: `push` (device push), `inapp` (inbox row), `push row` (inbox row on the push channel). */
  sends: string;
  muteAll: Rule;
  quietHours: Rule;
  mute: Rule;
  blockBan: Rule;
  recipient: string;
  /** Pushes queued through sendPush, sent by the spec's funnel table. */
  funnel?: FunnelPush[];
  /** A driver in the spec that runs this sender's real code. */
  driver?: DriverName;
  /** Where else the behavior is driven (an existing spec), or why it is not driven here. */
  covered: string;
}

/** The funnel itself: the only places allowed to touch the push transport or write a Notification row raw. */
export interface FunnelSite {
  file: string;
  fn: string;
  via: SendVia;
  what: string;
}

export type KnownGapId =
  | 'KG-AI-SEND-PUSH'
  | 'KG-QH-CHURN'
  | 'KG-QH-SCOUT'
  | 'KG-QH-COMMUNITY'
  | 'KG-QH-DUNNING-CLIENT'
  | 'KG-QH-PAYOUT'
  | 'KG-QH-TRIAL'
  | 'KG-QH-WORKOUT-REMINDER'
  | 'KG-HELD-BLOCK-MESSAGE';

/** An outcome the spec measures: a push sent now, a push held to 08:00 local, or nothing. */
export type Outcome = 'sent' | 'held' | 'none';

export interface KnownGap {
  where: string;
  rule: string;
  why: string;
  audit: string;
  /** What today's code does in the spec's case for that rule (a driven gap); undefined when not driven. */
  today?: Outcome;
}

/** This PR; the AUDIT link for the gaps this registry found. */
export const THIS_PR = 'https://github.com/BradleyGleavePortfolio/growth-project-backend/pull/1186';
const QH_DIRECT =
  'NotificationsService.pushToUser goes straight to Expo, not through the outbox, so quietHoursFor never runs; the funnel would hold this push to 08:00';

export const KNOWN_GAPS: Record<KnownGapId, KnownGap> = {
  'KG-AI-SEND-PUSH': {
    where: 'src/ai/gateway/materialisers/send-notification.materialiser.ts:SendNotificationMaterializer.materialize',
    rule: 'delivery funnel: a push-channel notice queues no device push',
    why: 'an approved AI draft send_notification on the push channel writes the Notification row with Prisma and never calls sendPush (LO-1180R4B C)',
    audit:
      'failing test on btest/LO-1180R4B-ai-send-notification-push @ 3cd02633, run https://github.com/BradleyGleavePortfolio/growth-project-backend/actions/runs/40929701633',
  },
  'KG-QH-CHURN': {
    where: 'src/coach/command-center/churn-intervention.service.ts:ChurnInterventionService.sendIntervention',
    rule: 'quiet hours',
    why: `the coach's check-in message pushes the client at 23:30 their time; ${QH_DIRECT}`,
    audit: THIS_PR,
    today: 'sent',
  },
  'KG-QH-SCOUT': {
    where: 'src/scout/scout.service.ts:ScoutService.notifyComplete',
    rule: 'quiet hours',
    why: `the import-finished push reaches the coach at 23:30 their time; ${QH_DIRECT}`,
    audit: THIS_PR,
    today: 'sent',
  },
  'KG-QH-COMMUNITY': {
    where: 'src/community/notifications/community-notifications.service.ts:CommunityNotificationsService.sendCommunityPush',
    rule: 'quiet hours',
    why: `a community DM, reply, event, challenge, moderation or cohort push (FEATURE_COMMUNITY_PUSH) goes out at 23:30; ${QH_DIRECT}`,
    audit: THIS_PR,
    today: 'sent',
  },
  'KG-QH-DUNNING-CLIENT': {
    where: 'src/checkout/dunning-v2/dunning-v2.dispatcher.ts:DunningV2Dispatcher.sendClientPush',
    rule: 'quiet hours',
    why: `the client's failed-payment push goes out when the webhook or sweep runs, at any local hour; ${QH_DIRECT}`,
    audit: THIS_PR,
    today: 'sent',
  },
  'KG-QH-PAYOUT': {
    where: 'src/checkout/payout-notice.service.ts:PayoutNoticeService.deliverPush',
    rule: 'quiet hours',
    why: `the coach's payout notice push goes out when the refund or dispute lands, at any local hour; ${QH_DIRECT}`,
    audit: THIS_PR,
  },
  'KG-QH-TRIAL': {
    where: 'src/packages/trials/trial-notice.service.ts:TrialNoticeService.deliverPush',
    rule: 'quiet hours',
    why: `the trial-ending push goes out on the 10-minute UTC sweep, at any local hour; ${QH_DIRECT}`,
    audit: THIS_PR,
  },
  'KG-QH-WORKOUT-REMINDER': {
    where: 'src/engagement/workout-reminder.service.ts:WorkoutReminderService.processClient',
    rule: 'quiet hours',
    why: `the "morning" slot opens at 07:00 local (REMINDER_SLOT_MINUTES), inside quiet hours; ${QH_DIRECT}`,
    audit: THIS_PR,
  },
  'KG-HELD-BLOCK-MESSAGE': {
    where: 'src/messaging/messaging.service.ts:MessagingService.notifyNewMessage',
    rule: 'block and ban',
    why: 'a coach and client message push held to 08:00 is sent even if one side blocked the other while it waited: at send time the push outbox (push-delivery.service.ts) plans again only space pushes (spacePushDropReason), so the block is never read (owner 10-22: a block hides all messaging)',
    audit: THIS_PR,
  },
};

const SAFETY_KEY = Object.keys(SAFETY_ALERT_PUSH_BODY)[0];

// Rules that repeat. Plain words; the row's own text says anything particular to it.
const MUTE_CORE: Rule = { does: 'stops', why: 'the funnel stops the push at enqueue and again at send time (pushAllowedByPreferences); the inbox row stays (owner #171-3)' };
const MUTE_MONEY: Rule = { does: 'passes', why: 'money kind (MONEY_NOTIFICATION_KINDS, owner #171-3)' };
const MUTE_ROW: Rule = { does: 'n/a', why: 'in-app row only; Mute all never stops a row (owner #171-3)' };
const MUTE_NO_PUSH: Rule = { does: 'n/a', why: 'a row on the push channel shows in the inbox; no device push is sent, and Mute all never stops a row (owner #171-3)' };
const QH_CORE: Rule = { does: 'held', why: 'held to 08:00 in the recipient zone (quietHoursFor)' };
const QH_ROW: Rule = { does: 'n/a', why: 'an inbox row makes no sound' };
const NO_MUTE: Rule = { does: 'n/a', why: 'not sent from a thread or a space' };
const NO_ACTOR: Rule = { does: 'n/a', why: 'no person acted on the recipient (a system or money event)' };
const OWN_COACH: Rule = { does: 'n/a', why: 'coach and own client on a paid relationship; a block hides messaging only (owner 10-22), and this is not a message' };

const ROW_NOT_DRIVEN = 'in-app row only: the spec writes every kind through createNotification with Mute all on (row kept)';

export const FUNNEL_SITES: FunnelSite[] = [
  { file: 'src/notifications/notifications.service.ts', fn: '<module>', via: 'transport', what: 'imports the Expo SDK for pushToUser, pushToCoach and receipts' },
  { file: 'src/notifications/notifications.service.ts', fn: 'NotificationsService.createNotification', via: 'notificationRow', what: 'the in-app gate: <prefix>_<channel> switches, the push-channel throttle, the push twin' },
  { file: 'src/notifications/notifications.service.ts', fn: 'NotificationsService.sendPush', via: 'transport', what: 'the funnel push: pushAllowedByPreferences, lock-screen copy, the zone, then PushDeliveryService.enqueue' },
  { file: 'src/notifications/notifications.service.ts', fn: 'NotificationsService.pushToUser', via: 'transport', what: 'direct Expo push; reads no preference and no quiet hours (each caller is a row below)' },
  { file: 'src/notifications/notifications.service.ts', fn: 'NotificationsService.pushToCoach', via: 'transport', what: 'direct Expo push; no caller on main' },
  { file: 'src/notifications/notifications.service.ts', fn: 'NotificationsService.pollReceipts', via: 'transport', what: 'reads Expo receipts for direct pushes; sends nothing' },
  { file: 'src/notifications/push/expo-push-client.ts', fn: '<module>', via: 'transport', what: 'the outbox worker transport (Expo SDK)' },
  { file: 'src/notifications/push/push-delivery.service.ts', fn: '<module>', via: 'transport', what: 'the outbox worker (types from the Expo SDK)' },
  { file: 'src/notifications/push/push-delivery.service.ts', fn: 'PushDeliveryService.enqueue', via: 'transport', what: 'writes the PushOutbox row: quietHoursFor sets not_before; the send step checks Mute all again' },
];

const BOOKING_KINDS = [
  'booking_requested', 'booking_confirmed', 'booking_declined', 'booking_cancelled', 'booking_rescheduled',
  'booking_reminder_24h', 'booking_reminder_1h', 'booking_link_needed', 'booking_link_ready', 'booking_request_expired',
];
const BOOKING_LATER = { scheduledAt: '2026-06-06T19:00:00.000Z', timeZone: 'America/New_York' };
const BOOKING_FUNNEL: FunnelPush[] = [
  { kind: NotificationKind.BOOKING_CONFIRMED, context: BOOKING_LATER, muteAll: 'stops', quietHours: 'held', note: 'a session days away waits to 08:00' },
  { kind: NotificationKind.BOOKING_REMINDER_1H, context: BOOKING_LATER, muteAll: 'stops', quietHours: 'passes', note: 'the 1 h reminder is urgent by kind' },
];
const bookingRow = (file: string, fn: string, recipient: string): SenderRow => ({
  file,
  fn,
  via: ['emitter'],
  kinds: BOOKING_KINDS,
  sends: 'inapp + push (BookingEmitter)',
  muteAll: MUTE_CORE,
  quietHours: { does: 'held', why: 'held to 08:00, except booking_reminder_1h and a booking whose session starts before 08:00 + 2 h (quietHoursFor)' },
  mute: NO_MUTE,
  blockBan: OWN_COACH,
  recipient,
  funnel: BOOKING_FUNNEL,
  covered: 'funnel table here; test/booking-emitter.spec.ts and test/scheduling-lifecycle-integrity.spec.ts drive the emitter',
});

const COMMUNITY_VIA_RELAY = (fn: string, file: string, kind: string, recipient: string, blockBan: Rule): SenderRow => ({
  file,
  fn,
  via: ['communityPush'],
  kinds: [kind],
  sends: 'push row + push (sendCommunityPush, FEATURE_COMMUNITY_PUSH)',
  muteAll: { does: 'stops', why: 'sendCommunityPush reads channelGate and skips the push when muted; the row stays' },
  quietHours: { does: 'held', why: 'the rule: held to 08:00', gap: 'KG-QH-COMMUNITY' },
  mute: NO_MUTE,
  blockBan,
  recipient,
  driver: 'communityPush',
  covered: 'communityPush driver here (the shared sendCommunityPush); test/community/notifications/community-push-mute.spec.ts',
});

export const SENDERS: SenderRow[] = [
  // ── AI drafts (approved by the coach) ─────────────────────────────────────────────────────────
  {
    file: 'src/ai/gateway/materialisers/assign-meal-plan.materialiser.ts',
    fn: 'AssignMealPlanMaterializer.materialize',
    via: ['createNotification'],
    kinds: ['meal_plan_assigned'],
    sends: 'push row (no device push)',
    muteAll: MUTE_NO_PUSH,
    quietHours: QH_ROW,
    mute: NO_MUTE,
    blockBan: OWN_COACH,
    recipient: 'the client on the coach roster the approved draft names',
    covered: ROW_NOT_DRIVEN,
  },
  {
    file: 'src/ai/gateway/materialisers/assign-workout.materialiser.ts',
    fn: 'AssignWorkoutMaterializer.materialize',
    via: ['createNotification'],
    kinds: ['workout_assigned'],
    sends: 'push row (no device push; workout_reminder_push gates the row)',
    muteAll: MUTE_NO_PUSH,
    quietHours: QH_ROW,
    mute: NO_MUTE,
    blockBan: OWN_COACH,
    recipient: 'the client on the coach roster the approved draft names',
    covered: ROW_NOT_DRIVEN,
  },
  {
    file: 'src/ai/gateway/materialisers/send-notification.materialiser.ts',
    fn: 'SendNotificationMaterializer.materialize',
    via: ['notificationRow'],
    kinds: ['free text from the draft (for example coach_nudge)'],
    sends: 'push row (channel push unless the draft says inapp); no device push',
    muteAll: { does: 'n/a', why: 'no gate runs; Mute all never stops a row (owner #171-3)', gap: 'KG-AI-SEND-PUSH' },
    quietHours: { does: 'n/a', why: 'no device push is queued', gap: 'KG-AI-SEND-PUSH' },
    mute: NO_MUTE,
    blockBan: OWN_COACH,
    recipient: 'a client on the coach roster',
    covered: 'not driven here: LO-1180R4B C (btest/LO-1180R4B-ai-send-notification-push) holds the failing test',
  },
  // ── Billing, checkout and money ───────────────────────────────────────────────────────────────
  ...['BillingService.applyTransferFailed', 'BillingService.applyPayoutFailed'].map(
    (fn): SenderRow => ({
      file: 'src/billing/billing.service.ts',
      fn,
      via: ['createNotification'],
      kinds: ['coach_alert'],
      sends: 'inapp',
      muteAll: MUTE_ROW,
      quietHours: QH_ROW,
      mute: NO_MUTE,
      blockBan: NO_ACTOR,
      recipient: 'the coach whose Stripe transfer or payout failed',
      covered: ROW_NOT_DRIVEN,
    }),
  ),
  {
    file: 'src/checkout/dunning-v2/dunning-v2.dispatcher.ts',
    fn: 'DunningV2Dispatcher.notifyCoachAllChannels',
    via: ['emitter'],
    kinds: ['coach_alert'],
    sends: 'inapp + push (CoachAlertEmitter, MUTE_ALL_PASS)',
    muteAll: { does: 'passes', why: 'the Day 7 payment alert carries MUTE_ALL_PASS (README note 1)' },
    quietHours: QH_CORE,
    mute: NO_MUTE,
    blockBan: NO_ACTOR,
    recipient: "the coach of the client whose payment failed (Day 7)",
    funnel: [{ kind: NotificationKind.COACH_ALERT, context: MUTE_ALL_PASS, muteAll: 'passes', quietHours: 'held', note: 'coach_alert with MUTE_ALL_PASS' }],
    covered: 'funnel table here; test/dunning-kind-fix-notification-kinds.spec.ts (Day 7 coach alert with Mute all on)',
  },
  {
    file: 'src/checkout/dunning-v2/dunning-v2.dispatcher.ts',
    fn: 'DunningV2Dispatcher.sendBlocker',
    via: ['createNotification'],
    kinds: ['dunning_blocker'],
    sends: 'inapp',
    muteAll: MUTE_ROW,
    quietHours: QH_ROW,
    mute: NO_MUTE,
    blockBan: NO_ACTOR,
    recipient: 'the client whose payment failed',
    covered: ROW_NOT_DRIVEN,
  },
  {
    file: 'src/checkout/dunning-v2/dunning-v2.dispatcher.ts',
    fn: 'DunningV2Dispatcher.sendClientPush',
    via: ['pushToUser'],
    kinds: ['dunning_payment', 'dunning_dispute (pushToUser data kinds)'],
    sends: 'push (pushToUser)',
    muteAll: { does: 'passes', why: 'money notice; pushToUser reads no preference (owner #171-3)' },
    quietHours: { does: 'held', why: 'the rule: held to 08:00', gap: 'KG-QH-DUNNING-CLIENT' },
    mute: NO_MUTE,
    blockBan: NO_ACTOR,
    recipient: 'the client whose payment failed',
    driver: 'dunningClientPush',
    covered: 'dunningClientPush driver here; test/dunning-kind-fix-notification-kinds.spec.ts (Mute all on)',
  },
  {
    file: 'src/checkout/payout-notice.service.ts',
    fn: 'PayoutNoticeService.deliverInApp',
    via: ['createNotification'],
    kinds: ['coach_alert'],
    sends: 'inapp',
    muteAll: MUTE_ROW,
    quietHours: QH_ROW,
    mute: NO_MUTE,
    blockBan: NO_ACTOR,
    recipient: 'the coach a refund or dispute takes money from',
    covered: ROW_NOT_DRIVEN,
  },
  {
    file: 'src/checkout/payout-notice.service.ts',
    fn: 'PayoutNoticeService.deliverPush',
    via: ['createNotification', 'pushToUser'],
    kinds: ['coach_alert'],
    sends: 'push twin row + push (pushToUser)',
    muteAll: { does: 'passes', why: 'channelGate with MUTE_ALL_PASS (README note 1)' },
    quietHours: { does: 'held', why: 'the rule: held to 08:00', gap: 'KG-QH-PAYOUT' },
    mute: NO_MUTE,
    blockBan: NO_ACTOR,
    recipient: 'the coach a refund or dispute takes money from',
    covered: 'not driven here (settlement world); test/dunning-kind-fix-notification-kinds.spec.ts drives it with Mute all on',
  },
  {
    file: 'src/checkout/plan-renewal/plan-renewal.service.ts',
    fn: 'PlanRenewalService.advance',
    via: ['sendPush'],
    kinds: ['plan_renewal'],
    sends: 'push (no inbox row)',
    muteAll: MUTE_MONEY,
    quietHours: QH_CORE,
    mute: NO_MUTE,
    blockBan: NO_ACTOR,
    recipient: 'the client whose plan renews (STORE-B2 changes this row; this is main today)',
    funnel: [{ kind: NotificationKind.PLAN_RENEWAL, muteAll: 'passes', quietHours: 'held', note: 'money kind' }],
    covered: 'funnel table here; test/plan-renewal.spec.ts',
  },
  {
    file: 'src/checkout/plan-renewal/switch-tell.ts',
    fn: 'tellFormerCoachTx',
    via: ['notificationRow'],
    kinds: ['coach_client_moved'],
    sends: 'inapp (Prisma row, no push)',
    muteAll: { does: 'n/a', why: 'in-app row only; Mute all never stops a row (owner #171-3; b#1132 Sol B1 made it stop reading muted)' },
    quietHours: QH_ROW,
    mute: NO_MUTE,
    blockBan: { does: 'n/a', why: 'tells the coach a client left; the client acted on their own plan' },
    recipient: "the coach the client left for TGP's house coach",
    covered: 'test/switch-tell.spec.ts',
  },
  ...(
    [
      ['RefundDisputeHandlerService.emitRefundCoachAlert', 'coach_alert', 'the coach whose client was refunded'],
      ['RefundDisputeHandlerService.revokeFullyRefunded', 'dunning_blocker', 'the client whose purchase was fully refunded'],
      ['RefundDisputeHandlerService.upsertDispute', 'coach_alert', 'the coach whose client opened a dispute'],
    ] as const
  ).map(
    ([fn, kind, recipient]): SenderRow => ({
      file: 'src/checkout/refund-dispute-handler.service.ts',
      fn,
      via: ['createNotification'],
      kinds: [kind],
      sends: 'inapp',
      muteAll: MUTE_ROW,
      quietHours: QH_ROW,
      mute: NO_MUTE,
      blockBan: NO_ACTOR,
      recipient,
      covered: ROW_NOT_DRIVEN,
    }),
  ),
  ...(['GuestCheckoutService.handleChargeRefunded', 'GuestCheckoutService.handleDisputeOpened', 'GuestCheckoutService.holdForRefund'] as const).map(
    (fn): SenderRow => ({
      file: 'src/storefront/guest-checkout.service.ts',
      fn,
      via: ['createNotification'],
      kinds: ['coach_alert'],
      sends: 'inapp',
      muteAll: MUTE_ROW,
      quietHours: QH_ROW,
      mute: NO_MUTE,
      blockBan: NO_ACTOR,
      recipient: 'the coach who sold the guest checkout',
      covered: ROW_NOT_DRIVEN,
    }),
  ),
  // ── Broadcasts and messaging ──────────────────────────────────────────────────────────────────
  {
    file: 'src/broadcasts/broadcast-dispatcher.service.ts',
    fn: 'BroadcastDispatcherService.deliverOne',
    via: ['emitter'],
    kinds: ['message_received'],
    sends: 'inapp + push (MessageReceivedEmitter)',
    muteAll: MUTE_CORE,
    quietHours: { does: 'held', why: 'deliverOne defers the whole copy (message, row, push) to 08:00 in the client zone (nudge QuietHoursPolicy) unless the run is urgent' },
    mute: { does: 'stops', why: 'a client who muted the coach thread (BroadcastThreadMuteProbe) gets the message, no row and no push' },
    blockBan: { does: 'stops', why: "a block either way between the client and the author or the coach settles 'skipped_blocked': no message, no row, no push" },
    recipient: "a client in the broadcast's segment of that coach",
    funnel: [{ kind: NotificationKind.MESSAGE_RECEIVED, muteAll: 'stops', quietHours: 'held', note: 'not urgent' }],
    driver: 'broadcast',
    covered: 'broadcast driver here; test/broadcasts/dispatcher-delivery.spec.ts, test/mute-all-ordinary-senders.spec.ts',
  },
  {
    file: 'src/messaging/messaging.service.ts',
    fn: 'MessagingService.notifyNewMessage',
    via: ['emitter'],
    kinds: ['message_received'],
    sends: 'inapp + push (MessageReceivedEmitter)',
    muteAll: MUTE_CORE,
    quietHours: QH_CORE,
    mute: { does: 'stops', why: 'with messaging core v2 on, a recipient who muted the thread is told nothing (isThreadMutedFor)' },
    blockBan: {
      does: 'stops',
      why: 'the send path refuses a blocked pair either way (isEitherSideBlocked) before the message and the notice; a push held for quiet hours is not checked again',
      gap: 'KG-HELD-BLOCK-MESSAGE',
    },
    recipient: "the other side of the coach and client thread (a client's reply tells their assigned coach)",
    funnel: [{ kind: NotificationKind.MESSAGE_RECEIVED, muteAll: 'stops', quietHours: 'held', note: 'not urgent' }],
    covered: 'funnel table here; test/messaging/messaging-core-v2.spec.ts drives the thread mute',
  },
  // ── Coach tools ───────────────────────────────────────────────────────────────────────────────
  {
    file: 'src/coach/brief/coach-brief.scheduler.ts',
    fn: 'CoachBriefScheduler.maybeDispatch',
    via: ['pushToUser'],
    kinds: ['coach brief (pushToUser data has no kind)'],
    sends: 'push (pushToUser)',
    muteAll: { does: 'stops', why: 'reads muted itself and sends nothing' },
    quietHours: { does: 'held', why: 'the nudge QuietHoursPolicy: a brief due in quiet hours waits to 08:00' },
    mute: NO_MUTE,
    blockBan: { does: 'n/a', why: 'the coach is told about their own day' },
    recipient: 'the coach, once a day',
    covered: 'test/coach-brief.service.spec.ts',
  },
  {
    file: 'src/coach/coach-alerts.service.ts',
    fn: 'CoachAlertsService.tryPush',
    via: ['emitter'],
    kinds: ['coach_alert'],
    sends: 'push (CoachAlertEmitter)',
    muteAll: { does: 'passes', why: 'a safety alert (context.safetyAlert, owner #168-18); any other coach alert is muted' },
    quietHours: { does: 'passes', why: "urgent when the alert's severity is critical; a warning waits to 08:00" },
    mute: NO_MUTE,
    blockBan: { does: 'n/a', why: 'a safety alert about a client must reach their coach' },
    recipient: "the client's coach",
    funnel: [
      { kind: NotificationKind.COACH_ALERT, context: { safetyAlert: SAFETY_KEY }, urgent: true, muteAll: 'passes', quietHours: 'passes', note: 'critical safety alert' },
      { kind: NotificationKind.COACH_ALERT, context: { safetyAlert: SAFETY_KEY }, muteAll: 'passes', quietHours: 'held', note: 'warning safety alert' },
      { kind: NotificationKind.COACH_ALERT, muteAll: 'stops', quietHours: 'held', note: 'any other coach alert' },
    ],
    covered: 'funnel table here; test/dunning-kind-fix-notification-kinds.spec.ts (every safety key with Mute all on)',
  },
  {
    file: 'src/coach/command-center/churn-intervention.service.ts',
    fn: 'ChurnInterventionService.sendIntervention',
    via: ['notificationRow', 'pushToUser'],
    kinds: ['coach_nudge'],
    sends: 'coach nudge + its inbox row written in the send transaction (full text, b#1171) + push (pushToUser, lock screen reads as a new message)',
    muteAll: { does: 'stops', why: 'muteAllStopsNudgePush reads muted; the nudge and its inbox row stay (owner #171-3)' },
    quietHours: { does: 'held', why: 'the rule: held to 08:00', gap: 'KG-QH-CHURN' },
    mute: NO_MUTE,
    blockBan: {
      does: 'stops',
      why: 'assertPairOpen: a block either way is 403 before the nudge, the row and the push (FX-1141); a later block hides the row (inbox-block-rule.ts)',
    },
    recipient: "the coach's own client the intervention names",
    driver: 'churnIntervention',
    covered: 'churnIntervention driver here; test/mute-all-ordinary-senders.spec.ts',
  },
  {
    file: 'src/scout/scout.service.ts',
    fn: 'ScoutService.notifyComplete',
    via: ['pushToUser'],
    kinds: ['import.complete (pushToUser data kind)'],
    sends: 'push (pushToUser)',
    muteAll: { does: 'stops', why: "muteAllStops(prefs, 'import.complete', 'push')" },
    quietHours: { does: 'held', why: 'the rule: held to 08:00', gap: 'KG-QH-SCOUT' },
    mute: NO_MUTE,
    blockBan: { does: 'n/a', why: "the coach is told about their own import" },
    recipient: 'the coach who ran the import',
    driver: 'scoutImport',
    covered: 'scoutImport driver here; test/mute-all-ordinary-senders.spec.ts',
  },
  // ── Community ─────────────────────────────────────────────────────────────────────────────────
  COMMUNITY_VIA_RELAY('CommunityChallengesService.updateProgress', 'src/community/challenges/community-challenges.service.ts', 'community_challenge_milestone', 'the participant who reached the milestone', { does: 'n/a', why: "the participant's own progress" }),
  COMMUNITY_VIA_RELAY('CommunityDmsService.send', 'src/community/dms/community-dms.service.ts', 'community_dm_received', 'the DM recipient', { does: 'stops', why: 'assertDmReadable refuses a blocked pair or a member who may not read the DM before the message is written' }),
  COMMUNITY_VIA_RELAY('CommunityEventsService.pushStartingSoon', 'src/community/events/community-events.service.ts', 'community_event_starting_soon', "each member who RSVP'd", { does: 'stops', why: "hiddenFromViewer(event creator) skips anyone in a block with the event's creator" }),
  COMMUNITY_VIA_RELAY('CommunityMessagesService.pushCohortMessage', 'src/community/messages/community-messages.service.ts', 'community_message_received', 'each other active, unbanned member of the cohort (only while the space push is off)', { does: 'stops', why: "hiddenFromViewer(sender) skips both sides of a block; listCohortPushRecipients leaves out banned members; notify level 'quiet' is skipped" }),
  COMMUNITY_VIA_RELAY('CommunityModerationService.act', 'src/community/moderation/community-moderation.service.ts', 'community_moderation_action_against_me', 'the member a moderator acted on', { does: 'n/a', why: 'the member must hear what a moderator did to them' }),
  COMMUNITY_VIA_RELAY('CommunityPostsService.addComment', 'src/community/posts/community-posts.service.ts', 'community_post_replied', 'the post author, when they may still read the space (readersOf)', { does: 'stops', why: 'visiblePost 404s a commenter in a block with the author before the comment is written' }),
  {
    file: 'src/community/notifications/community-notifications.service.ts',
    fn: 'CommunityNotificationsService.sendCommunityPush',
    via: ['createNotification', 'pushToUser'],
    kinds: ['community_dm_received', 'community_post_replied', 'community_event_starting_soon', 'community_challenge_milestone', 'community_moderation_action_against_me', 'community_message_received'],
    sends: 'push row + push (pushToUser), behind FEATURE_COMMUNITY_PUSH',
    muteAll: { does: 'stops', why: "channelGate(recipient, kind, 'push') === 'muted' skips the push; the row stays" },
    quietHours: { does: 'held', why: 'the rule: held to 08:00', gap: 'KG-QH-COMMUNITY' },
    mute: { does: 'n/a', why: 'the callers pick recipients (the cohort caller skips notify level quiet)' },
    blockBan: { does: 'n/a', why: 'the callers check blocks and bans (rows above)' },
    recipient: 'the recipient its caller names',
    driver: 'communityPush',
    covered: 'communityPush driver here; test/community/notifications/community-push-mute.spec.ts',
  },
  {
    file: 'src/community/safety/community-moderation-notices.ts',
    fn: 'writeNotice',
    via: ['notificationRow'],
    kinds: ['community_moderation_notice'],
    sends: 'inapp (Prisma row, no push)',
    muteAll: MUTE_ROW,
    quietHours: QH_ROW,
    mute: NO_MUTE,
    blockBan: { does: 'n/a', why: 'the member must hear what a moderator did to them' },
    recipient: 'the member a moderator hid, warned or banned',
    covered: ROW_NOT_DRIVEN,
  },
  {
    file: 'src/community/space-push/community-space-push.service.ts',
    fn: 'CommunitySpacePushService.messageStored',
    via: ['sendPush'],
    kinds: ['community_message_received'],
    sends: 'push (no inbox row), behind FEATURE_COMMUNITY_SPACE_PUSH',
    muteAll: MUTE_CORE,
    quietHours: { does: 'held', why: 'held to 08:00, a High alert too (not urgent)' },
    mute: { does: 'stops', why: 'a left space, a space set to off, and a muted or left thread hear nothing (a muted thread still hears a High alert); planned again at send time' },
    blockBan: { does: 'stops', why: 'a block either way with the sender, and a banned sender or reader, stop it at enqueue and again at send time (space-push-still-due.ts)' },
    recipient: 'everyone who may read the space now, minus the sender',
    funnel: [{ kind: NotificationKind.COMMUNITY_MESSAGE_RECEIVED, muteAll: 'stops', quietHours: 'held', note: 'space chat push' }],
    driver: 'spacePush',
    covered: 'spacePush driver here (send-time rules); test/community/notifications/space-push*.spec.ts (planning)',
  },
  // ── Engagement, nudges, digests ───────────────────────────────────────────────────────────────
  {
    file: 'src/engagement/workout-reminder.service.ts',
    fn: 'WorkoutReminderService.processClient',
    via: ['createNotification', 'pushToUser'],
    kinds: ['workout_reminder'],
    sends: 'inapp + push (pushToUser)',
    muteAll: { does: 'stops', why: 'pushAllowedByPreferences before pushToUser; the row stays' },
    quietHours: { does: 'held', why: 'the rule: held to 08:00', gap: 'KG-QH-WORKOUT-REMINDER' },
    mute: NO_MUTE,
    blockBan: { does: 'n/a', why: "the client's own plan" },
    recipient: 'a client who finished onboarding, on a plan day, inside their slot window',
    covered: 'not driven here (plan-day world); test/engagement/workout-reminder.service.spec.ts drives Mute all',
  },
  {
    file: 'src/notifications/digest.service.ts',
    fn: 'DigestService._sendCoachDigest',
    via: ['createNotification'],
    kinds: ['coach_digest'],
    sends: 'email-channel inbox row after the email',
    muteAll: { does: 'n/a', why: 'the digest email reads digest_email; the row is a record' },
    quietHours: QH_ROW,
    mute: NO_MUTE,
    blockBan: NO_ACTOR,
    recipient: 'the coach',
    covered: ROW_NOT_DRIVEN,
  },
  {
    file: 'src/notifications/nudges/nudge-engine.service.ts',
    fn: 'NudgeEngineService.deliver',
    via: ['createNotification', 'pushToUser'],
    kinds: ['nudge_missed_checkin', 'nudge_streak_broken', 'nudge_onboarding_abandoned', 'nudge_inactive'],
    sends: 'inapp + push (pushToUser) + email',
    muteAll: { does: 'stops', why: 'muteAllStops before the push and the email; the row stays' },
    quietHours: { does: 'held', why: 'QuietHoursPolicy defers the nudge (deferred_until the morning)' },
    mute: NO_MUTE,
    blockBan: { does: 'n/a', why: "the user's own activity" },
    recipient: 'the user a detector picks (README note 3)',
    covered: 'test/nudge-v1-engine.spec.ts',
  },
  {
    file: 'src/notifications/coach-first-payment.service.ts',
    fn: 'CoachFirstPaymentService.claimAndNotify',
    via: ['emitter'],
    kinds: ['first_payment'],
    sends: 'inapp + hidden push twin row + a device push through sendPush (FirstPaymentEmitter, b#1169)',
    muteAll: MUTE_MONEY,
    quietHours: QH_CORE,
    mute: NO_MUTE,
    blockBan: NO_ACTOR,
    recipient: "the coach, once, on their first client's first payment (the CoachFirstPaymentNotification ledger)",
    funnel: [{ kind: NotificationKind.FIRST_PAYMENT, muteAll: 'passes', quietHours: 'held', note: 'money kind' }],
    covered: 'funnel table here; test/first-payment-push.spec.ts, test/first-payment-notice-savepoint.spec.ts',
  },
  // ── Emitters (the shared writers; the rows above name their callers) ──────────────────────────
  {
    file: 'src/notifications/emitters/booking.emitter.ts',
    fn: 'BookingEmitter.deliver',
    via: ['createNotification', 'sendPush'],
    kinds: BOOKING_KINDS,
    sends: 'inapp + push',
    muteAll: MUTE_CORE,
    quietHours: { does: 'held', why: 'held to 08:00, except booking_reminder_1h and a session before 08:00 + 2 h' },
    mute: NO_MUTE,
    blockBan: OWN_COACH,
    recipient: 'the coach and the client of the session (its callers below)',
    funnel: BOOKING_FUNNEL,
    covered: 'funnel table here; test/booking-emitter.spec.ts',
  },
  ...(
    [
      ['build-week-day-unlocked', 'BuildWeekDayUnlockedEmitter.emit', NotificationKind.BUILD_WEEK_DAY_UNLOCKED],
      ['checkin-submitted', 'CheckinSubmittedEmitter.emit', NotificationKind.CHECKIN_SUBMITTED],
      ['milestone-reached', 'MilestoneReachedEmitter.emit', NotificationKind.MILESTONE_REACHED],
      ['missed-checkin', 'MissedCheckinEmitter.emit', NotificationKind.MISSED_CHECKIN],
      ['weight-trend-alert', 'WeightTrendAlertEmitter.emit', NotificationKind.WEIGHT_TREND_ALERT],
    ] as const
  ).map(
    ([name, fn, kind]): SenderRow => ({
      file: `src/notifications/emitters/${name}.emitter.ts`,
      fn,
      via: ['createNotification', 'sendPush'],
      kinds: [kind],
      sends: 'inapp + push',
      muteAll: MUTE_CORE,
      quietHours: QH_CORE,
      mute: NO_MUTE,
      blockBan: { does: 'n/a', why: 'no caller on main' },
      recipient: 'no caller on main (README)',
      funnel: [{ kind, muteAll: 'stops', quietHours: 'held', note: 'no caller on main' }],
      covered: 'funnel table here',
    }),
  ),
  {
    file: 'src/notifications/emitters/coach-alert.emitter.ts',
    fn: 'CoachAlertEmitter.emit',
    via: ['createNotification', 'sendPush'],
    kinds: ['coach_alert'],
    sends: 'inapp + push',
    muteAll: { does: 'stops', why: 'stops unless the context passes: a safety alert key or MUTE_ALL_PASS' },
    quietHours: { does: 'held', why: 'held to 08:00 unless the safety alert is critical (urgent)' },
    mute: NO_MUTE,
    blockBan: { does: 'n/a', why: 'its callers above' },
    recipient: 'the coach its caller names',
    funnel: [
      { kind: NotificationKind.COACH_ALERT, context: { safetyAlert: SAFETY_KEY }, urgent: true, muteAll: 'passes', quietHours: 'passes', note: 'critical safety alert' },
      { kind: NotificationKind.COACH_ALERT, context: MUTE_ALL_PASS, muteAll: 'passes', quietHours: 'held', note: 'MUTE_ALL_PASS' },
      { kind: NotificationKind.COACH_ALERT, muteAll: 'stops', quietHours: 'held', note: 'ordinary alert' },
    ],
    covered: 'funnel table here; test/dunning-kind-fix-notification-kinds.spec.ts',
  },
  {
    file: 'src/notifications/emitters/first-payment.emitter.ts',
    fn: 'FirstPaymentEmitter.emit',
    via: ['createNotification', 'sendPush'],
    kinds: ['first_payment'],
    sends: 'inapp + hidden push twin row + a device push (sendPush, one per coach by its dedupe key)',
    muteAll: MUTE_MONEY,
    quietHours: QH_CORE,
    mute: NO_MUTE,
    blockBan: NO_ACTOR,
    recipient: 'the coach',
    funnel: [{ kind: NotificationKind.FIRST_PAYMENT, muteAll: 'passes', quietHours: 'held', note: 'money kind' }],
    covered: 'funnel table here; test/first-payment-push.spec.ts, test/dunning-kind-fix-notification-kinds.spec.ts',
  },
  {
    file: 'src/notifications/emitters/message-received.emitter.ts',
    fn: 'MessageReceivedEmitter.emit',
    via: ['createNotification', 'sendPush'],
    kinds: ['message_received'],
    sends: 'inapp + push',
    muteAll: MUTE_CORE,
    quietHours: QH_CORE,
    mute: { does: 'n/a', why: 'its callers (MessagingService checks the thread mute)' },
    blockBan: { does: 'n/a', why: 'its callers (broadcast and messaging check blocks)' },
    recipient: 'the user its caller names',
    funnel: [{ kind: NotificationKind.MESSAGE_RECEIVED, muteAll: 'stops', quietHours: 'held', note: 'not urgent' }],
    covered: 'funnel table here; broadcast driver here',
  },
  // ── Onboarding safety alerts (owner #168-18) ──────────────────────────────────────────────────
  {
    file: 'src/onboarding/flagged-join-alert.ts',
    fn: 'alertCoachOfFlaggedJoinTx',
    via: ['notificationRow'],
    kinds: ['coach_alert'],
    sends: 'inapp (Prisma row, never a push)',
    muteAll: { does: 'passes', why: 'safety alert: in-app, never a push; Mute all never stops a row (owner #168-18, #171-3)' },
    quietHours: QH_ROW,
    mute: NO_MUTE,
    blockBan: { does: 'n/a', why: 'a safety alert about a client must reach their coach' },
    recipient: 'the coach of a client flagged at join',
    covered: ROW_NOT_DRIVEN,
  },
  {
    file: 'src/onboarding/onboarding.service.ts',
    fn: 'OnboardingService.completeOnce',
    via: ['notificationRow'],
    kinds: ['coach_alert'],
    sends: 'inapp (Prisma row, never a push)',
    muteAll: { does: 'passes', why: 'safety alert: in-app, never a push; Mute all never stops a row (owner #168-18, #171-3)' },
    quietHours: QH_ROW,
    mute: NO_MUTE,
    blockBan: { does: 'n/a', why: 'a safety alert about a client must reach their coach' },
    recipient: 'the coach of a client whose onboarding answers need extra care',
    covered: ROW_NOT_DRIVEN,
  },
  // ── Packages and trials ───────────────────────────────────────────────────────────────────────
  {
    file: 'src/packages/drip-dispatcher.cron.ts',
    fn: 'DripDispatcherCron.dispatchBuyerAlert',
    via: ['createNotification', 'sendPush'],
    kinds: ['drip_released'],
    sends: 'inapp + push + push twin row',
    muteAll: MUTE_CORE,
    quietHours: QH_CORE,
    mute: NO_MUTE,
    blockBan: NO_ACTOR,
    recipient: 'the buyer of the package',
    funnel: [{ kind: NotificationKind.DRIP_RELEASED, muteAll: 'stops', quietHours: 'held', note: 'not money' }],
    covered: 'funnel table here',
  },
  {
    file: 'src/packages/drip-dispatcher.cron.ts',
    fn: 'DripDispatcherCron.fireCoachAlert',
    via: ['createNotification'],
    kinds: ['coach_alert'],
    sends: 'inapp',
    muteAll: MUTE_ROW,
    quietHours: QH_ROW,
    mute: NO_MUTE,
    blockBan: NO_ACTOR,
    recipient: 'the coach who sold the package',
    covered: ROW_NOT_DRIVEN,
  },
  {
    file: 'src/packages/package-push.service.ts',
    fn: 'PackagePushService.dispatchInlineAlerts',
    via: ['createNotification', 'sendPush'],
    kinds: ['drip_released'],
    sends: 'inapp + push',
    muteAll: MUTE_CORE,
    quietHours: QH_CORE,
    mute: NO_MUTE,
    blockBan: NO_ACTOR,
    recipient: 'the buyer of the package',
    funnel: [{ kind: NotificationKind.DRIP_RELEASED, muteAll: 'stops', quietHours: 'held', note: 'not money' }],
    covered: 'funnel table here',
  },
  {
    file: 'src/packages/purchase-fanout.service.ts',
    fn: 'PurchaseFanoutService.flushCoachNewPurchaseAlert',
    via: ['createNotification', 'sendPush'],
    kinds: ['coach_new_purchase'],
    sends: 'inapp + push + push twin row',
    muteAll: MUTE_MONEY,
    quietHours: QH_CORE,
    mute: NO_MUTE,
    blockBan: NO_ACTOR,
    recipient: 'the coach who made the sale',
    funnel: [{ kind: NotificationKind.COACH_NEW_PURCHASE, muteAll: 'passes', quietHours: 'held', note: 'money kind' }],
    covered: 'funnel table here',
  },
  {
    file: 'src/packages/trials/trial-notice.service.ts',
    fn: 'TrialNoticeService.deliverPush',
    via: ['pushToUser'],
    kinds: ['trial_ending'],
    sends: 'push (pushToUser)',
    muteAll: { does: 'passes', why: 'money: pushAllowedByPreferences with MUTE_ALL_PASS' },
    quietHours: { does: 'held', why: 'the rule: held to 08:00', gap: 'KG-QH-TRIAL' },
    mute: NO_MUTE,
    blockBan: NO_ACTOR,
    recipient: 'the client whose trial ends',
    covered: 'not driven here (trial world); test/b-trials-3-fix-round.spec.ts drives it with Mute all on',
  },
  {
    file: 'src/packages/trials/trial-notice.service.ts',
    fn: 'TrialNoticeService.recordNotice',
    via: ['createNotification'],
    kinds: ['trial_ending'],
    sends: 'inapp',
    muteAll: MUTE_ROW,
    quietHours: QH_ROW,
    mute: NO_MUTE,
    blockBan: NO_ACTOR,
    recipient: 'the client whose trial ends',
    covered: ROW_NOT_DRIVEN,
  },
  // ── Scheduling (BookingEmitter callers) ───────────────────────────────────────────────────────
  bookingRow('src/scheduling/jobs/reminder.job.ts', 'SessionReminderJob.runOneHourReminderSweep', 'the coach and the client of a session in an hour'),
  bookingRow('src/scheduling/jobs/reminder.job.ts', 'SessionReminderJob.runTwentyFourHourReminderSweep', 'the coach and the client of a session tomorrow'),
  bookingRow('src/scheduling/jobs/request-expiry.job.ts', 'BookingRequestExpiryJob.deliver', 'the client whose request expired'),
  ...(
    [
      ['approveSession', 'the client whose request the coach approved'],
      ['attachManualVideoLink', 'the client of the session'],
      ['cancelSession', 'the other side of the session'],
      ['declineSession', 'the client whose request the coach declined'],
      ['promptForMissingLink', 'the coach of a session with no video link'],
      ['requestSession', 'the coach (a request) and the client (a coach booking)'],
      ['rescheduleSession', 'the other side of the session'],
    ] as const
  ).map(([fn, recipient]) =>
    bookingRow('src/scheduling/scheduling-session-lifecycle.service.ts', `SchedulingSessionLifecycleService.${fn}`, recipient),
  ),
  // ── Workout builder ───────────────────────────────────────────────────────────────────────────
  ...(
    [
      ['src/workout-builder/program-library.service.ts', 'ProgramLibraryService.pushProgramAssigned'],
      ['src/workout-builder/workout-builder.service.ts', 'WorkoutBuilderService.emitAssignmentPush'],
    ] as const
  ).map(
    ([file, fn]): SenderRow => ({
      file,
      fn,
      via: ['createNotification', 'sendPush'],
      kinds: ['workout_assigned'],
      sends: 'push row + push (workout_reminder_push gates both)',
      muteAll: MUTE_CORE,
      quietHours: QH_CORE,
      mute: NO_MUTE,
      blockBan: OWN_COACH,
      recipient: "the coach's own client the workout or program is assigned to",
      funnel: [{ kind: NotificationKind.WORKOUT_ASSIGNED, muteAll: 'stops', quietHours: 'held', note: 'not money' }],
      covered: 'funnel table here',
    }),
  ),
];
