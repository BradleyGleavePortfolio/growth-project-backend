import type { Prisma } from '@prisma/client';
import { NotificationKind } from '../../notifications/notification-kind';
import type { PrismaService } from '../../prisma.service';

// SWITCH-TELL-BE (agent 167). Owner 10-21 16:5x "#SWITCH-TELL - b - both":
// when a client moves to TGP's house coach, the coach they left gets one
// in-app notification and a quiet line in Money. The new coach is never named
// or linked: the body names only the client, the payload carries only the
// client's id (no deep link, no push).

/**
 * The notification body (max 160 characters, so a long name is cut). Words
 * approved: owner 10-22 16:2x "W-168-STM - approved" (6353564347 on m#869;
 * STM-5 comma: OPERATOR RULING 6353623610).
 */
export function switchTellBody(clientName: string | null | undefined): string {
  const name = (clientName ?? '').trim().slice(0, 120) || 'A client';
  return `${name} has moved to another coach.`;
}

/**
 * Inside the move's transaction, right after the client's coach_id changed:
 * one in-app row for the former coach. A replayed payment moves nothing, so
 * it writes nothing. Its created_at is the move date the Money line shows.
 * FR-1154 (owner #171-3): "Mute all notifications" never stops an in-app row,
 * so a muted coach sees it in the inbox and badge like any other coach.
 */
export async function tellFormerCoachTx(
  tx: Prisma.TransactionClient,
  clientUserId: string,
  formerCoachId: string,
): Promise<void> {
  const client = await tx.user.findUnique({ where: { id: clientUserId }, select: { name: true } });
  await tx.notification.create({
    data: {
      user_id: formerCoachId,
      kind: NotificationKind.COACH_CLIENT_MOVED,
      channel: 'inapp',
      deep_link: null,
      body: switchTellBody(client?.name),
      payload: { client_id: clientUserId },
    },
  });
}

/**
 * The Money line ("Moved to another coach · {date}"): for clients who moved
 * away from `coachId`, when the latest move to the house coach told them.
 * Read from the coach's own notifications only; other moves have no date.
 */
export async function movedAwayDates(
  prisma: PrismaService,
  coachId: string,
  movedIds: Iterable<string>,
): Promise<Map<string, Date>> {
  const ids = [...new Set(movedIds)].filter((id) => !!id);
  const dates = new Map<string, Date>();
  if (ids.length === 0) return dates;
  const told = await prisma.notification.findMany({
    where: {
      user_id: coachId,
      kind: NotificationKind.COACH_CLIENT_MOVED,
      OR: ids.map((id) => ({ payload: { path: ['client_id'], equals: id } })),
    },
    orderBy: { created_at: 'desc' },
    select: { payload: true, created_at: true },
  });
  for (const row of told) {
    const payload = row.payload;
    const id =
      payload && typeof payload === 'object' && !Array.isArray(payload) ? payload.client_id : null;
    if (typeof id === 'string' && !dates.has(id)) dates.set(id, row.created_at);
  }
  return dates;
}
