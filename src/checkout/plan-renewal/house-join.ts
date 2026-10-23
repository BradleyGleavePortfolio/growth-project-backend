import { Logger } from '@nestjs/common';
import type { CoachPackage, Prisma, PrismaClient } from '@prisma/client';
import { deleteDraftsLeftByMove } from '../../coach/moved-client-drafts';
import type {
  MoveCancelledSession,
  SchedulingSessionLifecycleService,
} from '../../scheduling/scheduling-session-lifecycle.service';
import { houseCoachUserId, isPlanRenewalEnabled } from './plan-renewal.cadence';
import { readPlanRenewal } from './plan-renewal.state';
import { packageTrialDays } from '../subscription-plan';
import { tellFormerCoachTx } from './switch-tell';

type Db = PrismaClient | Prisma.TransactionClient;
const log = new Logger('HouseJoin');

/**
 * HOUSE-JOIN-BE: the one door through the cross-coach purchase block (owner
 * "#166-1 SWITCH-V1 - op 1"; OPERATOR RULING v3 6328335815 item 4). It is open
 * only while FEATURE_PLAN_RENEWAL is on and the client's renewal answer with
 * their current coach is "ended" inside the banner window (local days 0 to
 * 29) and offers TGP's house coach (HOUSE_COACH_USER_ID: a live coach account,
 * never the client's own coach), and only for that house coach's packages.
 * One rule for the package list and every checkout path. At payment the
 * move drops only the window (anyDay): a payment started inside it may be
 * confirmed after day 29. Returns the coach the client would leave, or null
 * (closed).
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
  if (!open || !view.coach) return null;
  // b#1131 LO N3: the house account must be a coach (the renewal offer also
  // accepts 'owner'); any other role keeps the door closed.
  const house = await db.user.findUnique({ where: { id: packageCoachId }, select: { role: true } });
  if (house?.role !== 'coach') {
    log.warn(`house join closed: HOUSE_COACH_USER_ID role is ${house?.role ?? 'missing'}, not coach`);
    return null;
  }
  return view.coach.id;
}

/** #166-6 HOUSE-TRIALS ("offer no free trials from the house in v1"). */
export const freeTrialPackage = (pkg: CoachPackage): boolean => packageTrialDays(pkg) > 0;

/**
 * The door for one package, used by the package detail and all three checkout
 * paths (the list filters its rows with freeTrialPackage): a house package
 * that offers a free trial is not part of the door, so it gets the same 404
 * as every other cross-coach package. The door sells only packages that take
 * payment at checkout, and a door purchase never starts a trial.
 */
export async function houseJoinToBuy(
  db: Db,
  clientUserId: string,
  pkg: CoachPackage,
): Promise<string | null> {
  if (freeTrialPackage(pkg)) return null;
  return await houseJoinFrom(db, clientUserId, pkg.coach_id);
}

/**
 * After payment, in the activation's transaction (the purchase fan-out).
 * #SWITCH-WHEN: the client confirmed and checked out, the payment succeeded,
 * and only now does the former coach lose the client. The move runs the rules
 * every coach change runs (as the team reassign does): coach_id changes (its
 * triggers mark the former coach's plans moved and set the join time), the
 * former coach's upcoming sessions end (HIST-2b), drafts left about the client
 * go (decision 17), and the renewal with the former coach stops ('moved').
 * SWITCH-TELL-BE: the former coach gets one in-app notification that the
 * client moved (never naming the house coach), in the same transaction.
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
  await tellFormerCoachTx(tx, clientUserId, from);
  return cancelled;
}
