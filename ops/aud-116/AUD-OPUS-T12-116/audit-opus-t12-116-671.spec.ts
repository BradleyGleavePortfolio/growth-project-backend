// AUDIT PROBE (AUD-OPUS-T12-116, Claude Opus 5.5 lens) on backend #671 @ a6a2b589.
// Probe only: never merge. A red test is the counterexample cited in the verdict.
import { TrialUsageService } from '../src/packages/trials/trial-usage.service';
import {
  SUBSCRIPTION_CHECKOUT_OWNER,
  TrialCheckoutCapability,
} from '../src/packages/trials/trial-checkout-capability';
import { purchaseTrialView } from '../src/packages/trials/trial-view';
import { makeTrialUsageTable, stub } from './utils/trial-fakes';

function setup() {
  const table = makeTrialUsageTable();
  const prisma = { packageTrialUsage: table };
  const capability = new TrialCheckoutCapability();
  capability.register(SUBSCRIPTION_CHECKOUT_OWNER);
  const service = new TrialUsageService(
    stub<ConstructorParameters<typeof TrialUsageService>[0]>(prisma),
    capability,
  );
  const db = stub<Parameters<TrialUsageService['markStarted']>[0]>(prisma);
  return { table, service, db };
}

const start = {
  purchaseId: 'pur-1',
  clientUserId: 'client-1',
  coachUserId: 'coach-1',
  packageId: 'pkg-1',
  trialDays: 7,
  trialEndsAt: new Date('2026-10-12T17:00:00Z'),
};

describe('PROBE B-671-1 — a duplicate start of one purchase is not a second trial', () => {
  it('two concurrent markStarted for the same purchase with no reservation both own the trial', async () => {
    const { table, service, db } = setup();
    // e.g. customer.subscription.updated and invoice.paid for one subscription,
    // processed in two webhook transactions at once.
    const outcomes = await Promise.all([
      service.markStarted(db, start),
      service.markStarted(db, start),
    ]);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0].purchase_id).toBe('pur-1');
    expect(outcomes).toEqual(['owned', 'owned']);
  });

  it('control: a different purchase starting at the same time still loses', async () => {
    const { table, service, db } = setup();
    const outcomes = await Promise.all([
      service.markStarted(db, start),
      service.markStarted(db, { ...start, purchaseId: 'pur-2', packageId: 'pkg-2' }),
    ]);
    expect(table.rows).toHaveLength(1);
    expect([...outcomes].sort()).toEqual(['conflict', 'owned']);
  });
});

describe('PROBE C-671-1 — a trial that never started does not read as ended', () => {
  it('a pending reservation with trial_days reads none (or setup_incomplete), not ended', () => {
    const view = purchaseTrialView(
      {
        status: 'pending',
        entitlement_active: false,
        amount_cents: 4900,
        currency: 'usd',
        cancel_at_period_end: false,
        trial_days: 7,
        trial_ends_at: null,
      },
      new Date('2026-10-05T17:00:00Z'),
    );
    expect(['none', 'setup_incomplete']).toContain(view.state);
  });
});
