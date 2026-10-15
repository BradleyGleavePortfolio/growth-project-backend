import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma.service';
import { SchedulingAccessService } from '../scheduling/scheduling-access.service';
import { SubCoachScopeService } from '../sub-coach/sub-coach-scope.service';
import { NotificationKind } from './notification-kind';
import { COACH_CLIENT_LINK } from './push/lock-screen-copy';

/**
 * Owner 4 (137-8): when a client moves, the coach they left loses everything
 * about them at once; the client keeps their own history. A coach who is
 * still authorised for a client or session keeps every notification about
 * them. A notification names its client in one of three ways, and it is
 * listed, counted, opened, marked and pushed only while the reader may still
 * open what it names:
 *   - a client link, then the client id (and maybe a sub-path): coach alerts,
 *     check-ins, the first payment (COACH_CLIENT_LINK) and messages (the
 *     thread is the client);
 *   - a session link, then the session id: every booking notice;
 *   - no link: the onboarding flag item names its client in payload.client_id.
 * Every other row (money notices, digests) is unchanged.
 */
export const CLIENT_LINKS = [COACH_CLIENT_LINK, 'tgp://messages/'];
export const SESSION_LINKS = ['tgp://coach/sessions/', 'tgp://sessions/'];

// One pair per Prisma client (the process has one), like the DI singletons.
const access = new WeakMap<PrismaService, [SubCoachScopeService, SchedulingAccessService]>();

/**
 * Who the reader may still open, from the two existing rules (no third one):
 * their clients are the roster and messages rule (SubCoachScopeService: their
 * own clients, plus a live delegation while the client is still the head
 * coach's); their sessions with anyone else are the ones Calendar no longer
 * serves (SchedulingAccessService.sessionsStillTheirs: the client may no
 * longer book with them).
 */
async function reach(db: PrismaService, userId: string): Promise<{ mine: string[]; left: string[] }> {
  let rules = access.get(db);
  if (!rules) {
    rules = [new SubCoachScopeService(db), new SchedulingAccessService(db)];
    access.set(db, rules);
  }
  const clients = await rules[0].getAuthorizedClientIds(userId);
  const sessions = await db.coachingSession.findMany({
    where: { coach_id: userId, NOT: await rules[1].sessionsStillTheirs(userId) },
    select: { id: true },
  });
  return { mine: [userId, ...clients], left: sessions.map((s) => s.id) };
}

/** The reader's inbox: list, unread count, badge, mark read, mark all read. */
export async function currentCoachInbox(db: PrismaService, userId: string): Promise<Prisma.NotificationWhereInput> {
  const { mine, left } = await reach(db, userId);
  return {
    user_id: userId,
    OR: [
      { deep_link: { in: CLIENT_LINKS.flatMap((p) => mine.map((id) => p + id)) } },
      ...CLIENT_LINKS.flatMap((p) => mine.map((id) => ({ deep_link: { startsWith: `${p}${id}/` } }))),
      {
        deep_link: { not: null, notIn: SESSION_LINKS.flatMap((p) => left.map((id) => p + id)) },
        NOT: CLIENT_LINKS.map((p) => ({ deep_link: { startsWith: p } })),
      },
      { deep_link: null, kind: { not: NotificationKind.COACH_ALERT } },
      ...mine.map((id) => ({ deep_link: null, payload: { path: ['client_id'], equals: id } })),
    ],
  };
}

/** The same rule for one queued push, at send time (its tap link). */
export async function pushStillCurrent(db: PrismaService, userId: string, data: Prisma.JsonValue): Promise<boolean> {
  const link = data && typeof data === 'object' && !Array.isArray(data) ? data.deepLink : null;
  if (typeof link !== 'string') return true;
  const client = CLIENT_LINKS.some((p) => link.startsWith(p));
  if (!client && !SESSION_LINKS.some((p) => link.startsWith(p))) return true;
  const { mine, left } = await reach(db, userId);
  return client
    ? CLIENT_LINKS.some((p) => mine.some((id) => link === p + id || link.startsWith(`${p}${id}/`)))
    : !SESSION_LINKS.some((p) => left.some((id) => link === p + id));
}
