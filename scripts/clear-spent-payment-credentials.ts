/**
 * scripts/clear-spent-payment-credentials.ts (C-661-2, B-661-14/15)
 *
 * Erases the cached PaymentSheet client secret and ephemeral key from every
 * ClientPurchase row whose sheet can no longer be used. Since #661 the
 * webhooks erase them on every success, grant and end; rows written before
 * that keep them at rest. A credential is still live (kept) only on:
 *   - a one-time PaymentIntent attempt in pending / payment_failed (the
 *     replay resumes the same PaymentIntent);
 *   - a native subscription attempt that never granted access (open status,
 *     not entitled, no trial started): an unpaid first invoice, a declined
 *     first attempt, or a trial whose card is not saved yet.
 *
 * Deploy window only, with operator approval. Dry run by default (counts,
 * writes nothing); `--apply` erases in bounded batches. Idempotent. Logs
 * counts only, never a credential.
 *
 *   npx ts-node scripts/clear-spent-payment-credentials.ts [--apply]
 */
import { PrismaClient, type Prisma } from '@prisma/client';
import { CLEARED_PAYMENT_SECRETS } from '../src/checkout/admin-purchase.select';
import { errorLabel } from '../src/checkout/error-label';
import { OPEN_ATTEMPT_STATUSES } from '../src/checkout/subscription-plan';

export const SPENT_PAYMENT_CREDENTIALS: Prisma.ClientPurchaseWhereInput = {
  OR: [{ stripe_client_secret: { not: null } }, { stripe_ephemeral_key: { not: null } }],
  NOT: [
    { stripe_subscription_id: null, status: { in: ['pending', 'payment_failed'] } },
    {
      stripe_subscription_id: { not: null },
      status: { in: [...OPEN_ATTEMPT_STATUSES] },
      entitlement_active: false,
      trial_started_at: null,
    },
  ],
};

export interface ClearSpentResult {
  matched: number;
  cleared: number;
  applied: boolean;
}

export async function clearSpentPaymentCredentials(
  prisma: Pick<PrismaClient, 'clientPurchase'>,
  opts: { apply: boolean; batchSize?: number },
): Promise<ClearSpentResult> {
  const matched = await prisma.clientPurchase.count({ where: SPENT_PAYMENT_CREDENTIALS });
  if (!opts.apply) return { matched, cleared: 0, applied: false };
  const take = Math.max(1, Math.min(opts.batchSize ?? 500, 5_000));
  let cleared = 0;
  for (;;) {
    const ids = await prisma.clientPurchase.findMany({
      where: SPENT_PAYMENT_CREDENTIALS,
      select: { id: true },
      orderBy: { id: 'asc' },
      take,
    });
    if (ids.length === 0) break;
    // The predicate is re-checked in the write: a row that changed since the
    // read is left to the webhook that changed it.
    const res = await prisma.clientPurchase.updateMany({
      where: { AND: [SPENT_PAYMENT_CREDENTIALS, { id: { in: ids.map((r) => r.id) } }] },
      data: CLEARED_PAYMENT_SECRETS,
    });
    cleared += res.count;
    if (ids.length < take) break;
  }
  return { matched, cleared, applied: true };
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const result = await clearSpentPaymentCredentials(prisma, {
      apply: process.argv.includes('--apply'),
    });
    console.log(`[clear-spent-payment-credentials] ${JSON.stringify(result)}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(`[clear-spent-payment-credentials] failed error=${errorLabel(err)}`);
    process.exit(1);
  });
}
