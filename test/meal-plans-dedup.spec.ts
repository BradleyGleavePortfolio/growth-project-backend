// test/meal-plans-dedup.spec.ts
//
// BUG-R2 — Two parallel meal-plan systems. `real-meal-plans`
// (DailyMealPlan + MealTemplate + DailyMealPlanAssignment) is the CANONICAL
// system; the legacy `MealPlan` table is kept alive only as a compat shim.
//
// The bug: a coach who builds a plan via the newer `coach/daily-meal-plans`
// API writes to `DailyMealPlan`. A client still on the old app calls the
// legacy `GET /meal-plans`, which read ONLY the legacy `MealPlan` table and
// therefore returned nothing — the client saw "no meal plan assigned" even
// though a real plan existed.
//
// This e2e-style spec drives BOTH services through one shared in-memory
// Prisma double (the same fake-Prisma pattern as meal-plans.service.spec /
// nudges.service.spec) and asserts the core dedup contract from the bug spec:
//
//   coach assigns a DailyMealPlan
//     → GET /meal-plans         (legacy wrapper)  returns the plan content
//     → GET /me/meal-plan/today (current/canonical) returns the plan content
//
// Plus the regressions the 50-failure anti-pattern list calls out:
//   - the legacy table is wrapped, never dropped: genuine legacy MealPlan
//     rows still come back unchanged alongside the reshaped canonical plan;
//   - no behaviour change for a client who only has legacy rows;
//   - ownership is scoped by client_id — a client never sees another
//     client's canonical plan, and no client-supplied id is trusted.

import 'reflect-metadata';
import { MealPlansService } from '../src/meal-plans/meal-plans.service';
import { RealMealPlansService } from '../src/real-meal-plans/real-meal-plans.service';
import {
  ClientMealPlanAliasController,
  ClientMealPlansController,
} from '../src/meal-plans/client-meal-plans.controller';

