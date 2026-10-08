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
