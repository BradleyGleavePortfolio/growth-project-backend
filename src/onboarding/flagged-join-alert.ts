import type { Prisma } from '@prisma/client';
import { NotificationKind } from '../notifications/notification-kind';

/** Owner decision 61a, exact wording. Names no screening answer. */
export const FLAGGED_JOIN_ALERT_BODY =
  'A client who just joined you was flagged for extra care in their consultation. Please review their answers before their first session.';

/** The two tables the alert reads and writes, inside the join's transaction. */
export interface FlaggedJoinTx {
  clientOnboardingIntake?: Pick<Prisma.TransactionClient['clientOnboardingIntake'], 'findUnique'>;
  notification?: Pick<Prisma.TransactionClient['notification'], 'create'>;
}

/**
 * Owner decision 61a: a client with no coach whose consultation was flagged
 * for extra care alerts nobody at completion. When they later join a coach,
 * that coach gets ONE in-app alert, linked to the client so a tap opens their
 * consultation answers (the coach can read them from the join on).
 *
 * Call it inside the join's transaction, only when that write made `coachId`
 * the client's coach: a replayed or refused join writes nothing, so nothing is
 * sent again, and a rolled-back join takes the alert with it. In-app only: no
 * push is sent, and the body names no screening answer.
 *
 * Returns true when the alert was written.
 */
export async function alertCoachOfFlaggedJoinTx(
  tx: FlaggedJoinTx,
  clientId: string,
  coachId: string,
): Promise<boolean> {
  // Unit-test doubles that model neither table (a Prisma client always has both).
  if (!tx.clientOnboardingIntake || !tx.notification) return false;
  const intake = await tx.clientOnboardingIntake.findUnique({
    where: { client_id: clientId },
    select: { completed_at: true, screening_flagged_at: true },
  });
  if (!intake?.completed_at || !intake.screening_flagged_at) return false;
  await tx.notification.create({
    data: {
      user_id: coachId,
      kind: NotificationKind.COACH_ALERT,
      channel: 'inapp',
      body: FLAGGED_JOIN_ALERT_BODY,
      payload: {
        type: 'onboarding_screening_review',
        client_id: clientId,
        // The notification center routes a tap by actionScreen/actionParams.
        actionScreen: 'ClientConsultation',
        actionParams: { clientId },
      },
    },
  });
  return true;
}
