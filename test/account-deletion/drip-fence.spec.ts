/**
 * B-608-5: scheduled drip drops never fire for, or on behalf of, a deleted
 * account, even if a drop escaped the cancellation at finalization.
 */
import { DripDispatcherCron } from '../../src/packages/drip-dispatcher.cron';
import { NOT_DUNNING_LOCKED } from '../../src/checkout/dunning-v2/dunning-grace';
import type { PrismaService } from '../../src/prisma.service';
import type { AssignableAssetResolverRegistry } from '../../src/packages/asset-resolvers/assignable-asset-resolver.registry';

function stub<T>(value: unknown): T {
  return value as T;
}

describe('DripDispatcherCron deleted-account fence', () => {
  it('only selects drops to a live client on a purchase the client still holds, or a live coach\'s refund-stopped drop', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const cron = new DripDispatcherCron(
      stub<PrismaService>({ scheduledDrop: { findMany } }),
      stub<AssignableAssetResolverRegistry>({}),
    );
    await cron.runOnce(new Date('2026-10-01T03:00:00Z'));
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where.client_purchase).toEqual({
      client: { deleted_at: null },
      // PF-2-BE (LS-PAYFAIL B3): a purchase under its Day-10 lock is no longer picked to deliver.
      OR: [
        { entitlement_active: true, AND: [NOT_DUNNING_LOCKED] },
        { coach: { deleted_at: null }, status: { in: ['refunded', 'chargeback_lost'] } },
      ],
    });
  });
});
