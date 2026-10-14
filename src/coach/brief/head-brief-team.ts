// BRIEFTEAM (agent 143): the head coach brief's team data (SUBM-BRIEF).
//
// Everything here is scoped to ONE head coach: rows keyed by their coach id,
// or clients in the roster the caller already resolved for them (own clients
// plus open delegations, aggregateHeadCoachContext). Nothing reads another
// coach's clients, and nothing here runs for a sub-coach or solo brief.
import { ConsentScope, type ConsentService } from '../../consent/consent.service';
import { coachSharingCheck } from '../../consent/coach-sharing-gate';
import { isMessagingCoreV2Enabled } from '../../messaging/messaging-core.feature';
import type { PrismaService } from '../../prisma.service';
import type { HeadBriefActivity, HeadBriefClientsYesterday } from './coach-brief.types';

export interface HeadBriefTeamInput {
  headCoachId: string;
  // Active students: own (User.coach_id = head) plus delegated.
  rosterClientIds: string[];
  delegatedClientIds: ReadonlySet<string>;
  teamMode: boolean;
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
  const { headCoachId: head, rosterClientIds: roster, yesterday } = input;
  const window = { gte: yesterday.start, lte: yesterday.end };

  // Clients who messaged: the head coach's own clients. With Team Mode on, a
  // delegated client's thread is their sub-coach's work, so it is left out.
  const ownIds = input.teamMode ? roster.filter((id) => !input.delegatedClientIds.has(id)) : roster;
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
    // MessagingService.unreadCountForCoach): newest per client.
    ownIds.length
      ? prisma.coachMessage.findMany({
          where: {
            coach_id: head,
            client_id: { in: ownIds },
            sender_id: { in: ownIds },
            read_at: null,
            ...(isMessagingCoreV2Enabled() ? { deleted_at: null } : {}),
          },
          select: { client_id: true, body: true, client: { select: { name: true } } },
          orderBy: { created_at: 'desc' },
          distinct: ['client_id'],
        })
      : Promise.resolve([]),
  ]);

  const added = new Set<string>([
    ...redeemed.map((r) => r.client_user_id),
    ...createdOnRoster.map((u) => u.id),
  ]).size;

  const blocked = new Set(blocks.map((b) => b.blocked_id));
  const unreadThreads: HeadBriefUnreadThread[] = [];
  for (const m of unread) {
    if (!m.client_id || blocked.has(m.client_id)) continue;
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
