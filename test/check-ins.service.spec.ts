import { NotFoundException } from '@nestjs/common';
import { CheckInsService } from '../src/check-ins/check-ins.service';

// In-memory Prisma mock for CheckIn + User. Implements upsert with the
// Tier-2 unique (user_id, date) constraint so the service's idempotent
// "one row per client per day" behavior can be verified without a database.
function makePrisma() {
  const users: Array<{ id: string; role: string; coach_id: string | null }> = [];
  const rows: Array<{
    id: string;
    user_id: string;
    coach_id: string | null;
    date: Date;
    mood: number | null;
    energy: number | null;
    soreness: number;
    sleep_hours: number | null;
    weight_kg: number | null;
    notes: string | null;
    type: string;
    logged_at: Date;
  }> = [];

  let seq = 0;
  const newId = () => `ci-${++seq}`;

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
      if (val instanceof Date && v instanceof Date) {
        if (val.getTime() !== v.getTime()) return false;
        continue;
      }
      if (val !== v) return false;
    }
    return true;
  };

  return {
    _users: users,
    _rows: rows,
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
      findUnique: jest.fn(async ({ where, select }: any) => {
        const row = users.find((u) => u.id === where.id);
        if (!row) return null;
        if (select) {
          const out: any = {};
          for (const k of Object.keys(select)) if (select[k]) out[k] = (row as any)[k];
          return out;
        }
        return { ...row };
      }),
    },
    checkIn: {
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const key = where.CheckIn_user_id_date_key;
        const existing = rows.find(
          (r) => r.user_id === key.user_id && r.date.getTime() === new Date(key.date).getTime(),
        );
        if (existing) {
          Object.assign(existing, update);
          return { ...existing };
        }
        const row = {
          id: newId(),
          user_id: create.user_id,
          coach_id: create.coach_id ?? null,
          date: create.date,
          mood: create.mood ?? null,
          energy: create.energy ?? null,
          soreness: create.soreness ?? 0,
          sleep_hours: create.sleep_hours ?? null,
          weight_kg: create.weight_kg ?? null,
          notes: create.notes ?? null,
          type: create.type ?? 'morning',
          logged_at: new Date(),
        };
        rows.push(row);
        return { ...row };
      }),
      findMany: jest.fn(async ({ where, orderBy, take }: any) => {
        let out = rows.filter((r) => matches(r, where));
        if (orderBy?.date === 'desc') out.sort((a, b) => b.date.getTime() - a.date.getTime());
        if (orderBy?.date === 'asc') out.sort((a, b) => a.date.getTime() - b.date.getTime());
        if (take) out = out.slice(0, take);
        return out.map((r) => ({ ...r }));
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        const row = rows.find((r) => matches(r, where));
        return row ? { ...row } : null;
      }),
    },
  };
}

