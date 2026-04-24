import { NotFoundException } from '@nestjs/common';
import { MealPlansService } from '../src/meal-plans/meal-plans.service';

// In-memory Prisma mock — same shape as nudges.service.spec / messaging.service.spec
// so the three suites feel consistent. Only implements the surface MealPlansService
// actually calls (user.findFirst, mealPlan.{create,findMany,findFirst,update,updateMany}).
function makePrisma() {
  const users: Array<{ id: string; role: string; coach_id: string | null }> = [];
  const plans: Array<{
    id: string;
    coach_id: string;
    client_id: string;
    title: string;
    notes: string | null;
    items: unknown;
    created_at: Date;
    updated_at: Date;
    archived_at: Date | null;
  }> = [];

  let seq = 0;
  const newId = () => `p-${++seq}`;

  const matches = (row: any, where: any): boolean => {
    if (!where) return true;
    for (const [k, v] of Object.entries(where)) {
      if (k === 'NOT') {
        if (matches(row, v)) return false;
        continue;
      }
      if (k === 'AND') {
        for (const clause of v as any[]) if (!matches(row, clause)) return false;
        continue;
      }
      if (k === 'OR') {
        if (!(v as any[]).some((clause) => matches(row, clause))) return false;
        continue;
      }
      const val = (row as any)[k];
      if (v === null) {
        if (val !== null && val !== undefined) return false;
        continue;
      }
      if (typeof v === 'object' && v !== null && ('lt' in v || 'gt' in v || 'gte' in v || 'lte' in v || 'in' in v)) {
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

  return {
    _users: users,
    _plans: plans,
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
          id: newId(),
          coach_id: data.coach_id,
          client_id: data.client_id,
          title: data.title,
          notes: data.notes ?? null,
          items: data.items,
          created_at: now,
          updated_at: now,
          archived_at: null,
        };
        plans.push(row);
        return { ...row };
      }),
      findMany: jest.fn(async ({ where, orderBy }: any) => {
        let out = plans.filter((p) => matches(p, where));
        if (orderBy?.created_at === 'desc') out.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
        return out.map((p) => ({ ...p }));
      }),
      findFirst: jest.fn(async ({ where, select }: any) => {
        const row = plans.find((p) => matches(p, where));
        if (!row) return null;
        if (select) {
          const out: any = {};
          for (const k of Object.keys(select)) if (select[k]) out[k] = (row as any)[k];
          return out;
        }
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = plans.find((p) => p.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data, { updated_at: new Date() });
        return { ...row };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const p of plans) {
          if (matches(p, where)) {
            Object.assign(p, data);
            count++;
          }
        }
        return { count };
      }),
    },
  };
}

const goodPlan = {
  title: 'Cut week 1',
  notes: 'lean protein + veg',
  items: [
    { name: 'Chicken breast', calories: 300, protein: 40 },
    { name: 'Broccoli' },
  ],
};

