/**
 * r50 DunningService — state machine unit tests.
 *
 * No DB; the in-memory Prisma stub mimics dunningCase + findUnique
 * exactly enough for the service logic to exercise every transition.
 */

import { ConflictException } from '@nestjs/common';
import type { DunningCase, DunningCaseState } from '@prisma/client';
import {
  DunningService,
  RETRY_OFFSETS,
  isTransitionAllowed,
} from '../../src/dunning/dunning.service';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function freshCase(overrides: Partial<DunningCase> = {}): DunningCase {
  const now = new Date();
  return {
    id: 'case-1',
    coach_id: 'coach-1',
    stripe_subscription_id: 'sub_1',
    stripe_customer_id: 'cus_1',
    stripe_invoice_id: 'in_1',
    state: 'active',
    amount_cents: 1999,
    currency: 'usd',
    failure_reason: 'card_declined',
    failure_code: 'card_declined',
    retry_1_at: null,
    retry_2_at: null,
    retry_3_at: null,
    recovered_at: null,
    churned_at: null,
    opened_by_event_id: 'evt_open',
    created_at: now,
    updated_at: now,
    ...overrides,
  } as DunningCase;
}

function makePrisma(rows: DunningCase[]) {
  return {
    _rows: rows,
    dunningCase: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.id) return rows.find((r) => r.id === where.id) ?? null;
        if (where.stripe_subscription_id) {
          return (
            rows.find((r) => r.stripe_subscription_id === where.stripe_subscription_id) ??
            null
          );
        }
        return null;
      }),
      findFirst: jest.fn(async ({ where, orderBy }: any) => {
        let matched = rows.filter((r) => {
          if (where?.coach_id && r.coach_id !== where.coach_id) return false;
          if (where?.state?.in && !where.state.in.includes(r.state)) return false;
          return true;
        });
        if (orderBy?.updated_at === 'desc') {
          matched = [...matched].sort(
            (a, b) => +b.updated_at - +a.updated_at,
          );
        }
        return matched[0] ?? null;
      }),
      findMany: jest.fn(async ({ where, take }: any) => {
        const now = new Date();
        const matched = rows.filter((r) => {
          if (!where?.OR) return false;
          return where.OR.some((cond: any) => {
            if (r.state !== cond.state) return false;
            if (cond.retry_1_at?.lte && r.retry_1_at && r.retry_1_at <= cond.retry_1_at.lte) return true;
            if (cond.retry_2_at?.lte && r.retry_2_at && r.retry_2_at <= cond.retry_2_at.lte) return true;
            if (cond.retry_3_at?.lte && r.retry_3_at && r.retry_3_at <= cond.retry_3_at.lte) return true;
            return false;
          });
        });
        void now;
        return take ? matched.slice(0, take) : matched;
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = freshCase({
          ...(data as Partial<DunningCase>),
          id: `case-${rows.length + 1}`,
          created_at: new Date(),
          updated_at: new Date(),
        });
        rows.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const idx = rows.findIndex((r) => r.id === where.id);
        if (idx === -1) throw new Error('not found');
        rows[idx] = { ...rows[idx], ...data, updated_at: new Date() };
        return rows[idx];
      }),
    },
  };
}

