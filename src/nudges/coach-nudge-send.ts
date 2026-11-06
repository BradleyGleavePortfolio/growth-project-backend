import { Logger } from '@nestjs/common';
import { CoachNudge, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { lockScreenCopy } from '../notifications/push/lock-screen-copy';
import { NotificationKind } from '../notifications/notification-kind';
import { muteAllStops } from '../notifications/push/push-preferences';
import { describeFailure } from '../observability/log-pii';

// NUDGE-REACH-BE: the one way a coach's nudge reaches the client. Both nudge
// senders call it: the churn send (POST /coach/churn-interventions/:id/send)
// and the coach's nudge (POST /coach/clients/:id/nudges). Before this, only
// the churn send reached the client; the coach's nudge saved a CoachNudge row
// that only the old Notifications screen read, and nothing opens that screen.

// The nudge's kind: the client's inbox row (Notification), its push data type
// and its Mute all rule. The same kind the approved-AI-draft path writes
// (send-notification materialiser), so the phone's inbox shows it as a plain
// row, and inbox-block-rule.ts hides it while the two are in a block.
export const COACH_NUDGE_KIND = 'coach_nudge';
// B-LSNOTIFY-2: where a nudge push opens. The phone routes actionScreen
// 'NotificationCenter' to the client's Home > NotificationCenter (mobile
// 1dd970e7 src/services/pushTapRouter.ts:95, decoder pushNotifications.ts:167-179),
// the screen the Home bell opens, which reads GET /notifications rows.
export const COACH_NUDGE_TAP_SCREEN = 'NotificationCenter';

export interface CoachNudgeToSend {
  coachId: string;
  clientId: string;
  /** CoachNudge.title and the inbox row's payload.title (the row's title on the phone). */
  title: string;
  /** The coach's full text: CoachNudge.body and the inbox row's body. */
  body: string;
  /** Set when the caller must know the id before the write (the churn claim stores it). */
  nudgeId?: string;
}

/**
 * Saves the nudge and the client's inbox row in one transaction, then pushes
 * after it commits.
 *
 * `beforeWrite` runs first inside the same transaction (the churn send claims
 * its intervention there); if it throws, nothing is written and nothing is
 * pushed, and the error reaches the caller unchanged.
 *
 * The push never fails the send: the message and its inbox row are already
 * committed. Mute all stops the push only (owner #171-3); an unreadable
 * switch sends none.
 */
export async function sendCoachNudge(
  prisma: PrismaService,
  notifications: NotificationsService | undefined,
  logger: Logger,
  nudge: CoachNudgeToSend,
  beforeWrite?: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<CoachNudge> {
  const nudgeId = nudge.nudgeId ?? randomUUID();
  // B-LSNOTIFY-2: the client's inbox row for this nudge (same transaction).
  const inboxNotificationId = randomUUID();

  const saved = await prisma.$transaction(async (tx) => {
    if (beforeWrite) await beforeWrite(tx);
    const row = await tx.coachNudge.create({
      data: {
        id: nudgeId,
        coach_id: nudge.coachId,
        client_id: nudge.clientId,
        title: nudge.title,
        body: nudge.body,
      },
    });
    // B-LSNOTIFY-2 (b#1171 AUDIT 6426427779): the client reads messages in
    // the inbox the Home bell opens (NotificationCenter -> GET
    // /notifications -> Notification rows), not in CoachNudge. So the
    // nudge's full text is ALSO stored there, in this transaction, so the
    // message and its inbox row commit or roll back together and an
    // idempotent replay never writes a second row. Written directly, not via
    // createNotification: that cuts the body to 160 chars and gates by
    // notification settings (this kind falls to the digest setting), and the
    // coach's message is sent either way (owner #171-3: Mute all stops the
    // push, the message stays sent). Same pattern as
    // send-notification.materialiser.ts:147-161.
    await tx.notification.create({
      data: {
        id: inboxNotificationId,
        user_id: nudge.clientId,
        kind: COACH_NUDGE_KIND,
        channel: 'inapp',
        body: nudge.body,
        deep_link: null,
        // B-LONOTIFY3-1: the row names its coach, so the inbox can hide it
        // while the two are in a block either way (inbox-block-rule.ts).
        payload: { title: nudge.title, nudge_id: nudgeId, coach_id: nudge.coachId },
      },
    });
    return row;
  });

  // Fire push AFTER the transaction commits. Failure cannot un-send the
  // message; we log and move on. FR-1154R3 (B-LS1154-2): an ordinary push,
  // so Mute all stops it (the shared rule); the message stays sent. The lock
  // screen never shows the coach's text (anyone holding the phone can read
  // it); the text stays inside the app, in the inbox row written above.
  // CPC-W2 (owner 10-27 15:58, DECISIONS #178-3, wording approved): it reads
  // as a new message, the copy table's message line; the push kind, its Mute
  // all rule and its data stay coach_nudge. B-LSNOTIFY-2: the data carries a
  // tap target the phone knows (`kind` and an explicit actionScreen
  // 'NotificationCenter') plus the inbox row id. `type` and `nudge_id` stay
  // for older builds.
  try {
    if (notifications && !(await muteAllStopsNudgePush(prisma, logger, nudge.clientId, nudgeId))) {
      const copy = lockScreenCopy(NotificationKind.MESSAGE_RECEIVED, nudge.body);
      void notifications
        .pushToUser(
          nudge.clientId,
          copy.title,
          copy.body,
          {
            type: COACH_NUDGE_KIND,
            kind: COACH_NUDGE_KIND,
            actionScreen: COACH_NUDGE_TAP_SCREEN,
            nudge_id: nudgeId,
            notification_id: inboxNotificationId,
          },
          undefined,
          // PF-3-BE: the one send path: held to 08:00 in quiet hours, Mute
          // all and a block with the coach read again when it goes, never
          // posted twice for one nudge.
          {
            kind: COACH_NUDGE_KIND,
            muteAllOnly: true,
            dedupeKey: `coach_nudge:${nudgeId}`,
            otherUserId: nudge.coachId,
          },
        )
        .catch((err: unknown) => {
          logger.warn(`Push failed for nudge=${nudgeId}: ${describeFailure(err)}`);
        });
    }
  } catch (err) {
    logger.warn(`Push failed for nudge=${nudgeId}: ${describeFailure(err)}`);
  }

  return saved;
}

/** FR-1154R3 (owner #171-3): Mute all stops this push; an unreadable switch sends none. */
async function muteAllStopsNudgePush(
  prisma: PrismaService,
  logger: Logger,
  clientId: string,
  nudgeId: string,
): Promise<boolean> {
  try {
    const prefs = await prisma.notificationPreferences.findUnique({
      where: { user_id: clientId },
      select: { muted: true },
    });
    return muteAllStops(prefs, COACH_NUDGE_KIND, 'push');
  } catch {
    logger.warn(`Push skipped for nudge=${nudgeId}: preference read failed`);
    return true;
  }
}
