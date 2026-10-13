import { Prisma } from '@prisma/client';

// Payload keys that name the client an AI approval draft acts on. The same
// keys as PAYLOAD_CLIENT_ID_KEYS in src/ai/gateway/ai-approval.service.ts,
// which deciding a draft checks (test/moved-client-drafts.spec.ts pins them).
export const MOVED_CLIENT_PAYLOAD_KEYS = ['clientId', 'client_id', 'target_client_id'] as const;

// An AI approval draft names a client as its subject or in its payload.
const namesClients = (ids: string[]): Prisma.AiActionDraftWhereInput => ({
  OR: [
    { subject_user_id: { in: ids } },
    ...ids.flatMap((id) => MOVED_CLIENT_PAYLOAD_KEYS.map((key) => ({ payload: { path: [key], equals: id } }))),
  ],
});

/**
 * Owner decision 17: when a client moves to another coach, the drafts about
 * them that any other coach holds are deleted at once, in the transaction
 * that moves them. They are not frozen and never pass to the new coach.
 * Approved or sent items are history and stay (owner decision 4).
 *
 * For each moved client, held by anyone but `newCoachId` (by anyone at all
 * when `newCoachId` is null: the client has no coach now):
 *   - Coach AI drafts (AIDraft) that are not APPROVED;
 *   - AI approval drafts (AiActionDraft) with a tenant that are not approved,
 *     name the client as subject or in the payload, and whose tenant or
 *     requester is not the new coach;
 *   - message composer drafts (MessageDraft), which are never sent;
 *   - re-engagement drafts (ChurnIntervention) that are not sent.
 *
 * Deleting again deletes nothing more, so a repeated move is harmless.
 */
export async function deleteDraftsLeftByMove(
  tx: Prisma.TransactionClient,
  clientIds: readonly string[],
  newCoachId: string | null,
): Promise<void> {
  if (clientIds.length === 0) return;
  const ids = [...clientIds];
  const others = newCoachId === null ? undefined : { not: newCoachId };
  await tx.aIDraft.deleteMany({
    where: { clientId: { in: ids }, coachId: others, status: { not: 'APPROVED' } },
  });
  await tx.aiActionDraft.deleteMany({
    where: {
      status: { not: 'approved' },
      tenant_coach_id: { not: null },
      AND: [
        namesClients(ids),
        // A sub-coach's workout builder draft carries the head coach's tenant,
        // so the requester holds it too. A null requester is not the new coach.
        ...(newCoachId === null
          ? []
          : [{ OR: [{ tenant_coach_id: others }, { requester_id: null }, { requester_id: others }] }]),
      ],
    },
  });
  await tx.messageDraft.deleteMany({
    where: { client_id: { in: ids }, coach_id: others },
  });
  await tx.churnIntervention.deleteMany({
    where: { client_id: { in: ids }, coach_id: others, status: { not: 'sent' } },
  });
}

/**
 * Owner decision 17 for a sub-coach handoff: the client stays the head
 * coach's, so only `holderId` (the sub-coach whose delegation closed) loses
 * the drafts about them, by the same rules. The head coach and the next
 * sub-coach keep their own.
 */
export async function deleteDraftsHeldBy(
  tx: Prisma.TransactionClient,
  clientId: string,
  holderId: string,
): Promise<void> {
  await tx.aIDraft.deleteMany({ where: { clientId, coachId: holderId, status: { not: 'APPROVED' } } });
  await tx.aiActionDraft.deleteMany({
    where: {
      status: { not: 'approved' },
      tenant_coach_id: { not: null },
      AND: [namesClients([clientId]), { OR: [{ tenant_coach_id: holderId }, { requester_id: holderId }] }],
    },
  });
  await tx.messageDraft.deleteMany({ where: { client_id: clientId, coach_id: holderId } });
  await tx.churnIntervention.deleteMany({ where: { client_id: clientId, coach_id: holderId, status: { not: 'sent' } } });
}

// Roman's two safety alert types (backend #946). Plain strings, so this file
// does not depend on the order in which the two PRs merge.
const MOVED_CLIENT_SAFETY_ALERT_TYPES = ['roman_urgent_reply', 'roman_eating_disorder_reply'] as const;

// Payload keys that name the client on a coach's inbox row: coach and flag
// alerts, check-in rows, the first payment, a failed package drop.
const MOVED_CLIENT_INBOX_KEYS = ['clientUserId', 'clientId', 'client_id', 'client_user_id'] as const;

