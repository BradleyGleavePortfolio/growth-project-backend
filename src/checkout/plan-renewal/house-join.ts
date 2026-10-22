import type { Prisma, PrismaClient } from '@prisma/client';
import { deleteDraftsLeftByMove } from '../../coach/moved-client-drafts';
import type {
  MoveCancelledSession,
  SchedulingSessionLifecycleService,
} from '../../scheduling/scheduling-session-lifecycle.service';
import { houseCoachUserId, isPlanRenewalEnabled } from './plan-renewal.cadence';
import { readPlanRenewal } from './plan-renewal.state';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * HOUSE-JOIN-BE: the one door through the cross-coach purchase block (owner
 * "#166-1 SWITCH-V1 - op 1"; OPERATOR RULING v3 6328335815 item 4). It is open
 * only while FEATURE_PLAN_RENEWAL is on and the client's renewal answer with
 * their current coach is "ended" inside the banner window (local days 0 to
 * 29) and offers TGP's house coach (HOUSE_COACH_USER_ID: a live coach account,
 * never the client's own coach), and only for that house coach's packages.
 * One rule for the package list and every checkout path. At payment the
 * move drops only the window (anyDay): a free trial bought inside it may take
 * its first payment after day 29. Returns the coach the client would leave,
 * or null (closed).
 */
export async function houseJoinFrom(
  db: Db,
  clientUserId: string,
  packageCoachId: string,
  now = new Date(),
  anyDay = false,
): Promise<string | null> {
  if (!isPlanRenewalEnabled() || packageCoachId !== houseCoachUserId()) return null;
  const view = await readPlanRenewal(db, clientUserId, undefined, now);
  const open = view.state === 'ended' && (anyDay || view.banner_due) && view.house_coach?.id === packageCoachId;
  return open ? (view.coach?.id ?? null) : null;
}

/**
 * After payment, in the activation's transaction (the purchase fan-out).
 * #SWITCH-WHEN: the client confirmed and checked out, the payment succeeded,
 * and only now does the former coach lose the client. The move runs the rules
 * every coach change runs (as the team reassign does): coach_id changes (its
 * triggers mark the former coach's plans moved and set the join time), the
 * former coach's upcoming sessions end (HIST-2b), drafts left about the client
 * go (decision 17), and the renewal with the former coach stops ('moved').
 * Reads follow coach_id and row security from here: the former coach keeps
 * only their own money records. Returns the cancelled sessions to finish
 * after commit, or null when nothing moved (the door is closed).
 */
export async function moveToHouseCoachTx(
  tx: Prisma.TransactionClient,
  clientUserId: string,
  houseCoachId: string,
  sessions?: Pick<SchedulingSessionLifecycleService, 'cancelLeftByMove'>,
): Promise<MoveCancelledSession[] | null> {
  const from = await houseJoinFrom(tx, clientUserId, houseCoachId, new Date(), true);
  if (!from) return null;
  const moved = await tx.user.updateMany({
    where: { id: clientUserId, coach_id: from },
    data: { coach_id: houseCoachId },
  });
  if (moved.count !== 1) return null;
  const cancelled = (await sessions?.cancelLeftByMove(tx, [clientUserId], from)) ?? [];
  await deleteDraftsLeftByMove(tx, [clientUserId], houseCoachId);
  await tx.planRenewal.updateMany({
    where: { client_user_id: clientUserId, coach_user_id: from, status: { in: ['active', 'done'] } },
    data: { status: 'stopped', stop_reason: 'moved' },
  });
  return cancelled;
}
