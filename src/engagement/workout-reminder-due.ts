import type { PrismaService } from '../prisma.service';
import { isDunningV2Enabled } from '../checkout/dunning-v2/dunning-v2.feature';
import { dateFromKey } from './workout-reminder.policy';

// FR-1192R3 (F2): the workout reminder's own send checks, in one place, so
// the sender (WorkoutReminderService.processClient) and the push worker (a
// reminder that waited for the burst cap) ask the same questions.

const DAY_MS = 86_400_000;

/** The eligibility predicate, shared by the page filter and the send-time checks. */
export const ELIGIBLE_CLIENT = { deleted_at: null, deletion_scheduled_at: null, role: 'student' } as const;

export type WorkoutDb = Pick<PrismaService, 'user' | 'clientWorkoutAssignment' | 'workoutSession' | 'dunningState'>;

/** The day's plan workouts that are not skipped, earliest first. */
export function dayAssignments(
  prisma: Pick<WorkoutDb, 'clientWorkoutAssignment'>,
  clientId: string,
  dayStart: Date,
): Promise<Array<{ id: string; completed_at: Date | null }>> {
  return prisma.clientWorkoutAssignment.findMany({
    where: {
      client_id: clientId,
      scheduled_for: { gte: dayStart, lt: new Date(dayStart.getTime() + DAY_MS) },
      skipped_at: null,
    },
    select: { id: true, completed_at: true },
    orderBy: { scheduled_for: 'asc' },
  });
}

/**
 * Why the day's reminder must not go, or null when it may: already trained
 * (a plan workout completed, or a workout logged that day), or in the Day-10
 * dunning lockout (only with FEATURE_DUNNING_V2 on; workouts answer 403
 * LOCKED_DUNNING then, so a reminder would open a locked screen).
 */
export async function workoutReminderSkip(
  prisma: Pick<WorkoutDb, 'workoutSession' | 'dunningState'>,
  clientId: string,
  dayStart: Date,
  assignments: ReadonlyArray<{ completed_at: Date | null }>,
): Promise<'already_logged' | 'locked_out' | null> {
  if (assignments.some((a) => a.completed_at !== null)) return 'already_logged';
  const logged = await prisma.workoutSession.findFirst({
    where: { user_id: clientId, date: dayStart },
    select: { id: true },
  });
  if (logged) return 'already_logged';
  if (isDunningV2Enabled() && (await isDunningLockedOut(prisma, clientId))) return 'locked_out';
  return null;
}

/**
 * Same predicate as DunningLockoutGuard.isClientLockedOut (Day-10 hard
 * lockout): any active DunningState with locked_out_at set on one of the
 * client's purchases whose entitlement is off.
 */
async function isDunningLockedOut(prisma: Pick<WorkoutDb, 'dunningState'>, clientId: string): Promise<boolean> {
  const row = await prisma.dunningState.findFirst({
    where: {
      locked_out_at: { not: null },
      status: 'active',
      purchase: { client_user_id: clientId, entitlement_active: false },
    },
    select: { id: true },
  });
  return row != null;
}

/**
 * A workout reminder that waited (the burst cap) goes only while its sender
 * would still send it: the client is still an eligible client, the plan
 * workout it named is still scheduled for them that day (not skipped or
 * moved), and workoutReminderSkip says nothing. A failed read throws.
 */
export async function workoutReminderStillDue(
  prisma: WorkoutDb,
  clientId: string,
  held: { localDate: string; assignmentId?: string },
): Promise<boolean> {
  const live = await prisma.user.findFirst({ where: { id: clientId, ...ELIGIBLE_CLIENT }, select: { id: true } });
  if (!live) return false;
  const dayStart = dateFromKey(held.localDate);
  const assignments = await dayAssignments(prisma, clientId, dayStart);
  if (held.assignmentId && !assignments.some((a) => a.id === held.assignmentId)) return false;
  return (await workoutReminderSkip(prisma, clientId, dayStart, assignments)) === null;
}
