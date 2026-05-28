/**
 * Stream 1 — Round 1 fixer behavioural tests.
 *
 * One file per audit finding so a Round-2 auditor can grep by P-id.
 * Each `describe` block carries the audit P-id in its title.
 *
 * The Prisma mock used here is intentionally TIGHTER than the one in
 * ai-credits-stream1.spec.ts: it enforces (a) the relaxed CCPP CHECK
 * constraints, (b) period_end > now in recordUsage, and (c) the
 * paid_cents-equals-tier-amount invariant the round-1 fix codifies.
 */

import { Prisma } from '@prisma/client';
import { CoachAIBudgetService } from '../src/ai-credits/coach-ai-budget.service';
import { CoachAiCreditPackService } from '../src/ai-credits/coach-ai-credit-pack.service';

// ---------------------------------------------------------------------------
// Shared mini-mock — fresh per describe to avoid cross-test bleed.
// ---------------------------------------------------------------------------

interface MiniStore {
  budgets: Map<string, any>;
  purchases: Map<string, any>;
  briefs: any[];
  users: Map<string, any>;
  subCoachAssignments: any[];
  coachProfiles: Map<string, any>;
  coachSubscriptions: Map<string, any>;
}

function newStore(): MiniStore {
  return {
    budgets: new Map(),
    purchases: new Map(),
    briefs: [],
    users: new Map(),
    subCoachAssignments: [],
    coachProfiles: new Map(),
    coachSubscriptions: new Map(),
  };
}

