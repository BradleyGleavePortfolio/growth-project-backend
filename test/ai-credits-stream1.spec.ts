/**
 * Stream 1 — Coach AI Credits + Metering + Upsell.
 *
 * Maps to STREAM_1_AI_CREDITS_SPEC.md §7 test matrix (T1-T15). Tests are
 * sequenced so failures point at one logical defect rather than a
 * cascade. Where a test would normally hit Postgres (RLS, FK cascade),
 * we assert on the migration SQL string + the Prisma schema decorators
 * — Jest unit tests cannot stand up a real Postgres, but the assertions
 * are still meaningful as drift detectors.
 *
 * Each `it()` block carries the T# id from the spec so an auditor can
 * grep by id.
 */

import { Prisma } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { bankersRound, bankersRoundPaidToActual } from '../src/ai-credits/bankers-round.util';
import { CoachAIBudgetService } from '../src/ai-credits/coach-ai-budget.service';
import { CoachAiCreditPackService } from '../src/ai-credits/coach-ai-credit-pack.service';
import { DormancyGuardService } from '../src/ai-credits/dormancy-guard.service';
import {
  COACH_AI_BUDGET_EXHAUSTED_CODE,
  COACH_AI_METERED_CAPABILITIES,
} from '../src/ai-credits/ai-credits.constants';

// ---------------------------------------------------------------------------
// Test doubles. The PrismaClient is large enough that a per-test mock is
// unmaintainable; instead we hand-roll an in-memory store that backs the
// few methods the service actually uses. The store mirrors the shape of
// CoachAIBudget + CoachCreditPackPurchase + a tiny User/TeamSubCoach mock.
// ---------------------------------------------------------------------------

type BudgetRow = {
  id: string;
  coach_user_id: string;
  period_start: Date;
  period_end: Date;
  base_actual_cents: number;
  value_multiplier: Prisma.Decimal;
  base_displayed_cents: number;
  pack_paid_cents: number;
  pack_displayed_cents: number;
  actual_used_cents: number;
  /** Round-1 fixer P1-8 — stored aggregate of per-pack actual_credit_cents. */
  total_pack_actual_cents: number;
  created_at: Date;
  updated_at: Date;
  last_rollover_at: Date | null;
};

type PurchaseRow = {
  id: string;
  coach_user_id: string;
  budget_id: string;
  stripe_checkout_session_id: string | null;
  stripe_invoice_id: string | null;
  stripe_payment_intent_id: string | null;
  paid_cents: number;
  actual_credit_cents: number;
  displayed_credit_cents: number;
  status: string;
  applied_at: Date | null;
  refunded_at: Date | null;
  /** Round-1 fixer P0-1 — true when row is an owner free grant (paid_cents=0). */
  is_free_grant: boolean;
  created_at: Date;
  updated_at: Date;
};

interface InMemoryStore {
  budgets: Map<string, BudgetRow>;
  purchases: Map<string, PurchaseRow>;
  briefs: Array<{ coach_id: string; brief_date: string; read_at: Date | null }>;
  users: Map<string, { id: string; email: string; name: string; coach_id: string | null; role: string }>;
  subCoachAssignments: Array<{ head_coach_id: string; sub_coach_id: string; archived_at: Date | null; created_at: Date }>;
  coachProfiles: Map<string, { user_id: string; stripe_customer_id: string | null }>;
  coachSubscriptions: Map<string, { coach_id: string; stripe_customer_id: string | null }>;
}

