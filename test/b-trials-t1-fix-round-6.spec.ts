// B-T12-116 (trials T1 fix round 6) — regressions for the audit findings on
// backend #671 @ a6a2b589:
//   B-671-1 (Sol + Opus)  concurrent starts of the SAME unreserved purchase
//                         must both read 'owned' (the loser of the skipped
//                         insert or of the released-row takeover was reported
//                         as a cross-purchase 'conflict', which T3 turns into
//                         a cancellation of a legitimate trial);
//   C-671-1 (Opus)        a purchase whose trial never started reads 'none',
//                         never 'ended' ("The trial is over");
//   C-671-3 (Opus)        trial amounts use the currency's own minor unit
//                         (4900 JPY is 4,900 yen, not 49);
//   C-672-5 (Opus, copy)  the charge line says "plus any tax" when Stripe
//                         may add tax to the trial-end invoice (operator
//                         ruling 2026-10-03); the copy lives in T1.
// The in-memory table (test/utils/trial-fakes.ts) yields to the event loop on
// every call, so Promise.all() interleaves two callers statement by
// statement. The same races on real Postgres, in separate transactions, are
// in test/b-trials-usage-concurrency.live.spec.ts (mwb-3-live-tests job).
import { TrialUsageService } from '../src/packages/trials/trial-usage.service';
import { formatTrialAmount, trialEndingCopy } from '../src/packages/trials/trial-copy';
import { purchaseTrialView } from '../src/packages/trials/trial-view';
import { makeTrialUsageTable, stub } from './utils/trial-fakes';

type Db = Parameters<TrialUsageService['markStarted']>[0];

function setup() {
  const table = makeTrialUsageTable();
  const prisma = { packageTrialUsage: table };
  const service = new TrialUsageService(
    stub<ConstructorParameters<typeof TrialUsageService>[0]>(prisma),
  );
  return { table, prisma, service, db: stub<Db>(prisma) };
}

const END = new Date('2026-10-12T17:00:00Z');
const start = {
  clientUserId: 'client-1',
  coachUserId: 'coach-1',
  packageId: 'pkg-1',
  purchaseId: 'pur-1',
  trialDays: 7,
  trialEndsAt: END,
};

describe('B-671-1 — concurrent starts of one purchase are never a second trial', () => {
  it('two concurrent starts of one unreserved purchase both own the trial (one started row)', async () => {
    const { service, db, table } = setup();
    const outcomes = await Promise.all([
      service.markStarted(db, start),
      service.markStarted(db, start),
    ]);
    expect(outcomes).toEqual(['owned', 'owned']);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toMatchObject({ purchase_id: 'pur-1', status: 'started' });
  });

  it('three concurrent starts of one unreserved purchase all own the trial', async () => {
    const { service, db, table } = setup();
    const outcomes = await Promise.all([
      service.markStarted(db, start),
      service.markStarted(db, start),
      service.markStarted(db, start),
    ]);
    expect(outcomes).toEqual(['owned', 'owned', 'owned']);
    expect(table.rows).toHaveLength(1);
  });

  it('a lost takeover of a released row by the same purchase still owns the trial', async () => {
    const { service, db, table } = setup();
    await table.createMany({
      data: [
        {
          client_user_id: 'client-1',
          coach_user_id: 'coach-1',
          package_id: 'pkg-old',
          purchase_id: 'pur-old',
          trial_days: 7,
          status: 'released',
          released_at: new Date(),
          release_reason: 'abandoned',
        },
      ],
    });
    const outcomes = await Promise.all([
      service.markStarted(db, start),
      service.markStarted(db, start),
    ]);
    expect(outcomes).toEqual(['owned', 'owned']);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toMatchObject({
      purchase_id: 'pur-1',
      status: 'started',
      released_at: null,
    });
  });

  it('a reservation for the same purchase that commits between the read and the insert is started, not refused', async () => {
    const { service, prisma, table } = setup();
    let injected = false;
    // The reserve() of this purchase commits right after markStarted read
    // "no row for this purchase" and before its own insert.
    const racing = {
      packageTrialUsage: {
        ...table,
        findUnique: async (args: { where: Record<string, unknown> }) => {
          const row = await table.findUnique(args);
          if (!injected && 'purchase_id' in args.where) {
            injected = true;
            await service.reserve(stub<Db>(prisma), {
              clientUserId: 'client-1',
              coachUserId: 'coach-1',
              packageId: 'pkg-1',
              purchaseId: 'pur-1',
              trialDays: 7,
            });
          }
          return row;
        },
      },
    };
    expect(await service.markStarted(stub<Db>(racing), start)).toBe('owned');
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toMatchObject({ purchase_id: 'pur-1', status: 'started' });
    expect((table.rows[0].trial_ends_at as Date).toISOString()).toBe(END.toISOString());
  });

  it('control: a different purchase in the same race is still a conflict', async () => {
    const { service, db, table } = setup();
    const outcomes = await Promise.all([
      service.markStarted(db, start),
      service.markStarted(db, { ...start, purchaseId: 'pur-2' }),
    ]);
    expect([...outcomes].sort()).toEqual(['conflict', 'owned']);
    expect(table.rows).toHaveLength(1);
  });

  it('control: a different purchase losing the released-row takeover is still a conflict', async () => {
    const { service, db, table } = setup();
    await table.createMany({
      data: [
        {
          client_user_id: 'client-1',
          coach_user_id: 'coach-1',
          package_id: 'pkg-old',
          purchase_id: 'pur-old',
          trial_days: 7,
          status: 'released',
        },
      ],
    });
    const outcomes = await Promise.all([
      service.markStarted(db, start),
      service.markStarted(db, { ...start, purchaseId: 'pur-2' }),
    ]);
    expect([...outcomes].sort()).toEqual(['conflict', 'owned']);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0].status).toBe('started');
  });
});

