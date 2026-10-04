import { TrialUsageService } from '../src/packages/trials/trial-usage.service';
import { makeTrialUsageTable, stub } from './utils/trial-fakes';

describe('AUD-SOL-T12-116 — same-purchase start concurrency', () => {
  it('two distinct events starting one previously unreserved purchase both report owned', async () => {
    const table = makeTrialUsageTable();
    const db = { packageTrialUsage: table };
    const service = new TrialUsageService(
      stub<ConstructorParameters<typeof TrialUsageService>[0]>(db),
    );
    const args = {
      clientUserId: 'client-a',
      coachUserId: 'coach-a',
      packageId: 'pkg-a',
      purchaseId: 'purchase-a',
      trialDays: 7,
      trialEndsAt: new Date('2026-10-12T17:00:00Z'),
    };
    const outcomes = await Promise.all([
      service.markStarted(stub<Parameters<TrialUsageService['markStarted']>[0]>(db), args),
      service.markStarted(stub<Parameters<TrialUsageService['markStarted']>[0]>(db), args),
    ]);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toMatchObject({ purchase_id: args.purchaseId, status: 'started' });
    expect(outcomes).toEqual(['owned', 'owned']);
  });
});
