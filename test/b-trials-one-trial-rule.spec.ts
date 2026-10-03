// B-TRIALS (OR-113-2) — one free trial per client per coach, enforced
// server-side, including races. Runs TrialUsageService against an in-memory
// table with the migration's unique constraints (test/utils/trial-fakes.ts).
import { ConflictException } from '@nestjs/common';
import {
  TRIAL_RESERVATION_STALE_MS,
  TrialUsageService,
} from '../src/packages/trials/trial-usage.service';
import { makeTrialUsageTable, stub } from './utils/trial-fakes';

function setup() {
  const table = makeTrialUsageTable();
  const prisma = { packageTrialUsage: table };
  const service = new TrialUsageService(
    stub<ConstructorParameters<typeof TrialUsageService>[0]>(prisma),
  );
  const db = stub<Parameters<TrialUsageService['reserve']>[0]>(prisma);
  return { table, service, db };
}

const base = { clientUserId: 'client-1', coachUserId: 'coach-1', packageId: 'pkg-1', trialDays: 7 };

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    expect(err).toBeInstanceOf(ConflictException);
    return ((err as ConflictException).getResponse() as { code: string }).code;
  }
}

describe('B-TRIALS — TrialUsageService.reserve', () => {
  it('reserves the first trial and returns the days to send to Stripe', async () => {
    const { service, db, table } = setup();
    expect(await service.reserve(db, { ...base, purchaseId: 'pur-1' })).toEqual({ trial_days: 7 });
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toMatchObject({
      status: 'reserved',
      purchase_id: 'pur-1',
      trial_days: 7,
    });
  });

  it('a package without a trial reserves nothing', async () => {
    const { service, db, table } = setup();
    expect(await service.reserve(db, { ...base, trialDays: 0, purchaseId: 'pur-1' })).toEqual({
      trial_days: 0,
    });
    expect(table.rows).toHaveLength(0);
  });

  it('is idempotent for the same purchase (retry after a timeout, double tap)', async () => {
    const { service, db, table } = setup();
    await service.reserve(db, { ...base, purchaseId: 'pur-1' });
    expect(await service.reserve(db, { ...base, purchaseId: 'pur-1' })).toEqual({ trial_days: 7 });
    const both = await Promise.all([
      service.reserve(db, { ...base, purchaseId: 'pur-1' }),
      service.reserve(db, { ...base, purchaseId: 'pur-1' }),
    ]);
    expect(both).toEqual([{ trial_days: 7 }, { trial_days: 7 }]);
    expect(table.rows).toHaveLength(1);
  });

  it('refuses a second trial with the same coach once the first started (TRIAL_ALREADY_USED)', async () => {
    const { service, db } = setup();
    await service.reserve(db, { ...base, purchaseId: 'pur-1' });
    expect(
      await service.markStarted(db, {
        ...base,
        purchaseId: 'pur-1',
        trialEndsAt: new Date(Date.now() + 7 * 864e5),
      }),
    ).toBe('owned');
    expect(
      await codeOf(service.reserve(db, { ...base, packageId: 'pkg-2', purchaseId: 'pur-2' })),
    ).toBe('TRIAL_ALREADY_USED');
  });

  it('cancelling during the trial does not give the trial back', async () => {
    const { service, db } = setup();
    await service.reserve(db, { ...base, purchaseId: 'pur-1' });
    await service.markStarted(db, { ...base, purchaseId: 'pur-1', trialEndsAt: new Date() });
    expect(await service.release(db, 'pur-1', 'subscription_deleted')).toBe(false);
    expect(await codeOf(service.reserve(db, { ...base, purchaseId: 'pur-2' }))).toBe(
      'TRIAL_ALREADY_USED',
    );
  });

  it('a trial with a different coach is independent', async () => {
    const { service, db } = setup();
    await service.reserve(db, { ...base, purchaseId: 'pur-1' });
    await service.markStarted(db, { ...base, purchaseId: 'pur-1', trialEndsAt: new Date() });
    expect(
      await service.reserve(db, {
        ...base,
        coachUserId: 'coach-2',
        packageId: 'pkg-9',
        purchaseId: 'pur-9',
      }),
    ).toEqual({ trial_days: 7 });
  });

  it('a fresh reservation held by another attempt answers TRIAL_IN_PROGRESS', async () => {
    const { service, db } = setup();
    await service.reserve(db, { ...base, purchaseId: 'pur-1' });
    expect(
      await codeOf(service.reserve(db, { ...base, packageId: 'pkg-2', purchaseId: 'pur-2' })),
    ).toBe('TRIAL_IN_PROGRESS');
  });

  it('an abandoned (stale) or released reservation is taken over by the next attempt', async () => {
    const { service, db, table } = setup();
    await service.reserve(db, { ...base, purchaseId: 'pur-1' });
    table.rows[0].reserved_at = new Date(Date.now() - TRIAL_RESERVATION_STALE_MS - 1000);
    expect(await service.reserve(db, { ...base, packageId: 'pkg-2', purchaseId: 'pur-2' })).toEqual(
      { trial_days: 7 },
    );
    expect(table.rows[0]).toMatchObject({
      purchase_id: 'pur-2',
      status: 'reserved',
      package_id: 'pkg-2',
    });

    expect(await service.release(db, 'pur-2', 'sheet_abandoned')).toBe(true);
    expect(table.rows[0].status).toBe('released');
    expect(await service.reserve(db, { ...base, purchaseId: 'pur-3' })).toEqual({ trial_days: 7 });
    expect(table.rows).toHaveLength(1);
  });

  it('RACE: two concurrent attempts for two packages of the same coach — exactly one gets the trial', async () => {
    const { service, db, table } = setup();
    const results = await Promise.allSettled([
      service.reserve(db, { ...base, packageId: 'pkg-1', purchaseId: 'pur-a' }),
      service.reserve(db, { ...base, packageId: 'pkg-2', purchaseId: 'pur-b' }),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(
      ((lost[0] as PromiseRejectedResult).reason as ConflictException).getResponse(),
    ).toMatchObject({
      code: 'TRIAL_IN_PROGRESS',
    });
    expect(table.rows).toHaveLength(1);
  });

  it('RACE: two concurrent takeovers of one stale reservation — exactly one wins', async () => {
    const { service, db, table } = setup();
    await service.reserve(db, { ...base, purchaseId: 'pur-1' });
    table.rows[0].reserved_at = new Date(Date.now() - TRIAL_RESERVATION_STALE_MS - 1000);
    const results = await Promise.allSettled([
      service.reserve(db, { ...base, purchaseId: 'pur-a' }),
      service.reserve(db, { ...base, purchaseId: 'pur-b' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(['pur-a', 'pur-b']).toContain(table.rows[0].purchase_id);
  });
});

describe('B-TRIALS — TrialUsageService.markStarted', () => {
  it('records a trial minted without a reservation', async () => {
    const { service, db, table } = setup();
    expect(
      await service.markStarted(db, { ...base, purchaseId: 'pur-1', trialEndsAt: new Date() }),
    ).toBe('owned');
    expect(table.rows[0]).toMatchObject({ status: 'started', purchase_id: 'pur-1' });
  });

  it('reports a conflict when another purchase already holds the trial', async () => {
    const { service, db } = setup();
    await service.reserve(db, { ...base, purchaseId: 'pur-1' });
    await service.markStarted(db, { ...base, purchaseId: 'pur-1', trialEndsAt: new Date() });
    expect(
      await service.markStarted(db, { ...base, purchaseId: 'pur-2', trialEndsAt: new Date() }),
    ).toBe('conflict');
  });

  it('a stale attempt whose reservation was taken over cannot start (conflict)', async () => {
    const { service, db, table } = setup();
    await service.reserve(db, { ...base, purchaseId: 'pur-old' });
    table.rows[0].reserved_at = new Date(Date.now() - TRIAL_RESERVATION_STALE_MS - 1000);
    await service.reserve(db, { ...base, purchaseId: 'pur-new' });
    await service.markStarted(db, { ...base, purchaseId: 'pur-new', trialEndsAt: new Date() });
    expect(
      await service.markStarted(db, { ...base, purchaseId: 'pur-old', trialEndsAt: new Date() }),
    ).toBe('conflict');
  });

  it('RACE: two subscriptions starting at once — exactly one owns the trial', async () => {
    const { service, db } = setup();
    const outcomes = await Promise.all([
      service.markStarted(db, { ...base, purchaseId: 'pur-a', trialEndsAt: new Date() }),
      service.markStarted(db, { ...base, purchaseId: 'pur-b', trialEndsAt: new Date() }),
    ]);
    expect(outcomes.sort()).toEqual(['conflict', 'owned']);
  });

  it('replays are idempotent and keep the latest trial end', async () => {
    const { service, db, table } = setup();
    await service.markStarted(db, {
      ...base,
      purchaseId: 'pur-1',
      trialEndsAt: new Date('2026-10-12T00:00:00Z'),
    });
    const later = new Date('2026-10-15T00:00:00Z');
    expect(
      await service.markStarted(db, { ...base, purchaseId: 'pur-1', trialEndsAt: later }),
    ).toBe('owned');
    expect((table.rows[0].trial_ends_at as Date).toISOString()).toBe(later.toISOString());
  });
});

describe('B-TRIALS — offersForClient', () => {
  it('offers the trial unless this client started one with the coach', async () => {
    const { service, db } = setup();
    const pkgs = [
      { id: 'pkg-1', coach_id: 'coach-1', trial_days: 7 },
      { id: 'pkg-2', coach_id: 'coach-1', trial_days: 0 },
      { id: 'pkg-3', coach_id: 'coach-2', trial_days: 14 },
    ];
    let offers = await service.offersForClient('client-1', pkgs);
    expect(offers.get('pkg-1')).toEqual({ trial_days: 7, available: true, reason: 'offered' });
    expect(offers.get('pkg-2')).toEqual({ trial_days: 0, available: false, reason: 'none' });

    await service.markStarted(db, { ...base, purchaseId: 'pur-1', trialEndsAt: new Date() });
    offers = await service.offersForClient('client-1', pkgs);
    expect(offers.get('pkg-1')).toEqual({
      trial_days: 7,
      available: false,
      reason: 'already_used',
    });
    expect(offers.get('pkg-3')?.available).toBe(true);
    // A pending (reserved, not started) attempt still shows the trial.
    const other = await service.offersForClient('client-2', pkgs);
    expect(other.get('pkg-1')?.available).toBe(true);
  });
});