describe('MealPlansService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: MealPlansService;

  beforeEach(() => {
    prisma = makePrisma();
    prisma._users.push(
      { id: 'coach-A', role: 'coach', coach_id: null },
      { id: 'coach-B', role: 'coach', coach_id: null },
      { id: 'client-1', role: 'student', coach_id: 'coach-A' },
      { id: 'client-2', role: 'student', coach_id: 'coach-A' },
      { id: 'client-other', role: 'student', coach_id: 'coach-B' },
    );
    svc = new MealPlansService(prisma as any);
  });

  describe('coach CRUD', () => {
    it('creates + lists a plan for a client', async () => {
      const created = await svc.createForClient('coach-A', 'client-1', goodPlan as any);
      expect(created.coach_id).toBe('coach-A');
      expect(created.client_id).toBe('client-1');
      expect(created.archived_at).toBeNull();

      const list = await svc.listForClientByCoach('coach-A', 'client-1');
      expect(list).toHaveLength(1);
      expect(list[0].title).toBe('Cut week 1');
    });

    it('updates title/notes/items', async () => {
      const p = await svc.createForClient('coach-A', 'client-1', goodPlan as any);
      const updated = await svc.updateByCoach('coach-A', p.id, {
        title: 'Cut week 2',
        notes: 'more carbs',
        items: [{ name: 'Rice' }],
      } as any);
      expect(updated.title).toBe('Cut week 2');
      expect(updated.notes).toBe('more carbs');
      expect((updated.items as any[]).map((i: any) => i.name)).toEqual(['Rice']);
    });

    it('soft-archives: list excludes archived', async () => {
      const p = await svc.createForClient('coach-A', 'client-1', goodPlan as any);
      const r = await svc.archiveByCoach('coach-A', p.id);
      expect(r).toEqual({ archived: 1 });
      const list = await svc.listForClientByCoach('coach-A', 'client-1');
      expect(list).toHaveLength(0);
    });

    it('double-archive returns 404 on second call', async () => {
      const p = await svc.createForClient('coach-A', 'client-1', goodPlan as any);
      await svc.archiveByCoach('coach-A', p.id);
      await expect(svc.archiveByCoach('coach-A', p.id)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('update for archived plan → 404', async () => {
      const p = await svc.createForClient('coach-A', 'client-1', goodPlan as any);
      await svc.archiveByCoach('coach-A', p.id);
      await expect(
        svc.updateByCoach('coach-A', p.id, { title: 'no' } as any),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('authorization', () => {
    it("coach cannot create a plan for another coach's client (404)", async () => {
      await expect(
        svc.createForClient('coach-A', 'client-other', goodPlan as any),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("coach cannot update another coach's plan (404)", async () => {
      // coach-B creates a plan for their own client
      const p = await svc.createForClient('coach-B', 'client-other', goodPlan as any);
      // coach-A attempts to update it
      await expect(
        svc.updateByCoach('coach-A', p.id, { title: 'stolen' } as any),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("coach cannot archive another coach's plan (404)", async () => {
      const p = await svc.createForClient('coach-B', 'client-other', goodPlan as any);
      await expect(
        svc.archiveByCoach('coach-A', p.id),
      ).rejects.toBeInstanceOf(NotFoundException);
      // still not archived
      expect(prisma._plans[0].archived_at).toBeNull();
    });

    it("client cannot see another client's plans (list is scoped)", async () => {
      await svc.createForClient('coach-A', 'client-1', { ...goodPlan, title: 'for 1' } as any);
      await svc.createForClient('coach-A', 'client-2', { ...goodPlan, title: 'for 2' } as any);
      const l1 = await svc.listForClient('client-1');
      expect(l1).toHaveLength(1);
      expect(l1[0].title).toBe('for 1');
    });

    it("client cannot fetch another client's plan by id (404)", async () => {
      const p = await svc.createForClient('coach-A', 'client-2', goodPlan as any);
      await expect(
        svc.getOneForClient('client-1', p.id),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('client cannot see archived plans', async () => {
      const p = await svc.createForClient('coach-A', 'client-1', goodPlan as any);
      await svc.archiveByCoach('coach-A', p.id);
      const list = await svc.listForClient('client-1');
      expect(list).toHaveLength(0);
      await expect(
        svc.getOneForClient('client-1', p.id),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('client reads', () => {
    it('client sees all their coach-assigned plans, newest first', async () => {
      const base = Date.now();
      for (let i = 0; i < 3; i++) {
        await svc.createForClient('coach-A', 'client-1', {
          ...goodPlan,
          title: `plan-${i}`,
        } as any);
        prisma._plans[i].created_at = new Date(base + i * 1000);
      }
      const list = await svc.listForClient('client-1');
      expect(list.map((p) => p.title)).toEqual(['plan-2', 'plan-1', 'plan-0']);
    });
  });
});
