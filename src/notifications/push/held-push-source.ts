import type { PrismaService } from '../../prisma.service';
import { bannedAmong } from '../../community/community-ban';
import { isMessagingCoreV2Enabled } from '../../messaging/messaging-core.feature';
import { dunningPushStillDue } from '../../checkout/dunning-v2/dunning-cycle';
import { trialPushStillDue } from '../../packages/trials/trial-notice-truth';
import { WorkoutDb, workoutReminderStillDue } from '../../engagement/workout-reminder-due';

/**
 * FR-1192 (R1): what a push about other people keeps with it, so the one
 * worker asks again, when it sends, everything its sender asked when it was
 * queued. A push held for quiet hours (or the burst cap, or a retry) is
 * dropped, never sent, once one of these says no.
 */
export interface HeldPushSource {
  /** The other person the push is about: a block either way stops it. */
  otherUserId?: string;
  /** A second such person (a broadcast a team member wrote names the coach too). */
  alsoUserId?: string;
  /**
   * The community a Community push comes from. A ban there of the reader or of
   * the other person stops it; a push whose community could not be read
   * (workspaceId null) is not sent (as a space push without its source).
   */
  community?: { workspaceId: string | null };
  /** The coach thread a message push is about: the reader's mute of it stops it. */
  coachThread?: { coachId: string; clientId: string };
  /** FR-1192R2: a payment reminder's dunning cycle: once it is no longer live (paid, canceled, ended, replaced) it stops it. */
  dunning?: { stateId: string; cycleKey?: string };
  /** FR-1192R2: a trial-ending push's notice: a trial that ended, converted, was replaced or canceled stops it. */
  trialNotice?: { noticeId: string; cancelAtPeriodEnd: boolean };
  /**
   * FR-1192R3: a workout reminder's client-local day and the plan workout it
   * named (none on the first day): its sender's own checks stop it.
   */
  workoutReminder?: { localDate: string; assignmentId?: string };
}

type Db = Pick<PrismaService, 'userBlock' | 'communityWorkspaceBan' | 'coachThreadState'>;
type OwedDb = Pick<PrismaService, 'dunningState' | 'packageTrialNotice' | 'clientPurchase'> & WorkoutDb;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

const id = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** The stored source, read back from the outbox row's context (anything else is ignored). */
export function asHeldPushSource(o: Record<string, unknown>): HeldPushSource {
  const community = o.community as Record<string, unknown> | null | undefined;
  const thread = o.coachThread as Record<string, unknown> | null | undefined;
  const coachId = id(thread?.coachId);
  const clientId = id(thread?.clientId);
  const dunning = o.dunning as Record<string, unknown> | null | undefined;
  const stateId = id(dunning?.stateId);
  const cycleKey = id(dunning?.cycleKey);
  const trial = o.trialNotice as Record<string, unknown> | null | undefined;
  const noticeId = id(trial?.noticeId);
  const workout = o.workoutReminder as Record<string, unknown> | null | undefined;
  const localDate = id(workout?.localDate);
  const assignmentId = id(workout?.assignmentId);
  return {
    ...(id(o.otherUserId) ? { otherUserId: id(o.otherUserId) } : {}),
    ...(id(o.alsoUserId) ? { alsoUserId: id(o.alsoUserId) } : {}),
    ...(community && typeof community === 'object'
      ? { community: { workspaceId: id(community.workspaceId) ?? null } }
      : {}),
    ...(coachId && clientId ? { coachThread: { coachId, clientId } } : {}),
    ...(stateId ? { dunning: { stateId, ...(cycleKey ? { cycleKey } : {}) } } : {}),
    ...(noticeId ? { trialNotice: { noticeId, cancelAtPeriodEnd: trial?.cancelAtPeriodEnd === true } } : {}),
    ...(localDate && DAY_KEY.test(localDate)
      ? { workoutReminder: { localDate, ...(assignmentId ? { assignmentId } : {}) } }
      : {}),
  };
}

/**
 * Whether a push that waited is still owed, by its sender's own check (owner
 * #186-P1, operator rulings R3 and R4). 'ended': a payment reminder whose
 * dunning cycle ended (paid or renewed, canceled, or over), a trial-ending
 * push whose trial converted, ended or was canceled, or a workout reminder
 * its sender would no longer send (FR-1192R3: done or logged, the client
 * deleted, locked at Day 10, or the plan workout no longer theirs that day).
 * 'unread': a source read failed, which is neither yes nor no (ruling R4): the
 * row waits for the next pass and is asked again, never sent unchecked and
 * never dropped on a guess.
 */
export async function heldPushStillOwed(
  prisma: OwedDb,
  userId: string,
  source: HeldPushSource,
  now: Date,
): Promise<'owed' | 'ended' | 'unread'> {
  try {
    if (source.dunning && !(await dunningPushStillDue(prisma, source.dunning))) return 'ended';
    if (source.trialNotice && !(await trialPushStillDue(prisma, source.trialNotice, now))) return 'ended';
    if (source.workoutReminder && !(await workoutReminderStillDue(prisma, userId, source.workoutReminder))) {
      return 'ended';
    }
  } catch {
    return 'unread';
  }
  return 'owed';
}

/** Why a held push to `userId` may no longer be sent, or null when it still may. */
export async function heldPushDropReason(
  prisma: Db,
  userId: string,
  source: HeldPushSource,
  now: Date,
): Promise<'blocked' | 'banned' | 'no-source' | 'thread-muted' | null> {
  const others = [source.otherUserId, source.alsoUserId].filter((p): p is string => !!p && p !== userId);
  if (others.length) {
    const hit = await prisma.userBlock.findFirst({
      where: {
        OR: others.flatMap((o) => [
          { blocker_id: userId, blocked_id: o },
          { blocker_id: o, blocked_id: userId },
        ]),
      },
      select: { id: true },
    });
    if (hit) return 'blocked';
  }
  if (source.community) {
    const ws = source.community.workspaceId;
    if (!ws) return 'no-source';
    const people = [userId, ...(source.otherUserId ? [source.otherUserId] : [])];
    if ((await bannedAmong(prisma, ws, people)).size > 0) return 'banned';
  }
  // The sender reads the mute only with messaging core v2 on (messaging.service
  // isThreadMutedFor), and fails open on a failed read: the same here.
  if (source.coachThread && isMessagingCoreV2Enabled() && (await threadMuted(prisma, userId, source.coachThread, now))) {
    return 'thread-muted';
  }
  return null;
}

async function threadMuted(
  prisma: Db,
  userId: string,
  thread: { coachId: string; clientId: string },
  now: Date,
): Promise<boolean> {
  try {
    const state = await prisma.coachThreadState.findUnique({
      where: {
        CoachThreadState_user_thread_key: { user_id: userId, coach_id: thread.coachId, client_id: thread.clientId },
      },
      select: { muted_until: true },
    });
    return !!state?.muted_until && state.muted_until.getTime() > now.getTime();
  } catch {
    return false;
  }
}
