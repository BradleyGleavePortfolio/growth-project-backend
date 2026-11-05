import type { CommunityCohort, Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma.service';

/**
 * FR-1152R3 B1 (owner rule D, 10-26): "ALL alerts and information go to the
 * space owner and their team, plus your resident coach (or just the space
 * owner if coachless)". A public space's side is its workspace's owner and
 * its active coach or assistant members who are coaches (b#1173's
 * coachedCohortIds rule, public spaces only; the alert routes admit only
 * coaches). Each of them gets a space copy of a photo safety alert: type
 * community_photo_safety, payload { space_id } and nothing else. A space
 * copy is read (listed, counted, opened, dismissed, in the inbox, pushed)
 * only while its reader still leads that public space; every other alert,
 * and the resident copy, keeps the current-coach rule.
 */
type Db = Pick<PrismaService, 'communityCohort' | 'communityWorkspace' | 'communityMembership'>;

const SPACE_ALERT_TYPE = 'community_photo_safety';

/** Who leads a public space now: its owner and coach-role team. None for any other space. */
export async function spaceLeaders(
  db: Db,
  space: Pick<CommunityCohort, 'id' | 'workspace_id' | 'visibility'>,
): Promise<string[]> {
  if (space.visibility !== 'public') return [];
  const [workspace, team] = await Promise.all([
    db.communityWorkspace.findUnique({ where: { id: space.workspace_id }, select: { coach_id: true } }),
    db.communityMembership.findMany({
      where: {
        cohort_id: space.id,
        status: 'active',
        role: { in: ['coach', 'assistant'] },
        user: { role: { in: ['coach', 'owner'] } },
      },
      select: { user_id: true },
    }),
  ]);
  return [...new Set([...(workspace ? [workspace.coach_id] : []), ...team.map((m) => m.user_id)])];
}

/** The public spaces a person leads now: they own its workspace or coach in it. */
export async function publicSpacesLedBy(db: Db, userId: string): Promise<string[]> {
  const spaces = await db.communityCohort.findMany({
    where: {
      visibility: 'public',
      OR: [
        { workspace: { coach_id: userId } },
        { memberships: { some: { user_id: userId, status: 'active', role: { in: ['coach', 'assistant'] } } } },
      ],
    },
    select: { id: true },
  });
  return spaces.map((s) => s.id);
}

/** The space copies a coach may read now, as one OR arm; none if they lead no public space. */
export async function spaceAlertCopies(db: Db, coachId: string): Promise<Prisma.CoachAlertWhereInput[]> {
  const spaces = await publicSpacesLedBy(db, coachId);
  if (spaces.length === 0) return [];
  return [
    {
      coach_id: coachId,
      alert_type: SPACE_ALERT_TYPE,
      OR: spaces.map((id) => ({ payload: { path: ['space_id'], equals: id } })),
    },
  ];
}

/** `own`, or `own` plus those copies (an OR) when there are any. */
export function withSpaceCopies(
  own: Prisma.CoachAlertWhereInput,
  copies: Prisma.CoachAlertWhereInput[],
): Prisma.CoachAlertWhereInput {
  return copies.length > 0 ? { OR: [own, ...copies] } : own;
}

/** The space a stored alert is a space copy for, if it is one. */
export function spaceCopyOf(alert: { alert_type: string; payload?: Prisma.JsonValue }): string | undefined {
  const p = alert.payload;
  const id = alert.alert_type === SPACE_ALERT_TYPE && p && typeof p === 'object' && !Array.isArray(p) ? p.space_id : undefined;
  return typeof id === 'string' ? id : undefined;
}