describe('C-671-1 — a trial that never started never reads "ended"', () => {
  const row = {
    status: 'pending',
    entitlement_active: false,
    amount_cents: 4900,
    currency: 'usd',
    cancel_at_period_end: false,
    trial_days: 7,
    trial_ends_at: null,
  };
  const NOW = new Date('2026-10-09T17:00:00Z');

  it('a checkout reservation (pending, trial days, no trial end) reads none', () => {
    expect(purchaseTrialView(row, NOW)).toMatchObject({
      state: 'none',
      trial_days: 7,
      ends_at: null,
      will_charge: false,
    });
  });

  it('an expired or failed attempt that never started reads none', () => {
    for (const status of ['incomplete_expired', 'incomplete', 'failed', 'canceled']) {
      expect(purchaseTrialView({ ...row, status }, NOW).state).toBe('none');
    }
  });

  it('control: a trial that started and is over still reads ended', () => {
    expect(
      purchaseTrialView(
        {
          ...row,
          status: 'active',
          entitlement_active: true,
          trial_ends_at: new Date('2026-10-01T00:00:00Z'),
        },
        NOW,
      ).state,
    ).toBe('ended');
  });
});

describe('C-671-3 — trial amounts use the currency minor unit', () => {
  it('zero-decimal currencies are not divided by 100', () => {
    expect(formatTrialAmount(4900, 'jpy')).toBe('¥4,900');
    expect(formatTrialAmount(4900, 'krw')).toBe('₩4,900');
  });

  it('two-decimal currencies keep the existing format', () => {
    expect(formatTrialAmount(4900, 'usd')).toBe('$49');
    expect(formatTrialAmount(4999, 'usd')).toBe('$49.99');
    expect(formatTrialAmount(4900, 'gbp')).toBe('£49');
  });

  it('an unknown currency code still prints the amount with its code', () => {
    expect(formatTrialAmount(4999, 'zzz')).toMatch(/49\.99/);
  });
});

describe('C-672-5 — the charge line names tax when tax may apply', () => {
  const input = {
    trialEndsAt: END,
    amountCents: 4900,
    currency: 'usd',
    timeZone: 'America/New_York',
    cancelAtPeriodEnd: false,
    cardOnFile: true,
  };
  const copyInput = (extra: Record<string, unknown>) =>
    stub<Parameters<typeof trialEndingCopy>[0]>({ ...input, ...extra });

  it('tax may apply: "plus any tax"', () => {
    expect(trialEndingCopy(copyInput({ taxMayApply: true })).body).toBe(
      'Your free trial ends on Oct 12. Your card will be charged $49 plus any tax then. Cancel anytime before.',
    );
  });

  it('control: no tax keeps the exact existing line; no-charge lines never mention tax', () => {
    expect(trialEndingCopy(input).body).toBe(
      'Your free trial ends on Oct 12. Your card will be charged $49 then. Cancel anytime before.',
    );
    expect(trialEndingCopy(copyInput({ taxMayApply: true, cardOnFile: false })).body).not.toMatch(
      /tax/,
    );
    expect(
      trialEndingCopy(copyInput({ taxMayApply: true, cancelAtPeriodEnd: true })).body,
    ).not.toMatch(/tax/);
  });
});
