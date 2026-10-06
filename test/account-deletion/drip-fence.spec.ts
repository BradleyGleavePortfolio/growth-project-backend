/**
 * B-608-5: scheduled drip drops never fire for, or on behalf of, a deleted
 * account, even if a drop escaped the cancellation at finalization.
 */
import { DripDispatcherCron } from '../../src/packages/drip-dispatcher.cron';
import type { PrismaService } from '../../src/prisma.service';
import type { AssignableAssetResolverRegistry } from '../../src/packages/asset-resolvers/assignable-asset-resolver.registry';

function stub<T>(value: unknown): T {
  return value as T;
}

describe('DripDispatcherCron deleted-account fence', () => {
  it('only selects drops whose client and coach are both live accounts', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const cron = new DripDispatcherCron(
      stub<PrismaService>({ scheduledDrop: { findMany } }),
      stub<AssignableAssetResolverRegistry>({}),
    );
    await cron.runOnce(new Date('2026-10-01T03:00:00Z'));
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where.client_purchase).toEqual({
      client: { deleted_at: null },
      coach: { deleted_at: null },
    });
  });
});