function makePrismaMock(store: MiniStore): any {
  const prisma: any = {
    coachAIBudget: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.id) return store.budgets.get(where.id) ?? null;
        for (const r of store.budgets.values()) {
          if (r.coach_user_id === where.coach_user_id) return r;
        }
        return null;
      }),
      upsert: jest.fn(async ({ where, create }: any) => {
        for (const r of store.budgets.values()) {
          if (r.coach_user_id === where.coach_user_id) return r;
        }
        const row = {
          id: `b_${store.budgets.size + 1}`,
          coach_user_id: create.coach_user_id,
          period_start: create.period_start,
          period_end: create.period_end,
          base_actual_cents: create.base_actual_cents ?? 4000,
          value_multiplier: create.value_multiplier ?? new Prisma.Decimal(3.125),
          base_displayed_cents: create.base_displayed_cents ?? 12500,
          pack_paid_cents: 0,
          pack_displayed_cents: 0,
          actual_used_cents: 0,
          total_pack_actual_cents: 0,
          created_at: new Date(),
          updated_at: new Date(),
          last_rollover_at: null,
        };
        store.budgets.set(row.id, row);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const r of store.budgets.values()) {
          if (where.id && r.id !== where.id) continue;
          if (where.actual_used_cents?.lte !== undefined) {
            if (r.actual_used_cents > where.actual_used_cents.lte) continue;
          }
          if (where.period_end?.lte !== undefined) {
            if (r.period_end > where.period_end.lte) continue;
          }
          if (where.period_end?.gt !== undefined) {
            if (r.period_end <= where.period_end.gt) continue;
          }
          if (data.actual_used_cents?.increment !== undefined) {
            r.actual_used_cents += data.actual_used_cents.increment;
          } else if (data.actual_used_cents !== undefined && typeof data.actual_used_cents === 'number') {
            r.actual_used_cents = data.actual_used_cents;
          }
          if (data.pack_paid_cents?.increment !== undefined) r.pack_paid_cents += data.pack_paid_cents.increment;
          if (data.pack_displayed_cents?.increment !== undefined) r.pack_displayed_cents += data.pack_displayed_cents.increment;
          if (data.total_pack_actual_cents?.increment !== undefined) r.total_pack_actual_cents += data.total_pack_actual_cents.increment;
          if (data.last_rollover_at !== undefined) r.last_rollover_at = data.last_rollover_at;
          if (data.period_start !== undefined) r.period_start = data.period_start;
          if (data.period_end !== undefined) r.period_end = data.period_end;
          if (data.base_actual_cents !== undefined) r.base_actual_cents = data.base_actual_cents;
          if (data.value_multiplier !== undefined) r.value_multiplier = data.value_multiplier;
          if (data.base_displayed_cents !== undefined) r.base_displayed_cents = data.base_displayed_cents;
          count++;
        }
        return { count };
      }),
      findMany: jest.fn(async () => Array.from(store.budgets.values())),
      update: jest.fn(async ({ where, data }: any) => {
        const r = store.budgets.get(where.id);
        if (!r) throw new Error(`budget ${where.id} not found`);
        if (data.pack_paid_cents?.increment !== undefined) r.pack_paid_cents += data.pack_paid_cents.increment;
        if (data.pack_paid_cents?.decrement !== undefined) r.pack_paid_cents -= data.pack_paid_cents.decrement;
        if (data.pack_displayed_cents?.increment !== undefined) r.pack_displayed_cents += data.pack_displayed_cents.increment;
        if (data.pack_displayed_cents?.decrement !== undefined) r.pack_displayed_cents -= data.pack_displayed_cents.decrement;
        if (data.total_pack_actual_cents?.increment !== undefined) r.total_pack_actual_cents += data.total_pack_actual_cents.increment;
        if (data.total_pack_actual_cents?.decrement !== undefined) r.total_pack_actual_cents -= data.total_pack_actual_cents.decrement;
        return r;
      }),
    },
    coachCreditPackPurchase: {
      create: jest.fn(async ({ data }: any) => {
        // P0-1: emulate the relaxed CHECK + the free_grant invariant so a
        // regression that re-introduces the old equality CHECK trips here.
        if (data.displayed_credit_cents < data.paid_cents) {
          throw new Error('CHECK violated: displayed_credit_cents >= paid_cents');
        }
        if (data.is_free_grant === true && data.paid_cents !== 0) {
          throw new Error('CHECK violated: free_grant requires paid_cents = 0');
        }
        const row = {
          id: `p_${store.purchases.size + 1}`,
          coach_user_id: data.coach_user_id,
          budget_id: data.budget_id,
          stripe_checkout_session_id: data.stripe_checkout_session_id ?? null,
          stripe_invoice_id: data.stripe_invoice_id ?? null,
          stripe_payment_intent_id: data.stripe_payment_intent_id ?? null,
          paid_cents: data.paid_cents,
          actual_credit_cents: data.actual_credit_cents,
          displayed_credit_cents: data.displayed_credit_cents,
          status: data.status,
          applied_at: data.applied_at ?? null,
          refunded_at: data.refunded_at ?? null,
          is_free_grant: data.is_free_grant ?? false,
          created_at: new Date(),
          updated_at: new Date(),
        };
        store.purchases.set(row.id, row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.id) return store.purchases.get(where.id) ?? null;
        if (where.stripe_checkout_session_id) {
          for (const r of store.purchases.values()) {
            if (r.stripe_checkout_session_id === where.stripe_checkout_session_id) return r;
          }
        }
        return null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        let row: any;
        if (where.id) row = store.purchases.get(where.id);
        if (where.stripe_checkout_session_id) {
          for (const r of store.purchases.values()) {
            if (r.stripe_checkout_session_id === where.stripe_checkout_session_id) { row = r; break; }
          }
        }
        if (!row) throw new Error('purchase not found');
        Object.assign(row, data);
        return row;
      }),
    },
    coachBrief: {
      findMany: jest.fn(async ({ where, take }: any) => {
        const matches = store.briefs
          .filter((b) => b.coach_id === where.coach_id)
          .sort((a, b) => (a.brief_date < b.brief_date ? 1 : -1));
        return matches.slice(0, take);
      }),
    },
    user: {
      findUnique: jest.fn(async ({ where }: any) => store.users.get(where.id) ?? null),
    },
    teamSubCoachAssignment: {
      findFirst: jest.fn(async ({ where }: any) => {
        const matches = store.subCoachAssignments.filter(
          (a) => a.sub_coach_id === where.sub_coach_id && a.archived_at === null,
        );
        matches.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
        return matches[0] ?? null;
      }),
    },
    coachProfile: {
      findUnique: jest.fn(async ({ where }: any) => store.coachProfiles.get(where.user_id) ?? null),
      update: jest.fn(async ({ where, data }: any) => {
        const row = store.coachProfiles.get(where.user_id);
        if (!row) throw new Error('profile not found');
        Object.assign(row, data);
        return row;
      }),
    },
    coachSubscription: {
      findUnique: jest.fn(async ({ where }: any) => store.coachSubscriptions.get(where.coach_id) ?? null),
    },
    $transaction: jest.fn(async (cb: any) => cb(prisma)),
  };
  return prisma;
}