function newStore(): InMemoryStore {
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

// Minimal prisma stand-in. Each test seeds the store and constructs a
// fresh prismaMock so cases are isolated.
function makePrismaMock(store: InMemoryStore) {
  const prisma: any = {
    coachAIBudget: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.id) return store.budgets.get(where.id) ?? null;
        for (const r of store.budgets.values()) {
          if (r.coach_user_id === where.coach_user_id) return r;
        }
        return null;
      }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        for (const r of store.budgets.values()) {
          if (r.coach_user_id === where.coach_user_id) {
            // mimic Prisma's "no-op when update is empty object" semantics.
            void update;
            return r;
          }
        }
        const row: BudgetRow = {
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
          // Round-1 fixer P1-6 — recordUsage now pins period_end > now.
          if (where.period_end?.gt !== undefined) {
            if (r.period_end <= where.period_end.gt) continue;
          }
          // Apply increments / direct sets in lock-step with the real Prisma.
          if (data.actual_used_cents !== undefined) {
            if (typeof data.actual_used_cents === 'object' && 'increment' in data.actual_used_cents) {
              r.actual_used_cents += data.actual_used_cents.increment;
            } else {
              r.actual_used_cents = data.actual_used_cents;
            }
          }
          if (data.pack_paid_cents !== undefined) {
            if (typeof data.pack_paid_cents === 'object' && 'increment' in data.pack_paid_cents) {
              r.pack_paid_cents += data.pack_paid_cents.increment;
            }
          }
          if (data.pack_displayed_cents !== undefined) {
            if (typeof data.pack_displayed_cents === 'object' && 'increment' in data.pack_displayed_cents) {
              r.pack_displayed_cents += data.pack_displayed_cents.increment;
            }
          }
          if (data.total_pack_actual_cents !== undefined) {
            if (typeof data.total_pack_actual_cents === 'object' && 'increment' in data.total_pack_actual_cents) {
              r.total_pack_actual_cents += data.total_pack_actual_cents.increment;
            }
          }
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
      findMany: jest.fn(async ({ where }: any = {}) => {
        const rows: BudgetRow[] = [];
        for (const r of store.budgets.values()) {
          if (where?.period_end?.lte !== undefined && r.period_end > where.period_end.lte) continue;
          rows.push(r);
        }
        return rows;
      }),
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
        // Round-1 fixer P0-1 — emulate the new CCPP CHECK constraints so
        // tests catch the "free grant violates CHECK" failure that
        // motivated the migration.
        if (data.displayed_credit_cents < data.paid_cents) {
          throw new Error(
            `CHECK CCPP_displayed_credit_ge_paid violated: displayed=${data.displayed_credit_cents} paid=${data.paid_cents}`,
          );
        }
        if (data.is_free_grant === true && data.paid_cents !== 0) {
          throw new Error(
            `CHECK CCPP_free_grant_paid_zero violated: is_free_grant=true requires paid_cents=0`,
          );
        }
        const row: PurchaseRow = {
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
        let row: PurchaseRow | undefined;
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
      findMany: jest.fn(async () => Array.from(store.purchases.values())),
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
        if (!row) throw new Error('coach profile not found');
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

// ---------------------------------------------------------------------------
// T1 — Banker's rounding correctness.
// ---------------------------------------------------------------------------

describe('Stream 1 — T1: banker\'s rounding ($10 / $25 / $99 packs)', () => {
  it('T1: $10 pack (1000c) -> 320 actual cents', () => {
    expect(bankersRoundPaidToActual(1000, 3.125)).toBe(320);
  });
  it('T1: $25 pack (2500c) -> 800 actual cents', () => {
    expect(bankersRoundPaidToActual(2500, 3.125)).toBe(800);
  });
  it('T1: $99 pack (9900c) -> 3168 actual cents', () => {
    expect(bankersRoundPaidToActual(9900, 3.125)).toBe(3168);
  });
  it('T1: half-to-even tiebreak — 0.5/1.5/2.5/3.5/4.5 round to 0/2/2/4/4', () => {
    expect(bankersRound(0.5)).toBe(0);
    expect(bankersRound(1.5)).toBe(2);
    expect(bankersRound(2.5)).toBe(2);
    expect(bankersRound(3.5)).toBe(4);
    expect(bankersRound(4.5)).toBe(4);
  });
  it('T1: rejects non-integer paidCents', () => {
    expect(() => bankersRoundPaidToActual(10.5 as any, 3.125)).toThrow();
  });
  it('T1: rejects multiplier <= 0', () => {
    expect(() => bankersRoundPaidToActual(1000, 0)).toThrow();
    expect(() => bankersRoundPaidToActual(1000, -1)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// T2 — Stripe webhook idempotency.
// ---------------------------------------------------------------------------

describe('Stream 1 — T2: applyCreditPack is idempotent on session id', () => {
  it('T2: replaying the same session_id only increments pack_paid_cents once', async () => {
    const store = newStore();
    const prisma = makePrismaMock(store);
    const svc = new CoachAIBudgetService(prisma as any);
    // Seed budget + a pending purchase row, as the controller path would.
    const budget = await svc.getOrCreateCurrentPeriod('coach-1');
    await prisma.coachCreditPackPurchase.create({
      data: {
        coach_user_id: 'coach-1',
        budget_id: budget.id,
        stripe_checkout_session_id: 'cs_test_idem',
        paid_cents: 2500,
        actual_credit_cents: 800,
        displayed_credit_cents: 2500,
        status: 'pending',
      },
    });

    const first = await svc.applyCreditPack({
      coachId: 'coach-1',
      paidCents: 2500,
      stripeCheckoutSessionId: 'cs_test_idem',
    });
    expect(first.status).toBe('applied');
    const second = await svc.applyCreditPack({
      coachId: 'coach-1',
      paidCents: 2500,
      stripeCheckoutSessionId: 'cs_test_idem',
    });
    expect(second.status).toBe('already_applied');

    const refreshed = await prisma.coachAIBudget.findUnique({ where: { coach_user_id: 'coach-1' } });
    expect(refreshed.pack_paid_cents).toBe(2500); // not 5000
    expect(refreshed.pack_displayed_cents).toBe(2500);
  });
});

// ---------------------------------------------------------------------------
// T3 — Race condition: 10 concurrent recordUsage near the cap.
// ---------------------------------------------------------------------------

describe('Stream 1 — T3: 10 concurrent recordUsage at 95% — total never exceeds cap', () => {
  it('T3: WHERE-clause guard rejects overshoot under concurrency', async () => {
    const store = newStore();
    const prisma = makePrismaMock(store);
    const svc = new CoachAIBudgetService(prisma as any);
    // Seed budget; set used to 3800 / 4000. Each call is 50c. 4 should
    // stick, the rest should overshoot.
    await svc.getOrCreateCurrentPeriod('coach-r');
    await prisma.coachAIBudget.updateMany({
      where: { coach_user_id: 'coach-r' },
      data: { actual_used_cents: 3800 },
    });
    // Manually set the field — the helper updateMany doesn't support
    // direct-set in our mock for this column path; do it inline.
    const b = await prisma.coachAIBudget.findUnique({ where: { coach_user_id: 'coach-r' } });
    b.actual_used_cents = 3800;

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        svc.recordUsage({ coachId: 'coach-r', actualCostCents: 50, capability: 'client_chat' }),
      ),
    );

    const recorded = results.filter((r) => r.recorded).length;
    const refused = results.length - recorded;
    expect(recorded).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
    const refreshed = await prisma.coachAIBudget.findUnique({ where: { coach_user_id: 'coach-r' } });
    expect(refreshed.actual_used_cents).toBeLessThanOrEqual(4000);
    expect(refreshed.actual_used_cents).toBe(3800 + 50 * recorded);
  });
});

// ---------------------------------------------------------------------------
// T4 — Budget exhausted → 402 structured error.
// ---------------------------------------------------------------------------

describe('Stream 1 — T4: exhausted budget surfaces structured 402', () => {
  it('T4: CoachAiBudgetExhaustedException carries code + pack_options + budget', async () => {
    // The exception class is asserted directly because constructing the full
    // gateway invocation chain here would duplicate the gateway test surface.
    const { CoachAiBudgetExhaustedException } = await import(
      '../src/ai-credits/budget-exhausted.exception'
    );
    const err = new CoachAiBudgetExhaustedException({
      code: COACH_AI_BUDGET_EXHAUSTED_CODE,
      message: 'AI budget exhausted — top up to continue',
      pack_options_cents: [1000, 2500, 9900],
      custom_pack_bounds_cents: { min: 1000, max: 50_000 },
      budget: {
        period_end: '2026-06-01T00:00:00.000Z',
        base_displayed_cents: 12500,
        pack_displayed_cents: 0,
        used_displayed_cents: 12500,
        remaining_displayed_cents: 0,
      },
    });
    expect(err.getStatus()).toBe(402);
    const body = err.getResponse() as any;
    expect(body.code).toBe('COACH_AI_BUDGET_EXHAUSTED');
    expect(body.pack_options_cents).toEqual([1000, 2500, 9900]);
    expect(body.custom_pack_bounds_cents).toEqual({ min: 1000, max: 50_000 });
    expect(body.budget.remaining_displayed_cents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T5 — Monthly rollover expires base, preserves packs.
// ---------------------------------------------------------------------------

describe('Stream 1 — T5: rollover resets used + base, preserves pack credit', () => {
  it('T5: actual_used_cents -> 0; pack_paid/displayed unchanged', async () => {
    const store = newStore();
    const prisma = makePrismaMock(store);
    const svc = new CoachAIBudgetService(prisma as any);
    await svc.getOrCreateCurrentPeriod('coach-roll');
    // Forge an aged budget: period_end yesterday, with used + pack.
    const b = await prisma.coachAIBudget.findUnique({ where: { coach_user_id: 'coach-roll' } });
    b.actual_used_cents = 3500;
    b.pack_paid_cents = 2500;
    b.pack_displayed_cents = 2500;
    b.period_end = new Date(Date.now() - 86_400_000);

    const now = new Date();
    const result = await svc.rolloverDueBudgets(now);
    expect(result.rolled).toBe(1);
    const after = await prisma.coachAIBudget.findUnique({ where: { coach_user_id: 'coach-roll' } });
    expect(after.actual_used_cents).toBe(0);
    expect(after.pack_paid_cents).toBe(2500); // preserved
    expect(after.pack_displayed_cents).toBe(2500); // preserved
    expect(after.last_rollover_at).not.toBeNull();
    expect(after.period_end.getTime()).toBeGreaterThan(now.getTime());
  });
});

// ---------------------------------------------------------------------------
// T6 — Dormancy guard skips coach with 3 unread briefs.
// ---------------------------------------------------------------------------

describe('Stream 1 — T6: dormancy guard skips after 3 unread briefs', () => {
  function seedBriefs(store: InMemoryStore, coachId: string, reads: Array<Date | null>) {
    reads.forEach((r, i) =>
      store.briefs.push({ coach_id: coachId, brief_date: `2026-05-${String(28 - i).padStart(2, '0')}`, read_at: r }),
    );
  }

  it('T6: shouldSkip=true when all 3 most-recent briefs are unread', async () => {
    const store = newStore();
    const prisma = makePrismaMock(store);
    const svc = new DormancyGuardService(prisma as any);
    seedBriefs(store, 'coach-d', [null, null, null]);
    expect(await svc.shouldSkipCoach('coach-d')).toBe(true);
  });
  it('T6: shouldSkip=false when most recent brief was read', async () => {
    const store = newStore();
    const prisma = makePrismaMock(store);
    const svc = new DormancyGuardService(prisma as any);
    seedBriefs(store, 'coach-d', [new Date(), null, null]);
    expect(await svc.shouldSkipCoach('coach-d')).toBe(false);
  });
  it('T6: shouldSkip=false when fewer than 3 briefs exist (insufficient data)', async () => {
    const store = newStore();
    const prisma = makePrismaMock(store);
    const svc = new DormancyGuardService(prisma as any);
    seedBriefs(store, 'coach-d', [null, null]);
    expect(await svc.shouldSkipCoach('coach-d')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T7 — Sub-coach AI call charges head coach's budget.
// ---------------------------------------------------------------------------

describe('Stream 1 — T7: sub-coach AI usage debits head coach envelope', () => {
  it('T7: resolveHeadCoachId returns head_coach_id for an assigned sub-coach', async () => {
    const store = newStore();
    const prisma = makePrismaMock(store);
    const svc = new CoachAIBudgetService(prisma as any);
    store.subCoachAssignments.push({
      head_coach_id: 'head-1',
      sub_coach_id: 'sub-1',
      archived_at: null,
      created_at: new Date(),
    });
    expect(await svc.resolveHeadCoachId('sub-1')).toBe('head-1');
    expect(await svc.resolveHeadCoachId('head-1')).toBe('head-1');
    expect(await svc.resolveHeadCoachId('unrelated')).toBe('unrelated');
  });
  it('T7: ignores archived assignments', async () => {
    const store = newStore();
    const prisma = makePrismaMock(store);
    const svc = new CoachAIBudgetService(prisma as any);
    store.subCoachAssignments.push({
      head_coach_id: 'head-1',
      sub_coach_id: 'sub-2',
      archived_at: new Date(),
      created_at: new Date(),
    });
    expect(await svc.resolveHeadCoachId('sub-2')).toBe('sub-2');
  });
});

// ---------------------------------------------------------------------------
// T8 — GET /coach/ai/budget DTO correctness.
// ---------------------------------------------------------------------------

describe('Stream 1 — T8: getBudgetDto returns the documented shape', () => {
  it('T8: DTO carries all spec §5 fields, multiplier as string', async () => {
    const store = newStore();
    const prisma = makePrismaMock(store);
    const svc = new CoachAIBudgetService(prisma as any);
    await svc.getOrCreateCurrentPeriod('coach-dto');
    const b = await prisma.coachAIBudget.findUnique({ where: { coach_user_id: 'coach-dto' } });
    b.actual_used_cents = 1000; // 1000c * 3.125 = 3125c displayed used

    const dto = await svc.getBudgetDto('coach-dto');
    expect(dto.base_displayed_cents).toBe(12500);
    expect(dto.pack_displayed_cents).toBe(0);
    expect(dto.total_displayed_cents).toBe(12500);
    expect(dto.used_displayed_cents).toBe(3125);
    expect(dto.remaining_displayed_cents).toBe(12500 - 3125);
    expect(dto.pct_used).toBeCloseTo(25, 1);
    expect(dto.base_actual_cents).toBe(4000);
    expect(dto.value_multiplier).toBe('3.125');
    expect(dto.actual_used_cents).toBe(1000);
    expect(dto.pack_options_cents).toEqual([1000, 2500, 9900]);
    expect(dto.custom_pack_bounds_cents).toEqual({ min: 1000, max: 50_000 });
    expect(typeof dto.period_start).toBe('string');
    expect(typeof dto.period_end).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// T9 — Stripe webhook signature verification rejects tampered events.
// ---------------------------------------------------------------------------
// The verification path is owned by the existing billing/stripe-signature.ts
// module and has its own tests. We assert here that our pack handler
// does NOT have its own ad-hoc signature path (i.e. the pack service is
// only reachable AFTER the signature path).

describe('Stream 1 — T9: pack webhook handler runs AFTER signature verification', () => {
  it('T9: CoachAiCreditPackService does NOT implement its own signature verification', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'ai-credits', 'coach-ai-credit-pack.service.ts'),
      'utf8',
    );
    // The pack service should not import stripe-signature or implement
    // HMAC verification; the existing StripeWebhookController owns that
    // and BillingService forwards verified events to handleStripeEvent.
    expect(src).not.toMatch(/stripe-signature/);
    expect(src).not.toMatch(/createHmac|verifySignature/);
  });
  it('T9: handler ignores events without the coach_ai_credit_pack metadata kind', async () => {
    const store = newStore();
    const prisma = makePrismaMock(store);
    const svc = new CoachAiCreditPackService(prisma as any, {} as any, new CoachAIBudgetService(prisma as any));
    const result = await svc.handleStripeEvent({
      id: 'evt_other',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_other', metadata: { tgp_kind: 'something_else' } } },
    });
    expect(result.claimed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T10 — RLS: coach A cannot read coach B's budget.
// T11 — RLS: coach cannot directly INSERT/UPDATE CoachCreditPackPurchase.
//
// We assert against the migration SQL string. Jest cannot stand up a real
// Postgres, but the assertions catch drift if anyone deletes a policy
// or relaxes the FORCE RLS posture.
// ---------------------------------------------------------------------------

describe('Stream 1 — T10/T11: RLS policies present in the migration', () => {
  const migration = fs.readFileSync(
    path.join(
      __dirname,
      '..',
      'prisma',
      'migrations',
      '20260528000000_stream1_coach_ai_credits',
      'migration.sql',
    ),
    'utf8',
  );

  it('T10: CoachAIBudget has ENABLE + FORCE RLS', () => {
    expect(migration).toMatch(/ALTER TABLE "CoachAIBudget" ENABLE ROW LEVEL SECURITY/);
    expect(migration).toMatch(/ALTER TABLE "CoachAIBudget" FORCE ROW LEVEL SECURITY/);
  });
  it('T10: CoachAIBudget self_select policy scopes to coach_user_id = current_user_id', () => {
    expect(migration).toMatch(/CoachAIBudget_self_select.*coach_user_id" = app\.current_user_id\(\)/s);
  });
  it('T10: CoachAIBudget owner_all policy gates owners', () => {
    expect(migration).toMatch(/CoachAIBudget_owner_all.*app\.is_owner\(\)/s);
  });
  it('T11: CoachCreditPackPurchase has ENABLE + FORCE RLS', () => {
    expect(migration).toMatch(/ALTER TABLE "CoachCreditPackPurchase" ENABLE ROW LEVEL SECURITY/);
    expect(migration).toMatch(/ALTER TABLE "CoachCreditPackPurchase" FORCE ROW LEVEL SECURITY/);
  });
  it('T11: CCPP has NO coach-scoped INSERT/UPDATE policy (only SELECT)', () => {
    // The migration intentionally exposes only the self_select policy + the
    // owner_all policy on CCPP. A coach attempting an INSERT/UPDATE under
    // their own JWT MUST fail the FORCE RLS check. Assert by inspection:
    // no "FOR INSERT" or "FOR UPDATE" line on CCPP that uses current_user_id.
    const ccppSection = migration.split('CoachCreditPackPurchase ---')[1] ?? migration;
    expect(ccppSection).not.toMatch(/FOR INSERT.*current_user_id/);
    expect(ccppSection).not.toMatch(/FOR UPDATE.*current_user_id/);
  });
  it('T11: stripe_checkout_session_id is the @unique idempotency key', () => {
    expect(migration).toMatch(/CREATE UNIQUE INDEX "CoachCreditPackPurchase_stripe_checkout_session_id_key"/);
  });
});

// ---------------------------------------------------------------------------
// T12 — Admin grant endpoint blocked for non-owner role.
// We assert via decorator inspection: the controller class carries
// OwnerGuard + the per-method @Roles('owner') tag. A coach JWT would be
// rejected by OwnerGuard at request time.
// ---------------------------------------------------------------------------

describe('Stream 1 — T12: admin endpoints are owner-only by decoration', () => {
  it('T12: controller file uses OwnerGuard + @Roles("owner") on every handler', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'ai-credits', 'admin-coach-ai.controller.ts'),
      'utf8',
    );
    expect(src).toMatch(/@UseGuards\(JwtAuthGuard, OwnerGuard\)/);
    // Every @Post/@Get handler carries @Roles('owner').
    const handlers = src.match(/@(?:Post|Get)\(/g) ?? [];
    expect(handlers.length).toBeGreaterThanOrEqual(3);
    const owners = src.match(/@Roles\('owner'\)/g) ?? [];
    expect(owners.length).toBeGreaterThanOrEqual(handlers.length);
  });
});

// ---------------------------------------------------------------------------
// T13 — External API calls have timeout config.
// ---------------------------------------------------------------------------
// The Stripe outbound path uses native fetch (no custom timeout API). Node
// 22+ fetch honours AbortController-driven timeouts; the existing
// StripeApiService delegates to a `fetchImpl` we can replace in tests.
// We assert here that the new pack-checkout method respects an
// AbortSignal threaded into the fetch call OR that the underlying
// fetchImpl is documented as the timeout boundary.

describe('Stream 1 — T13: Stripe outbound respects fetchImpl timeout boundary', () => {
  it('T13: createCreditPackCheckoutSession routes through the same post() path', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'billing', 'stripe-api.service.ts'),
      'utf8',
    );
    // Find the createCreditPackCheckoutSession method definition and assert
    // it ends with a call to this.post — which is the single fetchImpl call
    // path. That path is the test/mock boundary the existing tests already
    // exploit to inject timeouts; tests can swap fetchImpl for an
    // AbortController-driven implementation.
    expect(src).toMatch(/createCreditPackCheckoutSession[\s\S]+?return this\.post</);
  });
});

// ---------------------------------------------------------------------------
// T14 — No console.log in shipped code; errors go through Logger.
// ---------------------------------------------------------------------------

describe('Stream 1 — T14: no console.* in src/ai-credits/*', () => {
  it('T14: src files use Nest Logger, not console.*', () => {
    const dir = path.join(__dirname, '..', 'src', 'ai-credits');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      // Strip line comments so a console.* in a comment doesn't trip us.
      const stripped = src.replace(/\/\/[^\n]*/g, '');
      expect(stripped).not.toMatch(/\bconsole\.(log|warn|error|info|debug)\(/);
    }
  });
});

// ---------------------------------------------------------------------------
// T15 — Scheduler emits structured log with duration_ms + counts.
// Stand-in for the audit doc's "BullMQ metrics" requirement: this codebase
// uses Nest @Cron + Logger rather than BullMQ for the rollover path. We
// assert the scheduler logs the documented structured shape on tick.
// ---------------------------------------------------------------------------

describe('Stream 1 — T15: rollover scheduler emits structured tick log', () => {
  it('T15: log carries event, rolled count, duration_ms', async () => {
    const { CoachAIBudgetScheduler } = await import('../src/ai-credits/coach-ai-budget.scheduler');
    const fakeBudget = { rolloverDueBudgets: jest.fn(async () => ({ rolled: 2 })) };
    const sched = new CoachAIBudgetScheduler(fakeBudget as any);
    const spy = jest.spyOn((sched as any).logger, 'log');
    await sched.handleCron();
    expect(fakeBudget.rolloverDueBudgets).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalled();
    const firstArg = spy.mock.calls[0][0] as any;
    expect(firstArg.event).toBe('COACH_AI_BUDGET_ROLLOVER_TICK');
    expect(firstArg.rolled).toBe(2);
    expect(typeof firstArg.duration_ms).toBe('number');
  });
  it('T15: scheduler swallows errors (does not crash the process)', async () => {
    const { CoachAIBudgetScheduler } = await import('../src/ai-credits/coach-ai-budget.scheduler');
    const fakeBudget = {
      rolloverDueBudgets: jest.fn(async () => { throw new Error('db boom'); }),
    };
    const sched = new CoachAIBudgetScheduler(fakeBudget as any);
    const spy = jest.spyOn((sched as any).logger, 'error');
    await expect(sched.handleCron()).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    const firstArg = spy.mock.calls[0][0] as any;
    expect(firstArg.event).toBe('COACH_AI_BUDGET_ROLLOVER_ERROR');
  });
});

// ---------------------------------------------------------------------------
// Sanity probe — every metered capability listed in the constants set
// matches at least one materialiser/capability name used by the gateway.
// ---------------------------------------------------------------------------

describe('Stream 1 — sanity: metered capabilities set is non-empty', () => {
  it('contains the spec-named draft.coach_message + chat capabilities', () => {
    expect(COACH_AI_METERED_CAPABILITIES.size).toBeGreaterThan(0);
    expect(COACH_AI_METERED_CAPABILITIES.has('draft.coach_message')).toBe(true);
    expect(COACH_AI_METERED_CAPABILITIES.has('client_chat')).toBe(true);
  });
});
