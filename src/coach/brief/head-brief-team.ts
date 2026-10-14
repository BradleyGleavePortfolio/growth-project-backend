// BRIEFTEAM (agent 143): the head coach brief's team data (SUBM-BRIEF).
//
// Everything here is scoped to ONE head coach: rows keyed by their coach id,
// or clients in the roster the caller already resolved for them (own clients
// plus open delegations, aggregateHeadCoachContext). Nothing reads another
// coach's clients, and nothing here runs for a sub-coach or solo brief.
import { ConsentScope, type ConsentService } from '../../consent/consent.service';
import { coachSharingCheck } from '../../consent/coach-sharing-gate';
import { isMessagingCoreV2Enabled } from '../../messaging/messaging-core.feature';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma.service';
import type { HeadBriefActivity, HeadBriefClientsYesterday } from './coach-brief.types';

export interface HeadBriefTeamInput {
  headCoachId: string;
  // Active students: own (User.coach_id = head) plus delegated.
  rosterClientIds: string[];
  // The head coach's own clients: the roster minus every client delegated to
  // a sub-coach, whatever the Team Mode switch says (HEAD-EXTRA 2).
  ownClientIds: string[];
  // The previous local day: 'YYYY-MM-DD' and its instants in the coach's zone.
  yesterday: { date: string; start: Date; end: Date };
}

export interface HeadBriefUnreadThread {
  client_id: string;
  client_name: string;
  message_preview: string;
}

export interface HeadBriefTeamResult {
  clients_yesterday: HeadBriefClientsYesterday;
  activity: HeadBriefActivity;
  // One per client, newest unread message first; fed to buildActionItems.
  unreadThreads: HeadBriefUnreadThread[];
}

export async function aggregateHeadBriefTeam(
  prisma: PrismaService,
  consent: ConsentService | undefined,
  input: HeadBriefTeamInput,
): Promise<HeadBriefTeamResult> {
  const { headCoachId: head, rosterClientIds: roster, ownClientIds: ownIds, yesterday } = input;
  const window = { gte: yesterday.start, lte: yesterday.end };

  const sharing = await coachSharingCheck(consent, prisma, head);
  const checkInIds = roster.length ? await sharing(ConsentScope.FITNESS_HABITS_PROGRESS, roster) : [];

  const [redeemed, createdOnRoster, left, checkIns, blocks, unread] = await Promise.all([
    // Joined by a code (the signup ledger the Codes screen counts); a team
    // code's ledger row is written under the head coach.
    prisma.inviteRedemption.findMany({
      where: { coach_id: head, redeemed_at: window },
      select: { client_user_id: true },
    }),
    // Joined by an account created already on the roster (guest checkout).
    prisma.user.findMany({
      where: { coach_id: head, role: 'student', created_at: window },
      select: { id: true },
    }),
    // Left: archived by the coach, or erased by the scrub worker (which
    // archives the row). An in-app account deletion clears coach_id, so it
    // is not counted.
    prisma.user.count({
      where: { coach_id: head, role: 'student', archived_at: window },
    }),
    checkInIds.length
      ? prisma.checkIn.count({
          where: { user_id: { in: checkInIds }, date: new Date(`${yesterday.date}T00:00:00.000Z`) },
        })
      : Promise.resolve(0),
    prisma.userBlock.findMany({ where: { blocker_id: head }, select: { blocked_id: true } }),
    // Unread = written by the client and not yet read (the inbox rule in
    // MessagingService.unreadCountForCoach), own clients still on the head
    // coach's roster.
    ownIds.length
      ? prisma.coachMessage.findMany({
          where: {
            coach_id: head,
            client_id: { in: ownIds },
            sender_id: { in: ownIds },
            client: { coach_id: head, archived_at: null },
            read_at: null,
            ...(isMessagingCoreV2Enabled() ? { deleted_at: null } : {}),
          },
          select: { client_id: true, body: true, client: { select: { name: true } } },
          orderBy: { created_at: 'desc' },
          take: 100, // deduped by client below, as in the solo brief
        })
      : Promise.resolve([]),
  ]);

  const added = new Set<string>([
    ...redeemed.map((r) => r.client_user_id),
    ...createdOnRoster.map((u) => u.id),
  ]).size;

  // Blocked clients are left out; the first (newest) message per client wins.
  const skip = new Set(blocks.map((b) => b.blocked_id));
  const unreadThreads: HeadBriefUnreadThread[] = [];
  for (const m of unread) {
    if (!m.client_id || skip.has(m.client_id)) continue;
    skip.add(m.client_id);
    unreadThreads.push({
      client_id: m.client_id,
      client_name: m.client?.name ?? 'Client',
      message_preview: m.body ?? '(voice message)',
    });
  }

  return {
    clients_yesterday: { date: yesterday.date, added, left, net: added - left },
    activity: {
      check_ins_date: yesterday.date,
      check_ins_completed: checkIns,
      check_ins_not_shared: roster.length - checkInIds.length,
      clients_messaged: unreadThreads.length,
    },
    unreadThreads,
  };
}

// The calendar day before `date` ('YYYY-MM-DD').
export function previousDate(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// BRIEFTEAM2 (Sol B3): the clients a stored head brief names (its
// message_unread rows carry client_id, name and preview).
export function namedClientIds(actionItems: Prisma.JsonValue | null): string[] {
  if (!Array.isArray(actionItems)) return [];
  return actionItems.flatMap((i) => {
    const id = i !== null && typeof i === 'object' && !Array.isArray(i) ? i.client_id : undefined;
    return typeof id === 'string' ? [id] : [];
  });
}

// Which of `ids` are the head coach's own right now: User.coach_id = head, an
// active student, and not delegated to a sub-coach.
export async function stillOwnClientIds(prisma: PrismaService, head: string, ids: string[]): Promise<Set<string>> {
  const [own, delegated] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: ids }, coach_id: head, role: 'student', archived_at: null },
      select: { id: true },
    }),
    prisma.subCoachAssignment.findMany({
      where: { head_coach_id: head, client_id: { in: ids }, unassigned_at: null },
      select: { client_id: true },
    }),
  ]);
  const away = new Set(delegated.map((d) => d.client_id));
  return new Set(own.map((u) => u.id).filter((id) => !away.has(id)));
}