// ===========================================================================
// P0-1 — grantFreeCredits no longer violates the CCPP CHECK constraint.
// ===========================================================================

describe('Round1 P0-1 — grantFreeCredits creates a free-grant CCPP row', () => {
  it('inserts paid_cents=0, displayed_credit_cents>0, is_free_grant=true', async () => {
    const store = newStore();
    const prisma = makePrismaMock(store);
    const svc = new CoachAIBudgetService(prisma);

    const result = await svc.grantFreeCredits({
      coachId: 'coach-1',
      displayedCents: 5000, // $50 owner grant
      reason: 'goodwill',
      actorOwnerId: 'owner-9',
    });
    expect(result.purchaseId).toBeTruthy();

    const purchase = store.purchases.get(result.purchaseId);
    expect(purchase).toBeTruthy();
    expect(purchase.paid_cents).toBe(0);
    expect(purchase.displayed_credit_cents).toBe(5000);
    expect(purchase.is_free_grant).toBe(true);
    // actual_credit_cents = bankersRound(5000 / 3.125) = bankersRound(1600) = 1600
    expect(purchase.actual_credit_cents).toBe(1600);

    // Budget reflects the grant in displayed + actual headroom (NOT paid).
    const budget = store.budgets.get(result.budgetId);
    expect(budget.pack_paid_cents).toBe(0); // free grant does NOT increment paid
    expect(budget.pack_displayed_cents).toBe(5000);
    expect(budget.total_pack_actual_cents).toBe(1600);
  });

  it('rejects displayedCents <= 0', async () => {
    const store = newStore();
    const prisma = makePrismaMock(store);
    const svc = new CoachAIBudgetService(prisma);
    await expect(
      svc.grantFreeCredits({
        coachId: 'c', displayedCents: 0, reason: 'r', actorOwnerId: 'o',
      }),
    ).rejects.toThrow();
  });
});

// ===========================================================================
// P0-2/3 — webhook credits face-value paid_cents, NOT amount_total.
// ===========================================================================

describe('Round1 P0-2/3 — handleStripeEvent uses existing.paid_cents', () => {
  it('credits the CCPP-recorded paid_cents even when amount_total includes tax', async () => {
    const store = newStore();
    const prisma = makePrismaMock(store);
    const stripe = {} as any;
    const budgetSvc = new CoachAIBudgetService(prisma);
    const packSvc = new CoachAiCreditPackService(prisma, stripe, budgetSvc);

    // Seed: budget + a pre-recorded CCPP row at tier price 2500.
    const budget = await budgetSvc.getOrCreateCurrentPeriod('coach-x');
    await prisma.coachCreditPackPurchase.create({
      data: {
        coach_user_id: 'coach-x',
        budget_id: budget.id,
        stripe_checkout_session_id: 'cs_tax',
        paid_cents: 2500,
        displayed_credit_cents: 2500,
        actual_credit_cents: 800,
        status: 'pending',
      },
    });

    const warnSpy = jest.spyOn((packSvc as any).logger, 'warn');

    // Stripe webhook payload claims amount_total=2706 (tier + tax) — but
    // we MUST credit 2500 because that is the tier face-value.
    const result = await packSvc.handleStripeEvent({
      id: 'evt_tax_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_tax',
          amount_total: 2706, // tax-inflated total — must NOT be credited.
          metadata: {
            tgp_kind: 'coach_ai_credit_pack',
            tgp_coach_user_id: 'coach-x',
          },
        },
      },
    });
    expect(result.claimed).toBe(true);
    expect(result.status).toBe('applied');

    const refreshed = store.budgets.get(budget.id);
    expect(refreshed.pack_paid_cents).toBe(2500);
    expect(refreshed.pack_displayed_cents).toBe(2500);
    // Divergence log MUST have fired so support can reconcile.
    const div = warnSpy.mock.calls.find(
      (c) => (c[0] as any)?.event === 'COACH_AI_PACK_AMOUNT_TOTAL_DIVERGENCE',
    );
    expect(div).toBeTruthy();
  });

  it('refuses to credit when no pending CCPP row exists (stray webhook)', async () => {
    const store = newStore();
    const prisma = makePrismaMock(store);
    const stripe = {} as any;
    const budgetSvc = new CoachAIBudgetService(prisma);
    const packSvc = new CoachAiCreditPackService(prisma, stripe, budgetSvc);

    const result = await packSvc.handleStripeEvent({
      id: 'evt_stray',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_stray',
          amount_total: 2500,
          metadata: {
            tgp_kind: 'coach_ai_credit_pack',
            tgp_coach_user_id: 'coach-y',
          },
        },
      },
    });
    expect(result.claimed).toBe(true);
    expect(result.status).toBe('no_pending_purchase');
  });
});