// ── Shared in-memory Prisma double ───────────────────────────────────────
// Implements only the surface both services touch: user, mealPlan,
// mealTemplate, dailyMealPlan(+Slot), dailyMealPlanAssignment, and a tiny
// $transaction passthrough. Relation includes are resolved by hand so the
// canonical read path (assignment → daily_meal_plan → slots → meal_template)
// returns the same nested shape Prisma would.
function makePrisma() {
  const users: Array<{ id: string; role: string; coach_id: string | null }> =
    [];
  const mealPlans: any[] = [];
  const mealTemplates: any[] = [];
  const dailyMealPlans: any[] = [];
  const dailyMealPlanSlots: any[] = [];
  const assignments: any[] = [];

  let seq = 0;
  const newId = (p: string) => `${p}-${++seq}`;

  const matches = (row: any, where: any): boolean => {
    if (!where) return true;
    for (const [k, v] of Object.entries(where)) {
      if (k === 'OR') {
        if (!(v as any[]).some((clause) => matches(row, clause))) return false;
        continue;
      }
      if (k === 'AND') {
        for (const clause of v as any[]) if (!matches(row, clause)) return false;
        continue;
      }
      if (k === 'NOT') {
        if (matches(row, v)) return false;
        continue;
      }
      if (k === 'client') {
        const client = users.find((u) => u.id === row.client_id);
        if (!client || !matches(client, v)) return false;
        continue;
      }
      const val = (row as any)[k];
      if (v === null) {
        if (val !== null && val !== undefined) return false;
        continue;
      }
      if (
        typeof v === 'object' &&
        v !== null &&
        ('lt' in v || 'gt' in v || 'gte' in v || 'lte' in v || 'in' in v)
      ) {
        if ('lt' in v && !(val < (v as any).lt)) return false;
        if ('gt' in v && !(val > (v as any).gt)) return false;
        if ('gte' in v && !(val >= (v as any).gte)) return false;
        if ('lte' in v && !(val <= (v as any).lte)) return false;
        if ('in' in v && !((v as any).in as any[]).includes(val)) return false;
        continue;
      }
      if (val !== v) return false;
    }
    return true;
  };

  // Hydrate a dailyMealPlan with its ordered slots + each slot's template.
  const hydratePlan = (plan: any) => {
    if (!plan) return plan;
    const slots = dailyMealPlanSlots
      .filter((s) => s.daily_meal_plan_id === plan.id)
      .sort(
        (a, b) =>
          a.slot_label.localeCompare(b.slot_label) || a.order - b.order,
      )
      .map((s) => ({
        ...s,
        meal_template: mealTemplates.find((t) => t.id === s.meal_template_id),
      }));
    return { ...plan, slots };
  };

  const sortBy = (rows: any[], orderBy: any) => {
    const clauses = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    return [...rows].sort((a, b) => {
      for (const c of clauses) {
        const [field, dir] = Object.entries(c)[0] as [string, string];
        const av = a[field];
        const bv = b[field];
        const cmp =
          av instanceof Date || bv instanceof Date
            ? new Date(av).getTime() - new Date(bv).getTime()
            : av < bv
              ? -1
              : av > bv
                ? 1
                : 0;
        if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
      }
      return 0;
    });
  };

  const prisma: any = {
    _users: users,
    _mealPlans: mealPlans,
    _assignments: assignments,
    $transaction: async (fn: any) => fn(prisma),
    user: {
      findFirst: jest.fn(async ({ where, select }: any) => {
        const row = users.find((u) => matches(u, where));
        if (!row) return null;
        if (select) {
          const out: any = {};
          for (const k of Object.keys(select)) if (select[k]) out[k] = (row as any)[k];
          return out;
        }
        return { ...row };
      }),
    },
    mealPlan: {
      create: jest.fn(async ({ data }: any) => {
        const now = new Date();
        const row = {
          id: newId('mp'),
          coach_id: data.coach_id,
          client_id: data.client_id,
          title: data.title,
          notes: data.notes ?? null,
          items: data.items,
          days: data.days ?? null,
          created_at: now,
          updated_at: now,
          archived_at: null,
        };
        mealPlans.push(row);
        return { ...row };
      }),
      findMany: jest.fn(async ({ where, orderBy }: any) => {
        const out = sortBy(
          mealPlans.filter((p) => matches(p, where)),
          orderBy,
        );
        return out.map((p) => ({ ...p }));
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        const row = mealPlans.find((p) => matches(p, where));
        return row ? { ...row } : null;
      }),
    },
    mealTemplate: {
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: newId('mt'),
          coach_id: data.coach_id,
          name: data.name,
          description: data.description ?? null,
          calories_kcal: data.calories_kcal,
          protein_g: data.protein_g,
          carbs_g: data.carbs_g,
          fats_g: data.fats_g,
          fiber_g: data.fiber_g ?? null,
          items: data.items ?? null,
          created_at: new Date(),
          archived_at: data.archived_at ?? null,
        };
        mealTemplates.push(row);
        return { ...row };
      }),
      findMany: jest.fn(async ({ where }: any) =>
        mealTemplates.filter((t) => matches(t, where)).map((t) => ({ ...t })),
      ),
      findFirst: jest.fn(async ({ where }: any) => {
        const row = mealTemplates.find((t) => matches(t, where));
        return row ? { ...row } : null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = mealTemplates.find((t) => t.id === where.id);
        Object.assign(row, data);
        return { ...row };
      }),
    },
    dailyMealPlan: {
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: newId('dmp'),
          coach_id: data.coach_id,
          name: data.name,
          notes: data.notes ?? null,
          created_at: data.created_at ?? new Date(),
          archived_at: data.archived_at ?? null,
        };
        dailyMealPlans.push(row);
        return { ...row };
      }),
      findMany: jest.fn(async ({ where }: any) =>
        dailyMealPlans.filter((p) => matches(p, where)).map((p) => hydratePlan({ ...p })),
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const row = dailyMealPlans.find((p) => p.id === where.id);
        Object.assign(row, data);
        return { ...row };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const rows = dailyMealPlans.filter((p) => matches(p, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        const row = dailyMealPlans.find((p) => p.id === where.id);
        return row ? hydratePlan({ ...row }) : null;
      }),
      findFirst: jest.fn(async ({ where, select }: any) => {
        const row = dailyMealPlans.find((p) => matches(p, where));
        if (!row) return null;
        if (select) {
          const out: any = {};
          for (const k of Object.keys(select)) if (select[k]) out[k] = (row as any)[k];
          return out;
        }
        return hydratePlan({ ...row });
      }),
    },
    dailyMealPlanSlot: {
      createMany: jest.fn(async ({ data }: any) => {
        for (const d of data) dailyMealPlanSlots.push({ id: newId('slot'), order: 0, ...d });
        return { count: data.length };
      }),
      findMany: jest.fn(async ({ where }: any) =>
        dailyMealPlanSlots.filter((r) => matches(r, where)).map((r) => ({ ...r })),
      ),
      deleteMany: jest.fn(async ({ where }: any) => {
        const kept = dailyMealPlanSlots.filter((r) => !matches(r, where));
        const count = dailyMealPlanSlots.length - kept.length;
        dailyMealPlanSlots.splice(0, dailyMealPlanSlots.length, ...kept);
        return { count };
      }),
    },
    dailyMealPlanAssignment: {
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: newId('asg'),
          daily_meal_plan_id: data.daily_meal_plan_id,
          client_id: data.client_id,
          assigned_by_coach_id: data.assigned_by_coach_id,
          starts_on: data.starts_on,
          ends_on: data.ends_on ?? null,
          created_at: new Date(),
        };
        assignments.push(row);
        return { ...row };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const rows = assignments.filter((a) => matches(a, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      }),
      findFirst: jest.fn(async ({ where, orderBy, include }: any) => {
        const out = sortBy(
          assignments.filter((a) => matches(a, where)),
          orderBy,
        );
        const row = out[0];
        if (!row) return null;
        const copy: any = { ...row };
        if (include?.client) copy.client = users.find((u) => u.id === row.client_id);
        if (include?.daily_meal_plan) {
          const plan = dailyMealPlans.find((p) => p.id === row.daily_meal_plan_id);
          copy.daily_meal_plan = plan ? hydratePlan({ ...plan }) : null;
        }
        return copy;
      }),
      findMany: jest.fn(async ({ where, orderBy, include }: any) => {
        const out = sortBy(
          assignments.filter((a) => matches(a, where)),
          orderBy,
        );
        return out.map((row) => {
          const copy: any = { ...row };
          if (include?.daily_meal_plan) {
            const plan = dailyMealPlans.find((p) => p.id === row.daily_meal_plan_id);
            copy.daily_meal_plan = plan ? hydratePlan({ ...plan }) : null;
          }
          return copy;
        });
      }),
    },
  };
  return prisma;
}

