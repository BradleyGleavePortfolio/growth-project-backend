import { NotFoundException } from '@nestjs/common';
import { NudgesService } from '../src/nudges/nudges.service';

// In-memory Prisma mock for CoachNudge + User. Mirrors the shape used in
// messaging.service.spec so the two test suites look and feel the same.
function makePrisma() {
  const users: Array<{ id: string; role: string; coach_id: string | null }> = [];
  const nudges: Array<{
    id: string;
    coach_id: string;
    client_id: string;
    title: string;
    body: string;
    created_at: Date;
    read_at: Date | null;
  }> = [];

  let seq = 0;
  const newId = () => `n-${++seq}`;

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
    _nudges: nudges,
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
    coachNudge: {
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: newId(),
          coach_id: data.coach_id,
          client_id: data.client_id,
          title: data.title,
          body: data.body,
          created_at: new Date(),
          read_at: null,
        };
        nudges.push(row);
        return { ...row };
      }),
      findMany: jest.fn(async ({ where, orderBy, take }: any) => {
        let out = nudges.filter((n) => matches(n, where));
        if (orderBy?.created_at === 'desc') out.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
        if (orderBy?.created_at === 'asc') out.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
        if (take) out = out.slice(0, take);
        return out.map((n) => ({ ...n }));
      }),
      findFirst: jest.fn(async ({ where, select }: any) => {
        const row = nudges.find((n) => matches(n, where));
        if (!row) return null;
        if (select) {
          const out: any = {};
          for (const k of Object.keys(select)) if (select[k]) out[k] = (row as any)[k];
          return out;
        }
        return { ...row };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const n of nudges) {
          if (matches(n, where)) {
            Object.assign(n, data);
            count++;
          }
        }
        return { count };
      }),
      count: jest.fn(async ({ where }: any) => nudges.filter((n) => matches(n, where)).length),
    },
  };
}

describe('NudgesService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: NudgesService;

  beforeEach(() => {
    prisma = makePrisma();
    prisma._users.push(
      { id: 'coach-A', role: 'coach', coach_id: null },
      { id: 'coach-B', role: 'coach', coach_id: null },
      { id: 'client-1', role: 'student', coach_id: 'coach-A' },
      { id: 'client-2', role: 'student', coach_id: 'coach-A' },
      { id: 'client-other', role: 'student', coach_id: 'coach-B' },
    );
    svc = new NudgesService(prisma as any);
  });

  describe('create', () => {
    it('coach sends a nudge → appears in the client\'s list', async () => {
      await svc.createForClient('coach-A', 'client-1', 'Hydrate!', 'Drink water.');
      const list = await svc.listForClient('client-1', {});
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        coach_id: 'coach-A',
        client_id: 'client-1',
        title: 'Hydrate!',
        body: 'Drink water.',
        read_at: null,
      });
    });

    it('stamps coach_id from the authenticated coach (cannot be overridden)', async () => {
      await svc.createForClient('coach-A', 'client-1', 't', 'b');
      expect(prisma._nudges[0].coach_id).toBe('coach-A');
    });
  });

  describe('authorization', () => {
    it("coach cannot send to another coach's client (404)", async () => {
      await expect(
        svc.createForClient('coach-A', 'client-other', 't', 'b'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("client cannot see another client's nudges — listForClient scopes to client_id", async () => {
      await svc.createForClient('coach-A', 'client-1', 'for 1', 'body');
      await svc.createForClient('coach-A', 'client-2', 'for 2', 'body');
      const list1 = await svc.listForClient('client-1', {});
      const list2 = await svc.listForClient('client-2', {});
      expect(list1).toHaveLength(1);
      expect(list1[0].title).toBe('for 1');
      expect(list2).toHaveLength(1);
      expect(list2[0].title).toBe('for 2');
    });

    it("client cannot mark another client's nudge read (404)", async () => {
      await svc.createForClient('coach-A', 'client-2', 't', 'b');
      const foreignId = prisma._nudges[0].id;
      await expect(
        svc.markReadByClient('client-1', foreignId),
      ).rejects.toBeInstanceOf(NotFoundException);
      // And the nudge stays unread.
      expect(prisma._nudges[0].read_at).toBeNull();
    });

    it('missing nudge id returns 404', async () => {
      await expect(
        svc.markReadByClient('client-1', 'does-not-exist'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('list pagination', () => {
    it('returns newest-first and applies default limit 20', async () => {
      const base = Date.now();
      for (let i = 0; i < 25; i++) {
        await svc.createForClient('coach-A', 'client-1', `t${i}`, 'b');
        prisma._nudges[i].created_at = new Date(base + i * 1000);
      }
      const list = await svc.listForClient('client-1', {});
      expect(list).toHaveLength(20);
      expect(list[0].title).toBe('t24');
    });

    it('respects custom limit up to max 100', async () => {
      const base = Date.now();
      for (let i = 0; i < 120; i++) {
        await svc.createForClient('coach-A', 'client-1', `t${i}`, 'b');
        prisma._nudges[i].created_at = new Date(base + i * 1000);
      }
      const huge = await svc.listForClient('client-1', { limit: 999 });
      expect(huge).toHaveLength(100);
      const five = await svc.listForClient('client-1', { limit: 5 });
      expect(five).toHaveLength(5);
    });

    it('`since` filter returns strictly-newer rows', async () => {
      const base = Date.now();
      for (let i = 0; i < 5; i++) {
        await svc.createForClient('coach-A', 'client-1', `t${i}`, 'b');
        prisma._nudges[i].created_at = new Date(base + i * 1000);
      }
      const cutoff = new Date(base + 2 * 1000).toISOString();
      const list = await svc.listForClient('client-1', { since: cutoff });
      // t3, t4 are strictly after t2; t2 itself is excluded.
      expect(list.map((n) => n.title)).toEqual(['t4', 't3']);
    });
  });

  describe('unread count', () => {
    it('counts only unread nudges for this client and decrements after read', async () => {
      await svc.createForClient('coach-A', 'client-1', 't1', 'b');
      await svc.createForClient('coach-A', 'client-1', 't2', 'b');
      await svc.createForClient('coach-A', 'client-1', 't3', 'b');
      // Noise: nudge for a different client shouldn't count.
      await svc.createForClient('coach-A', 'client-2', 'noise', 'b');

      let out = await svc.unreadCountForClient('client-1');
      expect(out).toEqual({ total: 3 });

      const firstId = prisma._nudges[0].id;
      const result = await svc.markReadByClient('client-1', firstId);
      expect(result).toEqual({ updated: 1 });

      out = await svc.unreadCountForClient('client-1');
      expect(out).toEqual({ total: 2 });
    });

    it('returns {total:0} when client has no nudges', async () => {
      const out = await svc.unreadCountForClient('client-1');
      expect(out).toEqual({ total: 0 });
    });
  });

  describe('read marker idempotency', () => {
    it('second mark-read call returns updated=0 and keeps original timestamp', async () => {
      await svc.createForClient('coach-A', 'client-1', 't', 'b');
      const id = prisma._nudges[0].id;
      await svc.markReadByClient('client-1', id);
      const firstReadAt = prisma._nudges[0].read_at;
      const again = await svc.markReadByClient('client-1', id);
      expect(again).toEqual({ updated: 0 });
      expect(prisma._nudges[0].read_at).toBe(firstReadAt);
    });
  });
});
