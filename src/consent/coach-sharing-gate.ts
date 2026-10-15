import { PrismaService } from '../prisma.service';
import { ConsentService } from './consent.service';

/** The ids, out of `clientIds`, whose `scope` log the coach may read. */
export type CoachSharingCheck = (scope: string, clientIds: string[]) => Promise<string[]>;

/**
 * COACH-AI-GATE-130 — the client's Coach sharing switches (Settings > Privacy > Coach sharing) for
 * coach-side readers of many clients or of AI input. Same rule as the client summary:
 * ConsentService.coachCanAccess (a granted row for this coach, client and scope; the owner passes).
 * `consent` is missing only in hand-built unit tests (the services take it without @Optional(), so
 * Nest fails at boot rather than run without it); those keep their all-shared fixtures.
 */
export async function coachSharingCheck(
  consent: ConsentService | undefined,
  prisma: PrismaService,
  coachId: string,
): Promise<CoachSharingCheck> {
  if (!consent) return async (_scope, clientIds) => clientIds;
  const caller = await prisma.user.findUnique({ where: { id: coachId }, select: { role: true } });
  return async (scope, clientIds) => {
    const allowed = await Promise.all(clientIds.map((id) => consent.coachCanAccess(coachId, id, scope, caller?.role)));
    return clientIds.filter((_, i) => allowed[i]);
  };
}

/** The fields that hold a weight on a row a coach read sends: a check-in's, and the profile's current and target. */
const WEIGHT_FIELDS = ['weight_kg', 'current_weight_lbs', 'target_weight_lbs'] as const;

/**
 * C8-S (SoT A2 item 12): a coach-facing read returns a client's weight only while that client's
 * Weigh-ins switch (`fitness.body_metrics`, ConsentService.coachCanAccess) is on. Off, each weight
 * field reads null, the shape an unshared slice already has (roster and summary `profile: null`);
 * the rest of the row stays.
 */
export function weightIfShared<T extends object>(row: T, weighIns: boolean): T {
  if (weighIns) return row;
  return { ...row, ...Object.fromEntries(WEIGHT_FIELDS.filter((f) => f in row).map((f) => [f, null])) };
}