// Build the canonical plan the coach assigns. Returns the assignment.
async function coachBuildsAndAssigns(
  real: RealMealPlansService,
  coachId: string,
  clientId: string,
  startsOn: string,
) {
  const tpl = await real.createTemplate(coachId, {
    name: 'High-protein breakfast',
    description: 'Eggs, oats, berries',
    calories_kcal: 520,
    protein_g: 38,
    carbs_g: 55,
    fats_g: 18,
  } as any);
  const plan = await real.createPlan(coachId, {
    name: 'Cut Phase — Daily',
    notes: 'Stick to the macros',
    slots: [{ meal_template_id: tpl.id, slot_label: 'breakfast' }],
  } as any);
  await real.assignPlan(coachId, plan!.id, {
    client_id: clientId,
    starts_on: startsOn,
  } as any);
  return { tpl, plan };
}

describe('BUG-R2 — legacy meal-plans deduped onto real-meal-plans canonical', () => {
  let prisma: any;
  let legacy: MealPlansService;
  let real: RealMealPlansService;

  // A fixed "today" so date-window math is deterministic.
  const TODAY = '2026-05-20';

  beforeEach(() => {
    prisma = makePrisma();
    prisma._users.push(
      { id: 'coach-A', role: 'coach', coach_id: null },
      { id: 'coach-B', role: 'coach', coach_id: null },
      { id: 'client-1', role: 'student', coach_id: 'coach-A' },
      { id: 'client-2', role: 'student', coach_id: 'coach-A' },
    );
    legacy = new MealPlansService(prisma);
    real = new RealMealPlansService(prisma);
  });

  it('coach assigns DailyMealPlan → BOTH legacy GET /meal-plans and current GET /me/meal-plan/today return the plan content', async () => {
    const { plan } = await coachBuildsAndAssigns(real, 'coach-A', 'client-1', TODAY);

    // ── current/canonical: GET /me/meal-plan/today ──
    const today = await real.getTodayForClient('client-1', TODAY);
    expect(today.assignments).toHaveLength(1);
    const canonicalPlan = today.assignments[0].daily_meal_plan;
    expect(canonicalPlan.name).toBe('Cut Phase — Daily');
    expect(canonicalPlan.slots[0].meal_template.name).toBe('High-protein breakfast');

    // ── legacy wrapper: GET /meal-plans ──
    // BEFORE the fix this returned [] (legacy MealPlan table empty). Now it
    // surfaces the reshaped canonical plan so the old client sees real data.
    const legacyView = await legacy.listForClientWithCanonicalFallback('client-1');
    expect(legacyView).toHaveLength(1);
    const wrapped = legacyView[0] as any;
    expect(wrapped.title).toBe('Cut Phase — Daily');
    expect(wrapped.source).toBe('real-meal-plans');
    expect(wrapped.id).toBe(`canonical:${plan!.id}`);
    // Slot reshaped into a legacy item with macros + slot_label as time_of_day.
    expect(wrapped.items).toHaveLength(1);
    expect(wrapped.items[0]).toMatchObject({
      name: 'High-protein breakfast',
      calories: 520,
      protein: 38,
      time_of_day: 'breakfast',
    });

    // Same plan content surfaces on BOTH endpoints (the dedup contract).
    expect(wrapped.title).toBe(canonicalPlan.name);
    expect(wrapped.items[0].name).toBe(
      canonicalPlan.slots[0].meal_template.name,
    );
  });

  it('legacy wrapper does not break callers that only have genuine legacy MealPlan rows (wrap, never drop)', async () => {
    // A pure-legacy plan written via the old coach API.
    await legacy.createForClient('coach-A', 'client-1', {
      title: 'Legacy plan',
      notes: 'old shape',
      items: [{ name: 'Oatmeal', calories: 300 }],
    } as any);

    const view = await legacy.listForClientWithCanonicalFallback('client-1');
    expect(view).toHaveLength(1);
    expect((view[0] as any).title).toBe('Legacy plan');
    // No canonical marker — this is a genuine legacy row, untouched.
    expect((view[0] as any).source).toBeUndefined();
  });

  it('client with BOTH a legacy row and a canonical assignment sees both, newest-first', async () => {
    // Legacy row dated in the past.
    const lp = await legacy.createForClient('coach-A', 'client-1', {
      title: 'Old legacy plan',
      items: [{ name: 'Toast' }],
    } as any);
    (lp as any).created_at = new Date('2026-05-01T00:00:00Z');
    // Find the stored row and back-date it too so the merge sort is stable.
    prisma._mealPlans[0].created_at = new Date('2026-05-01T00:00:00Z');

    // Canonical assignment dated today (newer).
    await coachBuildsAndAssigns(real, 'coach-A', 'client-1', TODAY);

    const view = await legacy.listForClientWithCanonicalFallback('client-1');
    expect(view).toHaveLength(2);
    // Newest-first: the canonical plan (assigned today) leads.
    expect((view[0] as any).source).toBe('real-meal-plans');
    expect((view[1] as any).title).toBe('Old legacy plan');
  });

  it('ownership: a client never sees another client\u2019s canonical plan via the legacy wrapper', async () => {
    // Coach assigns ONLY to client-1.
    await coachBuildsAndAssigns(real, 'coach-A', 'client-1', TODAY);

    // client-2 (same coach, no assignment) sees nothing on the wrapper.
    const view2 = await legacy.listForClientWithCanonicalFallback('client-2');
    expect(view2).toHaveLength(0);

    // And the canonical endpoint agrees.
    const today2 = await real.getTodayForClient('client-2', TODAY);
    expect(today2.assignments).toHaveLength(0);
  });

  it('HIST-2 (owner 4): a moved client leaves the former coach\u2019s plan assignments; the client keeps the plan', async () => {
    const { plan } = await coachBuildsAndAssigns(real, 'coach-A', 'client-1', TODAY);
    await real.assignPlan('coach-A', plan!.id, { client_id: 'client-2', starts_on: TODAY });
    const listed = async () =>
      (await real.listAssignmentsForCoach('coach-A', plan!.id)).map((a) => a.client_id);
    expect(await listed()).toEqual(['client-1', 'client-2']);

    // The move: client-1's coach is now coach-B.
    prisma._users.find((u: { id: string }) => u.id === 'client-1').coach_id = 'coach-B';
    expect(await listed()).toEqual(['client-2']);
    expect(prisma._assignments).toHaveLength(2);

    // History follows the client: today's plan is still theirs.
    const today = await real.getTodayForClient('client-1', TODAY);
    expect(today.assignments.map((a) => a.daily_meal_plan.name)).toEqual(['Cut Phase — Daily']);
  });

  it('HIST-2 (owner 4): the former coach\u2019s later edits never reach a moved client, who keeps the plan as it was', async () => {
    const { tpl, plan } = await coachBuildsAndAssigns(real, 'coach-A', 'client-1', TODAY);
    await real.assignPlan('coach-A', plan!.id, { client_id: 'client-2', starts_on: TODAY });
    const seen = async (clientId: string) =>
      (await real.getTodayForClient(clientId, TODAY)).assignments.map((a) => {
        const t = a.daily_meal_plan.slots[0].meal_template;
        return [a.daily_meal_plan.name, t.name, t.calories_kcal];
      });
    const asAssigned = [['Cut Phase — Daily', 'High-protein breakfast', 520]];

    // The move: client-1's coach is now coach-B. Then coach-A edits.
    prisma._users.find((u: { id: string }) => u.id === 'client-1').coach_id = 'coach-B';
    await real.updateTemplate('coach-A', tpl.id, { name: 'Edited breakfast', calories_kcal: 300 });
    await real.updatePlan('coach-A', plan!.id, { name: 'Edited plan' });
    expect(await seen('client-1')).toEqual(asAssigned);
    expect(await seen('client-2')).toEqual([['Edited plan', 'Edited breakfast', 300]]);

    // The frozen copy is on none of coach-A's lists and no coach route opens it.
    const [kept] = (await real.getTodayForClient('client-1', TODAY)).assignments;
    expect(kept.daily_meal_plan_id).not.toBe(plan!.id);
    expect((await real.listPlans('coach-A')).map((p) => p.id)).toEqual([plan!.id]);
    expect((await real.listTemplates('coach-A')).map((t) => t.id)).toEqual([tpl.id]);
    await expect(real.getPlan('coach-A', kept.daily_meal_plan_id)).rejects.toThrow(
      'Daily meal plan not found',
    );
    await expect(
      real.updatePlan('coach-A', kept.daily_meal_plan_id, { name: 'Edited again' }),
    ).rejects.toThrow('Daily meal plan not found');
    await real.updatePlan('coach-A', plan!.id, { name: 'Edited again' });
    expect(await seen('client-1')).toEqual(asAssigned);
  });

  it("C2-C0: the coach's meal times reach the client, an edit retimes them, a moved client keeps theirs; no other coach writes them", async () => {
    const tpl = await real.createTemplate('coach-A', { name: 'Oats', calories_kcal: 400, protein_g: 20, carbs_g: 60, fats_g: 8 });
    const plan = await real.createPlan('coach-A', {
      name: 'Day',
      slots: [{ meal_template_id: tpl.id, slot_label: 'breakfast', time_of_day: '07:30' }, { meal_template_id: tpl.id, slot_label: 'lunch' }],
    });
    for (const client_id of ['client-1', 'client-2']) await real.assignPlan('coach-A', plan!.id, { client_id, starts_on: TODAY });
    const times = async (clientId: string) =>
      (await real.getTodayForClient(clientId, TODAY)).assignments[0].daily_meal_plan.slots.map((s) => [s.slot_label, s.time_of_day]);
    const asAssigned = [['breakfast', '07:30'], ['lunch', null]];
    expect(await times('client-1')).toEqual(asAssigned);

    // The move: client-1's coach is now coach-B. Then coach-A retimes the day.
    prisma._users.find((u: { id: string }) => u.id === 'client-1').coach_id = 'coach-B';
    const retimed = [{ meal_template_id: tpl.id, slot_label: 'breakfast' as const, time_of_day: '08:00' }, { meal_template_id: tpl.id, slot_label: 'lunch' as const, time_of_day: '12:30' }];
    await real.updatePlan('coach-A', plan!.id, { slots: retimed });
    expect(await times('client-2')).toEqual([['breakfast', '08:00'], ['lunch', '12:30']]);
    expect(await times('client-1')).toEqual(asAssigned);
    await expect(real.updatePlan('coach-B', plan!.id, { slots: [] })).rejects.toThrow('Daily meal plan not found');
    expect(await times('client-2')).toEqual([['breakfast', '08:00'], ['lunch', '12:30']]);
  });

  it('HIST-2 (owner 4): a moved client keeps a plan that starts later, as it was, on both reads', async () => {
    const NEXT_WEEK = '2026-05-27';
    const { tpl, plan } = await coachBuildsAndAssigns(real, 'coach-A', 'client-1', NEXT_WEEK);
    await real.assignPlan('coach-A', plan!.id, { client_id: 'client-2', starts_on: TODAY });
    // GET /meal-plans: title, first meal, its calories, and the plan's own date.
    const legacyRead = async (clientId: string) =>
      (await legacy.listForClientWithCanonicalFallback(clientId)).map((p: any) => [
        p.title,
        p.items[0].name,
        p.items[0].calories,
        p.updated_at,
      ]);
    const asAssigned = [['Cut Phase — Daily', 'High-protein breakfast', 520, plan!.created_at]];
    expect(await legacyRead('client-1')).toEqual(asAssigned);

    // The move: client-1's coach is now coach-B. Then coach-A edits.
    prisma._users.find((u: { id: string }) => u.id === 'client-1').coach_id = 'coach-B';
    await real.updateTemplate('coach-A', tpl.id, { name: 'Edited breakfast', calories_kcal: 300 });
    await real.updatePlan('coach-A', plan!.id, { name: 'Edited plan' });
    expect(await legacyRead('client-1')).toEqual(asAssigned);
    // GET /me/meal-plan/today on its start day.
    const [{ daily_meal_plan: kept }] = (await real.getTodayForClient('client-1', NEXT_WEEK))
      .assignments;
    const t = kept.slots[0].meal_template;
    expect([kept.name, t.name, t.calories_kcal, kept.created_at]).toEqual(asAssigned[0]);

    // No coach opens the frozen copy; the coach's own client gets the edits.
    for (const coachId of ['coach-A', 'coach-B']) {
      await expect(real.getPlan(coachId, kept.id)).rejects.toThrow('Daily meal plan not found');
    }
    expect((await legacyRead('client-2'))[0].slice(0, 3)).toEqual([
      'Edited plan',
      'Edited breakfast',
      300,
    ]);
    // A plan its coach archives still leaves the legacy read.
    await real.archivePlan('coach-A', plan!.id);
    expect(await legacyRead('client-2')).toEqual([]);
  });

  it('GET /me/meal-plan alias controller proxies to the canonical system (same shape as /me/meal-plan/today)', async () => {
    await coachBuildsAndAssigns(real, 'coach-A', 'client-1', TODAY);

    // Drive the alias controller exactly as Nest would, with a scoped req.
    const aliasController = new ClientMealPlanAliasController(real);
    const req = { user: { id: 'client-1' } } as any;
    const aliasResult = await aliasController.current(req, TODAY);
    const direct = await real.getTodayForClient('client-1', TODAY);

    // The alias returns the canonical shape verbatim — proves it proxies,
    // not re-implements against the legacy table.
    expect(aliasResult).toEqual(direct);
    expect(aliasResult.assignments[0].daily_meal_plan.name).toBe(
      'Cut Phase — Daily',
    );
  });

  it('legacy list controller wires GET /meal-plans to the canonical-fallback wrapper', async () => {
    await coachBuildsAndAssigns(real, 'coach-A', 'client-1', TODAY);

    // Drive the legacy client controller as Nest would.
    const controller = new ClientMealPlansController(legacy);
    const req = { user: { id: 'client-1' } } as any;
    const result = (await controller.list(req)) as any[];
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('real-meal-plans');
    expect(result[0].title).toBe('Cut Phase — Daily');
  });
});
