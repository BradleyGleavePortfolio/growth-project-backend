import type { Prisma } from '@prisma/client';

// Payload keys that name the client an AI approval draft acts on. The same
// keys as PAYLOAD_CLIENT_ID_KEYS in src/ai/gateway/ai-approval.service.ts,
// which deciding a draft checks (test/moved-client-drafts.spec.ts pins them).
export const MOVED_CLIENT_PAYLOAD_KEYS = ['clientId', 'client_id', 'target_client_id'] as const;

/**
 * Owner decision 17: when a client moves to another coach, the drafts about
 * them that any other coach holds are deleted at once, in the transaction
 * that moves them. They are not frozen and never pass to the new coach.
 * Approved or sent items are history and stay (owner decision 4).
 *
 * For each moved client, held by anyone but `newCoachId`:
 *   - Coach AI drafts (AIDraft) that are not APPROVED;
 *   - AI approval drafts (AiActionDraft) in another coach's tenant that are
 *     not approved and name the client as subject or in the payload;
 *   - message composer drafts (MessageDraft), which are never sent;
 *   - re-engagement drafts (ChurnIntervention) that are not sent.
 *
 * Deleting again deletes nothing more, so a repeated move is harmless.
 */
export async function deleteDraftsLeftByMove(
  tx: Prisma.TransactionClient,
  clientIds: readonly string[],
  newCoachId: string,
): Promise<void> {
  if (clientIds.length === 0) return;
  const ids = [...clientIds];
  await tx.aIDraft.deleteMany({
    where: { clientId: { in: ids }, coachId: { not: newCoachId }, status: { not: 'APPROVED' } },
  });
  await tx.aiActionDraft.deleteMany({
    where: {
      status: { not: 'approved' },
      AND: [{ tenant_coach_id: { not: null } }, { tenant_coach_id: { not: newCoachId } }],
      OR: [
        { subject_user_id: { in: ids } },
        ...ids.flatMap((id) => MOVED_CLIENT_PAYLOAD_KEYS.map((key) => ({ payload: { path: [key], equals: id } }))),
      ],
    },
  });
  await tx.messageDraft.deleteMany({
    where: { client_id: { in: ids }, coach_id: { not: newCoachId } },
  });
  await tx.churnIntervention.deleteMany({
    where: { client_id: { in: ids }, coach_id: { not: newCoachId }, status: { not: 'sent' } },
  });
}
