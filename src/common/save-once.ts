import { NotFoundException } from '@nestjs/common';

/**
 * WATER-WEIGHT-KEYS-BE (#191-D3 op 1): one stored row per one-time key
 * (client_uuid), for a save the phone may send twice after a lost answer.
 * The rule is food's (src/log/log.service.ts logFood, AUTHB-03):
 *
 * - The key is unique across all members, so the stored row is looked up
 *   first. This member's row comes back as stored (the first save wins, even
 *   if the resend carries a different amount) and `create` never runs, so
 *   none of a new save's effects (which live in `create`, after the insert)
 *   run again.
 * - Another member's row is never returned, changed or named: 404 with food's
 *   answer, the same as an entry that does not exist.
 * - Two sends at once both miss the lookup; the unique index lets one insert
 *   win and refuses the other (Prisma P2002), and the loser re-reads the
 *   winner under the same owner rule.
 *
 * `create` runs only when no row holds the key, and its effects only after
 * its insert succeeds.
 *
 * `onResend` runs when the answer is this member's row that was already
 * stored (a resend, or the loser of two sends at once): nothing new was saved.
 * The caller uses it to skip the request's own after-write effects, such as the
 * global Roman context bust (keepRomanContextFor in
 * src/roman/context/roman-context-invalidation.ts). It never changes the answer.
 */
export async function saveOnce<T extends { user_id: string }>(
  userId: string,
  findByKey: () => Promise<T | null>,
  create: () => Promise<T>,
  onResend?: () => void,
): Promise<T> {
  const stored = (row: T | null): T => {
    if (!row || row.user_id !== userId) throw new NotFoundException('Entry not found');
    onResend?.();
    return row;
  };
  const first = await findByKey();
  if (first) return stored(first);
  try {
    return await create();
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== 'P2002') throw err;
    return stored(await findByKey());
  }
}