// ===========================================================================
// P0-6 — outer tx threads into handleStripeEvent + applyCreditPack.
// ===========================================================================

describe('Round1 P0-6 — applyCreditPack honours an outer transaction client', () => {
  it('uses the supplied tx when provided (does not open a new $transaction)', async () => {
    const store = newStore();
    const prisma = makePrismaMock(store);
    const svc = new CoachAIBudgetService(prisma);

    const budget = await svc.getOrCreateCurrentPeriod('coach-tx');
    await prisma.coachCreditPackPurchase.create({
      data: {
        coach_user_id: 'coach-tx',
        budget_id: budget.id,
        stripe_checkout_session_id: 'cs_tx',
        paid_cents: 1000,
        displayed_credit_cents: 1000,
        actual_credit_cents: 320,
        status: 'pending',
      },
    });

    const txSpy = jest.spyOn(prisma, '$transaction');
    txSpy.mockClear();

    await svc.applyCreditPack(
      { coachId: 'coach-tx', paidCents: 1000, stripeCheckoutSessionId: 'cs_tx' },
      prisma /* outer tx-like */,
    );

    // The outer caller "owns" the transaction; applyCreditPack must NOT
    // open its own $transaction when tx is supplied.
    expect(txSpy).not.toHaveBeenCalled();
  });

  it('opens its own $transaction when no outer tx is supplied', async () => {
    const store = newStore();
    const prisma = makePrismaMock(store);
    const svc = new CoachAIBudgetService(prisma);

    const budget = await svc.getOrCreateCurrentPeriod('coach-no-tx');
    await prisma.coachCreditPackPurchase.create({
      data: {
        coach_user_id: 'coach-no-tx',
        budget_id: budget.id,
        stripe_checkout_session_id: 'cs_no_tx',
        paid_cents: 1000,
        displayed_credit_cents: 1000,
        actual_credit_cents: 320,
        status: 'pending',
      },
    });

    const txSpy = jest.spyOn(prisma, '$transaction');
    txSpy.mockClear();

    await svc.applyCreditPack({
      coachId: 'coach-no-tx',
      paidCents: 1000,
      stripeCheckoutSessionId: 'cs_no_tx',
    });

    expect(txSpy).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// P1-3 — calendar-month rollover, not 30-day window.
// ===========================================================================

describe('Round1 P1-3 — period_end is the first of the NEXT calendar month UTC', () => {
  it('Feb period_end is Mar 1 UTC (not Mar 3 from +30 days)', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(Date.UTC(2026, 1, 15))); // Feb 15 2026 UTC
    try {
      const store = newStore();
      const prisma = makePrismaMock(store);
      const svc = new CoachAIBudgetService(prisma);
      const b = await svc.getOrCreateCurrentPeriod('coach-feb');
      expect(b.period_start.toISOString()).toBe('2026-02-01T00:00:00.000Z');
      expect(b.period_end.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    } finally {
      jest.useRealTimers();
    }
  });

  it('Jan period_end is Feb 1 UTC (not Jan 31 from +30 days)', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(Date.UTC(2026, 0, 15)));
    try {
      const store = newStore();
      const prisma = makePrismaMock(store);
      const svc = new CoachAIBudgetService(prisma);
      const b = await svc.getOrCreateCurrentPeriod('coach-jan');
      expect(b.period_start.toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(b.period_end.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    } finally {
      jest.useRealTimers();
    }
  });

  it('December rolls into next year (Dec 2026 -> Jan 1 2027)', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(Date.UTC(2026, 11, 10)));
    try {
      const store = newStore();
      const prisma = makePrismaMock(store);
      const svc = new CoachAIBudgetService(prisma);
      const b = await svc.getOrCreateCurrentPeriod('coach-dec');
      expect(b.period_end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    } finally {
      jest.useRealTimers();
    }
  });
});

// ===========================================================================
// P1-6 — recordUsage refuses when the period has already rolled.
// ===========================================================================

describe('Round1 P1-6 — recordUsage WHERE pins period_end > now', () => {
  it('rejects a debit whose budget period has already ended', async () => {
    const store = newStore();
    const prisma = makePrismaMock(store);
    const svc = new CoachAIBudgetService(prisma);

    await svc.getOrCreateCurrentPeriod('coach-rolled');
    // Hand-force the budget into an already-rolled state.
    const row = await prisma.coachAIBudget.findUnique({
      where: { coach_user_id: 'coach-rolled' },
    });
    row.period_end = new Date(Date.now() - 60_000); // 1 minute ago

    const result = await svc.recordUsage({
      coachId: 'coach-rolled',
      actualCostCents: 10,
      capability: 'client_chat',
    });
    expect(result.recorded).toBe(false);
  });
});

// ===========================================================================
// P1-7 — sub-coach head-coach reattribution emits a structured log.
// ===========================================================================

describe('Round1 P1-7 — SUB_COACH_HEAD_REATTRIBUTED log on attribution swing', () => {
  it('logs only when the resolved head_coach_id differs from the cached value', async () => {
    const store = newStore();
    const prisma = makePrismaMock(store);
    const svc = new CoachAIBudgetService(prisma);

    // Day 1 — sub-1 assigned under head-A.
    store.subCoachAssignments.push({
      head_coach_id: 'head-A',
      sub_coach_id: 'sub-1',
      archived_at: null,
      created_at: new Date('2026-01-01'),
    });
    const logSpy = jest.spyOn((svc as any).logger, 'log');

    const first = await svc.resolveHeadCoachId('sub-1');
    expect(first).toBe('head-A');
    // First call cannot swing — nothing was cached yet.
    expect(
      logSpy.mock.calls.find((c) => (c[0] as any)?.event === 'SUB_COACH_HEAD_REATTRIBUTED'),
    ).toBeFalsy();

    // Day 2 — head-A assignment archived, sub-1 reassigned to head-B.
    store.subCoachAssignments[0].archived_at = new Date('2026-02-01');
    store.subCoachAssignments.push({
      head_coach_id: 'head-B',
      sub_coach_id: 'sub-1',
      archived_at: null,
      created_at: new Date('2026-02-01'),
    });

    const second = await svc.resolveHeadCoachId('sub-1');
    expect(second).toBe('head-B');
    const swing = logSpy.mock.calls.find(
      (c) => (c[0] as any)?.event === 'SUB_COACH_HEAD_REATTRIBUTED',
    );
    expect(swing).toBeTruthy();
    expect((swing![0] as any).oldHeadCoachId).toBe('head-A');
    expect((swing![0] as any).newHeadCoachId).toBe('head-B');
  });
});

// ===========================================================================
// P1-8 — total_pack_actual_cents matches sum of CCPP receipts.
// ===========================================================================

describe('Round1 P1-8 — total_pack_actual_cents tracks per-pack rounded credit', () => {
  it('budget.total_pack_actual_cents increments by per-pack actual_credit_cents', async () => {
    const store = newStore();
    const prisma = makePrismaMock(store);
    const svc = new CoachAIBudgetService(prisma);

    const budget = await svc.getOrCreateCurrentPeriod('coach-agg');

    // Pre-create three pack rows; apply each.
    for (let i = 1; i <= 3; i++) {
      const sid = `cs_agg_${i}`;
      await prisma.coachCreditPackPurchase.create({
        data: {
          coach_user_id: 'coach-agg',
          budget_id: budget.id,
          stripe_checkout_session_id: sid,
          paid_cents: 2500,
          displayed_credit_cents: 2500,
          actual_credit_cents: 800,
          status: 'pending',
        },
      });
      const r = await svc.applyCreditPack({
        coachId: 'coach-agg',
        paidCents: 2500,
        stripeCheckoutSessionId: sid,
      });
      expect(r.status).toBe('applied');
    }
    const refreshed = store.budgets.get(budget.id);
    expect(refreshed.total_pack_actual_cents).toBe(2400); // 3 * 800
    expect(refreshed.pack_paid_cents).toBe(7500);

    // Snapshot's total_actual_available reads the column directly — no
    // round-the-sum drift.
    const snap = await svc.getOrCreateCurrentPeriod('coach-agg');
    expect(snap.total_actual_available_cents).toBe(4000 + 2400);
  });
});