// A coach's inbox row is about a client when it opens them (their coach
// screens or their chat) or names them in its payload.
const inboxRowsAbout = (ids: string[]): Prisma.NotificationWhereInput[] =>
  ids.flatMap((id) => [
    { deep_link: `tgp://coach/clients/${id}` },
    { deep_link: { startsWith: `tgp://coach/clients/${id}/` } },
    { deep_link: `tgp://messages/${id}` },
    ...MOVED_CLIENT_INBOX_KEYS.map((key) => ({ payload: { path: [key], equals: id } })),
  ]);

/**
 * Owner 4: when a client moves, the coaches they left lose their alerts,
 * inbox rows and cached coach-side insights about them at once, in the
 * transaction that moves them. For each moved client:
 *   - alerts (CoachAlert) held by anyone but `newCoachId` (by anyone at all
 *     when it is null) are deleted. Owner 57q: a Roman safety alert that is
 *     still open passes to the new coach instead, the coach Roman alerts after
 *     the move, so it is never lost. A dismissed one is the old coach's
 *     handled item; the reply itself stays in the client's Roman chat;
 *   - `formerCoachId`'s inbox rows (Notification) about them are deleted.
 *     Money rows (a purchase, refund, dispute or payout) open the coach's own
 *     billing and use none of these keys, so they stay;
 *   - coach-side wearable insight rows (side 'coach:<coachId>', or the shared
 *     'coach' row stored before that key) of anyone but the new coach go.
 * The client's own rows are never touched. Repeating it deletes nothing more.
 */
export async function deleteCoachRowsLeftByMove(
  tx: Prisma.TransactionClient,
  clientIds: readonly string[],
  formerCoachId: string,
  newCoachId: string | null,
): Promise<void> {
  if (clientIds.length === 0) return;
  const ids = [...clientIds];
  const others = newCoachId === null ? undefined : { not: newCoachId };
  if (newCoachId !== null) {
    await tx.coachAlert.updateMany({
      where: {
        client_id: { in: ids },
        coach_id: others,
        alert_type: { in: [...MOVED_CLIENT_SAFETY_ALERT_TYPES] },
        acknowledged_at: null,
      },
      data: { coach_id: newCoachId },
    });
  }
  await tx.coachAlert.deleteMany({ where: { client_id: { in: ids }, coach_id: others } });
  if (formerCoachId !== newCoachId) {
    await tx.notification.deleteMany({ where: { user_id: formerCoachId, OR: inboxRowsAbout(ids) } });
  }
  await tx.wearableInsightCache.deleteMany({
    where: {
      user_id: { in: ids },
      side: { startsWith: 'coach' },
      ...(newCoachId === null ? {} : { NOT: { side: `coach:${newCoachId}` } }),
    },
  });
}

/**
 * Owner 4 for a sub-coach handoff: the client stays the head coach's, so only
 * `holderId` loses their inbox rows and coach-side insight about them (and the
 * shared 'coach' insight row, whose coach is unknown). Alerts belong to the
 * client's coach of record, the head coach, so a handoff leaves them.
 */
export async function deleteCoachRowsHeldBy(
  tx: Prisma.TransactionClient,
  clientId: string,
  holderId: string,
): Promise<void> {
  await tx.notification.deleteMany({ where: { user_id: holderId, OR: inboxRowsAbout([clientId]) } });
  await tx.wearableInsightCache.deleteMany({
    where: { user_id: clientId, side: { in: ['coach', `coach:${holderId}`] } },
  });
}

export interface LockedClientRow {
  id: string;
  coach_id: string | null;
  role: string;
  deleted_at: Date | null;
}

/**
 * Owner decision 17, write side: a draft that finishes after its client
 * moved is not saved for the old coach. Reads the clients' User rows FOR
 * SHARE in the caller's transaction, before its re-check and its write.
 * Every coach change UPDATEs that row, so it either committed first (the
 * re-check sees the new coach) or waits until the draft commits (and the
 * move's delete then finds it).
 */
export async function lockClientsForDraftWrite(
  tx: Prisma.TransactionClient,
  clientIds: readonly string[],
): Promise<LockedClientRow[]> {
  const ids = [...new Set(clientIds)].sort();
  if (ids.length === 0) return [];
  return tx.$queryRaw<LockedClientRow[]>`
    SELECT "id", "coach_id", "role"::text AS "role", "deleted_at"
    FROM "User" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR SHARE`;
}

/** The locked row is a live client whose coach is `coachId`. */
export function isClientOf(row: LockedClientRow | undefined, coachId: string): boolean {
  return row?.coach_id === coachId && row.role === 'student' && row.deleted_at === null;
}