function makeSvc(rows: DunningCase[] = []) {
  const prisma = makePrisma(rows);
  // No notifier — defaults to undefined so churned/recovered side
  // effects are skipped in unit tests.
  return { svc: new DunningService(prisma as any), prisma };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('DunningService — transition table', () => {
  const states: DunningCaseState[] = [
    'active',
    'retry_1_scheduled',
    'retry_2_scheduled',
    'retry_3_scheduled',
    'recovered',
    'churned',
  ];

  it('allows the documented forward edges', () => {
    expect(isTransitionAllowed('active', 'retry_1_scheduled')).toBe(true);
    expect(isTransitionAllowed('retry_1_scheduled', 'retry_2_scheduled')).toBe(true);
    expect(isTransitionAllowed('retry_2_scheduled', 'retry_3_scheduled')).toBe(true);
    expect(isTransitionAllowed('retry_3_scheduled', 'churned')).toBe(true);
  });

  it('allows recovery from any active state', () => {
    for (const s of ['active', 'retry_1_scheduled', 'retry_2_scheduled', 'retry_3_scheduled'] as DunningCaseState[]) {
      expect(isTransitionAllowed(s, 'recovered')).toBe(true);
    }
  });

  it('allows churn from any active state', () => {
    for (const s of ['active', 'retry_1_scheduled', 'retry_2_scheduled', 'retry_3_scheduled'] as DunningCaseState[]) {
      expect(isTransitionAllowed(s, 'churned')).toBe(true);
    }
  });

  it('allows re-open from terminal states back to active', () => {
    expect(isTransitionAllowed('recovered', 'active')).toBe(true);
    expect(isTransitionAllowed('churned', 'active')).toBe(true);
  });

  it('rejects self-loops', () => {
    for (const s of states) {
      expect(isTransitionAllowed(s, s)).toBe(false);
    }
  });

  it('rejects backwards retry transitions', () => {
    expect(isTransitionAllowed('retry_2_scheduled', 'retry_1_scheduled')).toBe(false);
    expect(isTransitionAllowed('retry_3_scheduled', 'retry_2_scheduled')).toBe(false);
    expect(isTransitionAllowed('retry_3_scheduled', 'retry_1_scheduled')).toBe(false);
  });

  it('rejects illegal direct hops', () => {
    // active cannot skip the retry_1 stage.
    expect(isTransitionAllowed('active', 'retry_2_scheduled')).toBe(false);
    expect(isTransitionAllowed('active', 'retry_3_scheduled')).toBe(false);
    // retry_1 cannot skip the retry_2 stage.
    expect(isTransitionAllowed('retry_1_scheduled', 'retry_3_scheduled')).toBe(false);
  });

  it('rejects transitions out of terminal states except re-open', () => {
    expect(isTransitionAllowed('recovered', 'retry_1_scheduled')).toBe(false);
    expect(isTransitionAllowed('recovered', 'churned')).toBe(false);
    expect(isTransitionAllowed('churned', 'recovered')).toBe(false);
    expect(isTransitionAllowed('churned', 'retry_3_scheduled')).toBe(false);
  });
});

describe('DunningService.openOrReopenCase', () => {
  it('creates a fresh case and schedules retry_1 ~1 day out', async () => {
    const { svc, prisma } = makeSvc();
    const before = Date.now();
    const c = await svc.openOrReopenCase({
      coachId: 'coach-1',
      stripeSubscriptionId: 'sub_new',
      stripeCustomerId: 'cus_new',
      stripeInvoiceId: 'in_new',
      amountCents: 4900,
      currency: 'usd',
      failureReason: 'card_declined',
      failureCode: 'card_declined',
      openedByEventId: 'evt_a',
    });
    expect(c.state).toBe('retry_1_scheduled');
    expect(c.retry_1_at).not.toBeNull();
    expect(c.retry_1_at!.getTime()).toBeGreaterThanOrEqual(before + RETRY_OFFSETS.retry1FromNow - 1000);
    expect(c.retry_1_at!.getTime()).toBeLessThanOrEqual(Date.now() + RETRY_OFFSETS.retry1FromNow + 1000);
    expect(prisma._rows).toHaveLength(1);
  });

  it('is idempotent on the same Stripe event id', async () => {
    const existing = freshCase({
      state: 'retry_2_scheduled',
      opened_by_event_id: 'evt_b',
    });
    const { svc, prisma } = makeSvc([existing]);
    const c = await svc.openOrReopenCase({
      coachId: 'coach-1',
      stripeSubscriptionId: 'sub_1',
      stripeCustomerId: 'cus_1',
      stripeInvoiceId: 'in_1',
      amountCents: 1999,
      currency: 'usd',
      failureReason: null,
      failureCode: null,
      openedByEventId: 'evt_b',
    });
    expect(c.id).toBe(existing.id);
    expect(c.state).toBe('retry_2_scheduled');
    expect(prisma.dunningCase.update).not.toHaveBeenCalled();
  });

  it('reopens a recovered case as retry_1_scheduled and clears terminal stamps', async () => {
    const existing = freshCase({
      state: 'recovered',
      recovered_at: new Date('2026-01-01'),
      retry_1_at: new Date('2025-01-01'),
      opened_by_event_id: 'evt_old',
    });
    const { svc } = makeSvc([existing]);
    const c = await svc.openOrReopenCase({
      coachId: 'coach-1',
      stripeSubscriptionId: 'sub_1',
      stripeCustomerId: null,
      stripeInvoiceId: 'in_new',
      amountCents: 3000,
      currency: 'usd',
      failureReason: 'insufficient_funds',
      failureCode: 'insufficient_funds',
      openedByEventId: 'evt_reopen',
    });
    expect(c.state).toBe('retry_1_scheduled');
    expect(c.recovered_at).toBeNull();
    expect(c.churned_at).toBeNull();
    expect(c.retry_2_at).toBeNull();
    expect(c.retry_3_at).toBeNull();
    expect(c.stripe_invoice_id).toBe('in_new');
  });

  it('updates a mid-cycle open case with the latest reason without changing state', async () => {
    const existing = freshCase({
      state: 'retry_2_scheduled',
      opened_by_event_id: 'evt_old',
      failure_reason: 'card_declined',
    });
    const { svc } = makeSvc([existing]);
    const c = await svc.openOrReopenCase({
      coachId: 'coach-1',
      stripeSubscriptionId: 'sub_1',
      stripeCustomerId: 'cus_1',
      stripeInvoiceId: 'in_1',
      amountCents: 1999,
      currency: 'usd',
      failureReason: 'insufficient_funds',
      failureCode: 'insufficient_funds',
      openedByEventId: 'evt_new',
    });
    expect(c.state).toBe('retry_2_scheduled');
    expect(c.failure_reason).toBe('insufficient_funds');
    expect(c.opened_by_event_id).toBe('evt_new');
  });
});

describe('DunningService.recordRetryFailure', () => {
  it('advances retry_1 → retry_2 + schedules retry_2_at ~3 days out', async () => {
    const c0 = freshCase({ state: 'retry_1_scheduled' });
    const { svc } = makeSvc([c0]);
    const after = await svc.recordRetryFailure(c0.id, 1);
    expect(after.state).toBe('retry_2_scheduled');
    expect(after.retry_2_at).not.toBeNull();
    expect(after.retry_2_at!.getTime()).toBeGreaterThan(
      Date.now() + RETRY_OFFSETS.retry2FromRetry1 - 1000,
    );
  });

  it('advances retry_2 → retry_3 + schedules retry_3_at ~7 days out', async () => {
    const c0 = freshCase({ state: 'retry_2_scheduled' });
    const { svc } = makeSvc([c0]);
    const after = await svc.recordRetryFailure(c0.id, 2);
    expect(after.state).toBe('retry_3_scheduled');
    expect(after.retry_3_at!.getTime()).toBeGreaterThan(
      Date.now() + RETRY_OFFSETS.retry3FromRetry2 - 1000,
    );
  });

  it('advances retry_3 → churned + stamps churned_at', async () => {
    const c0 = freshCase({ state: 'retry_3_scheduled' });
    const { svc } = makeSvc([c0]);
    const after = await svc.recordRetryFailure(c0.id, 3);
    expect(after.state).toBe('churned');
    expect(after.churned_at).not.toBeNull();
  });

  it('is a no-op when called with mismatched retry number', async () => {
    const c0 = freshCase({ state: 'retry_2_scheduled' });
    const { svc, prisma } = makeSvc([c0]);
    // Tick fires for retry_1 but the case has already advanced to retry_2.
    const after = await svc.recordRetryFailure(c0.id, 1);
    expect(after.state).toBe('retry_2_scheduled');
    expect(prisma.dunningCase.update).not.toHaveBeenCalled();
  });

  it('throws on missing case id', async () => {
    const { svc } = makeSvc();
    await expect(svc.recordRetryFailure('nope', 1)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('DunningService.recordRecovery + recordChurn', () => {
  it('recordRecovery closes an open case and stamps recovered_at', async () => {
    const c0 = freshCase({ state: 'retry_2_scheduled' });
    const { svc } = makeSvc([c0]);
    const after = await svc.recordRecovery(c0.stripe_subscription_id);
    expect(after!.state).toBe('recovered');
    expect(after!.recovered_at).not.toBeNull();
  });

  it('recordRecovery is a no-op on already-closed cases', async () => {
    const c0 = freshCase({
      state: 'recovered',
      recovered_at: new Date('2026-01-01'),
    });
    const { svc, prisma } = makeSvc([c0]);
    const after = await svc.recordRecovery(c0.stripe_subscription_id);
    expect(after!.state).toBe('recovered');
    expect(prisma.dunningCase.update).not.toHaveBeenCalled();
  });

  it('recordRecovery returns null when no case exists', async () => {
    const { svc } = makeSvc();
    const after = await svc.recordRecovery('sub_unknown');
    expect(after).toBeNull();
  });

  it('recordChurn closes the case as churned and stamps churned_at', async () => {
    const c0 = freshCase({ state: 'active' });
    const { svc } = makeSvc([c0]);
    const after = await svc.recordChurn(c0.stripe_subscription_id);
    expect(after!.state).toBe('churned');
    expect(after!.churned_at).not.toBeNull();
  });
});

describe('DunningService — coach + worker reads', () => {
  it('getActiveCaseForCoach returns the open case', async () => {
    const open = freshCase({ state: 'retry_2_scheduled' });
    const closed = freshCase({
      id: 'case-old',
      state: 'recovered',
      stripe_subscription_id: 'sub_old',
      updated_at: new Date(Date.now() - 86_400_000),
    });
    const { svc } = makeSvc([closed, open]);
    const out = await svc.getActiveCaseForCoach('coach-1');
    expect(out?.id).toBe(open.id);
  });

  it('getActiveCaseForCoach returns null when nothing is open', async () => {
    const closed = freshCase({ state: 'recovered' });
    const { svc } = makeSvc([closed]);
    expect(await svc.getActiveCaseForCoach('coach-1')).toBeNull();
  });

  it('findDueRetries returns only past-due retry_N_scheduled cases', async () => {
    const past = freshCase({
      id: 'case-past',
      state: 'retry_1_scheduled',
      retry_1_at: new Date(Date.now() - 60_000),
      stripe_subscription_id: 'sub_past',
    });
    const future = freshCase({
      id: 'case-future',
      state: 'retry_1_scheduled',
      retry_1_at: new Date(Date.now() + 86_400_000),
      stripe_subscription_id: 'sub_future',
    });
    const recovered = freshCase({
      id: 'case-rec',
      state: 'recovered',
      retry_1_at: new Date(Date.now() - 60_000),
      stripe_subscription_id: 'sub_rec',
    });
    const { svc } = makeSvc([past, future, recovered]);
    const due = await svc.findDueRetries(new Date());
    expect(due.map((c) => c.id)).toEqual(['case-past']);
  });
});