describe('CheckInsService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: CheckInsService;

  beforeEach(() => {
    prisma = makePrisma();
    prisma._users.push(
      { id: 'coach-A', role: 'coach', coach_id: null },
      { id: 'coach-B', role: 'coach', coach_id: null },
      { id: 'client-1', role: 'student', coach_id: 'coach-A' },
      { id: 'client-2', role: 'student', coach_id: 'coach-A' },
      { id: 'client-other', role: 'student', coach_id: 'coach-B' },
      { id: 'client-solo', role: 'student', coach_id: null },
    );
    svc = new CheckInsService(prisma as any);
  });

  describe('upsert', () => {
    it('creates a check-in on first POST of a day', async () => {
      const r = await svc.upsertForClient('client-1', {
        date: '2026-04-24',
        mood: 4,
        energy: 3,
        sleep_hours: 7.5,
        weight_kg: 80,
        notes: 'felt good',
      } as any);
      expect(r.user_id).toBe('client-1');
      expect(r.coach_id).toBe('coach-A');
      expect(r.mood).toBe(4);
      expect(prisma._rows).toHaveLength(1);
    });

    it('updates in place on second POST of the same day (idempotent)', async () => {
      await svc.upsertForClient('client-1', {
        date: '2026-04-24',
        mood: 4,
      } as any);
      const second = await svc.upsertForClient('client-1', {
        date: '2026-04-24',
        mood: 2,
        notes: 'actually, worse',
      } as any);
      expect(prisma._rows).toHaveLength(1);
      expect(second.mood).toBe(2);
      expect(second.notes).toBe('actually, worse');
    });

    it('treats same-day ISO datetimes as one day (collapses to midnight UTC)', async () => {
      await svc.upsertForClient('client-1', {
        date: '2026-04-24T08:00:00Z',
      } as any);
      await svc.upsertForClient('client-1', {
        date: '2026-04-24T22:00:00Z',
      } as any);
      expect(prisma._rows).toHaveLength(1);
    });

    it('different days produce different rows', async () => {
      await svc.upsertForClient('client-1', { date: '2026-04-24' } as any);
      await svc.upsertForClient('client-1', { date: '2026-04-25' } as any);
      expect(prisma._rows).toHaveLength(2);
    });

    it("stamps coach_id from the client's current coach_id at creation time", async () => {
      await svc.upsertForClient('client-1', { date: '2026-04-24' } as any);
      expect(prisma._rows[0].coach_id).toBe('coach-A');
    });

    it("stores null coach_id when the client has no coach", async () => {
      await svc.upsertForClient('client-solo', { date: '2026-04-24' } as any);
      expect(prisma._rows[0].coach_id).toBeNull();
    });

    it('does not rewrite coach_id on later upserts (historical coach-of-record stays pinned)', async () => {
      await svc.upsertForClient('client-1', { date: '2026-04-24' } as any);
      // simulate client switching coaches
      const me = prisma._users.find((u) => u.id === 'client-1')!;
      me.coach_id = 'coach-B';
      await svc.upsertForClient('client-1', { date: '2026-04-24', mood: 5 } as any);
      expect(prisma._rows).toHaveLength(1);
      expect(prisma._rows[0].coach_id).toBe('coach-A');
      expect(prisma._rows[0].mood).toBe(5);
    });
  });

  describe('client reads', () => {
    it('list scopes to caller (cannot see another client\'s)', async () => {
      await svc.upsertForClient('client-1', { date: '2026-04-24' } as any);
      await svc.upsertForClient('client-2', { date: '2026-04-24' } as any);
      const l1 = await svc.listForClient('client-1', {} as any);
      expect(l1).toHaveLength(1);
      expect(l1[0].user_id).toBe('client-1');
    });

    it("getOne returns 404 for another client's row", async () => {
      await svc.upsertForClient('client-2', { date: '2026-04-24' } as any);
      const foreignId = prisma._rows[0].id;
      await expect(
        svc.getOneForClient('client-1', foreignId),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('from/to window filters results', async () => {
      await svc.upsertForClient('client-1', { date: '2026-04-20' } as any);
      await svc.upsertForClient('client-1', { date: '2026-04-22' } as any);
      await svc.upsertForClient('client-1', { date: '2026-04-24' } as any);
      const mid = await svc.listForClient('client-1', {
        from: '2026-04-21',
        to: '2026-04-23',
      } as any);
      expect(mid.map((r) => r.date.toISOString().slice(0, 10))).toEqual(['2026-04-22']);
    });
  });

  describe('coach reads', () => {
    it("coach can read their client's check-ins", async () => {
      await svc.upsertForClient('client-1', { date: '2026-04-24' } as any);
      const list = await svc.listForClientByCoach('coach-A', 'client-1', {} as any);
      expect(list).toHaveLength(1);
    });

    it("coach cannot read another coach's client (404)", async () => {
      await svc.upsertForClient('client-other', { date: '2026-04-24' } as any);
      await expect(
        svc.listForClientByCoach('coach-A', 'client-other', {} as any),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('defaults to last 30 days when from is absent', async () => {
      // Very old check-in (should be out of default 30-day window)
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - 60);
      await svc.upsertForClient('client-1', { date: d.toISOString() } as any);
      // Recent check-in
      await svc.upsertForClient('client-1', {
        date: new Date().toISOString(),
      } as any);
      const list = await svc.listForClientByCoach('coach-A', 'client-1', {} as any);
      expect(list).toHaveLength(1); // only the recent one
    });
  });
});
