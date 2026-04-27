import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { V1CoachService } from '../src/v1/v1-coach.service';

// In-memory Prisma stub for the V1 BFF service. Mirrors the shape used by
// test/messaging.service.spec.ts but adds the new tables this PR introduces:
// MessageDraft, ActivityEvent, CoachProfile, CoachSubscription. We deliberately
// avoid an ORM-grade implementation; just enough behavior to exercise scoping,
// OWNER bypass, draft idempotency, and the message-send fan-out.
function makePrisma() {
  const users: any[] = [];
  const messages: any[] = [];
  const drafts: any[] = [];
  const events: any[] = [];
  const profiles: any[] = [];
  const subscriptions: any[] = [];
  const checkIns: any[] = [];
  const workouts: any[] = [];

  let seq = 0;
  const newId = (p: string) => `${p}-${++seq}`;

  const matches = (row: any, where: any): boolean => {
    if (!where) return true;
    for (const [k, v] of Object.entries(where)) {
      if (k === 'AND') {
        for (const c of v as any[]) if (!matches(row, c)) return false;
        continue;
      }
      if (k === 'OR') {
        if (!(v as any[]).some((c) => matches(row, c))) return false;
        continue;
      }
      if (k === 'NOT') {
        if (matches(row, v)) return false;
        continue;
      }
      const val = (row as any)[k];
      if (v === null) {
        if (val !== null && val !== undefined) return false;
        continue;
      }
      if (typeof v === 'object' && v !== null) {
        if ('in' in v && !(v as any).in.includes(val)) return false;
        if ('lt' in v && !(val < (v as any).lt)) return false;
        if ('gt' in v && !(val > (v as any).gt)) return false;
        if ('gte' in v && !(val >= (v as any).gte)) return false;
        if ('lte' in v && !(val <= (v as any).lte)) return false;
        continue;
      }
      if (val !== v) return false;
    }
    return true;
  };

  const compare = (a: any, b: any) => (a < b ? -1 : a > b ? 1 : 0);

  return {
    _users: users,
    _messages: messages,
    _drafts: drafts,
    _events: events,
    _subscriptions: subscriptions,
    _profiles: profiles,
    _checkIns: checkIns,
    _workouts: workouts,
    user: {
      findUnique: jest.fn(async ({ where, select }: any) => {
        const row = users.find((u) => matches(u, where));
        if (!row) return null;
        if (select) {
          const out: any = {};
          for (const k of Object.keys(select)) {
            const sel = select[k];
            if (sel === true) out[k] = row[k];
            else if (typeof sel === 'object') {
              // nested include like profile: { select: { avatar_url: true } }
              out[k] = row[k] ?? null;
            }
          }
          return out;
        }
        return { ...row };
      }),
      findFirst: jest.fn(async ({ where, select }: any) => {
        const row = users.find((u) => matches(u, where));
        if (!row) return null;
        if (select) {
          const out: any = {};
          for (const k of Object.keys(select)) if (select[k]) out[k] = row[k];
          return out;
        }
        return { ...row };
      }),
      findMany: jest.fn(async ({ where, orderBy, select }: any) => {
        let out = users.filter((u) => matches(u, where));
        if (orderBy) {
          const [k, dir] = Object.entries(orderBy)[0] as [string, string];
          out.sort((a, b) => (dir === 'desc' ? compare(b[k], a[k]) : compare(a[k], b[k])));
        }
        if (select) {
          return out.map((row) => {
            const o: any = {};
            for (const k of Object.keys(select)) {
              const sel = select[k];
              if (sel === true) o[k] = row[k];
              else if (typeof sel === 'object') o[k] = row[k] ?? null;
            }
            return o;
          });
        }
        return out.map((u) => ({ ...u }));
      }),
    },
    coachMessage: {
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: newId('m'),
          coach_id: data.coach_id,
          client_id: data.client_id,
          sender_id: data.sender_id,
          body: data.body,
          created_at: new Date(),
          read_at: null,
        };
        messages.push(row);
        return { ...row };
      }),
      findMany: jest.fn(async ({ where, orderBy, select }: any) => {
        let out = messages.filter((m) => matches(m, where));
        if (orderBy?.created_at === 'desc') out.sort((a, b) => b.created_at - a.created_at);
        if (orderBy?.created_at === 'asc') out.sort((a, b) => a.created_at - b.created_at);
        if (select) return out.map((m) => {
          const o: any = {};
          for (const k of Object.keys(select)) if (select[k]) o[k] = m[k];
          return o;
        });
        return out.map((m) => ({ ...m }));
      }),
      groupBy: jest.fn(async ({ by, where, _max }: any) => {
        const rows = messages.filter((m) => matches(m, where));
        const groups = new Map<string, any[]>();
        for (const r of rows) {
          const key = by.map((b: string) => r[b]).join('|');
          (groups.get(key) ?? groups.set(key, []).get(key))!.push(r);
        }
        const out: any[] = [];
        for (const [key, gs] of groups) {
          const parts = key.split('|');
          const g: any = {};
          by.forEach((b: string, i: number) => (g[b] = parts[i]));
          if (_max) {
            g._max = {};
            for (const k of Object.keys(_max)) {
              g._max[k] = gs.reduce((acc, r) => (acc === null || r[k] > acc ? r[k] : acc), null);
            }
          }
          out.push(g);
        }
        return out;
      }),
    },
    messageDraft: {
      findUnique: jest.fn(async ({ where }: any) => {
        const key = where.MessageDraft_coach_client_key;
        return drafts.find((d) => d.coach_id === key.coach_id && d.client_id === key.client_id) ?? null;
      }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const key = where.MessageDraft_coach_client_key;
        const existing = drafts.find((d) => d.coach_id === key.coach_id && d.client_id === key.client_id);
        if (existing) {
          Object.assign(existing, update, { updated_at: new Date() });
          return { ...existing };
        }
        const row = {
          id: newId('d'),
          coach_id: create.coach_id,
          client_id: create.client_id,
          body: create.body,
          snippet_id: create.snippet_id,
          created_at: new Date(),
          updated_at: new Date(),
        };
        drafts.push(row);
        return { ...row };
      }),
      delete: jest.fn(async ({ where }: any) => {
        const key = where.MessageDraft_coach_client_key;
        const i = drafts.findIndex((d) => d.coach_id === key.coach_id && d.client_id === key.client_id);
        if (i === -1) {
          const err: any = new Error('Not found');
          err.code = 'P2025';
          throw err;
        }
        const [row] = drafts.splice(i, 1);
        return row;
      }),
    },
    activityEvent: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: newId('e'), ...data, created_at: new Date() };
        events.push(row);
        return { ...row };
      }),
    },
    coachProfile: {
      findUnique: jest.fn(async ({ where }: any) => {
        return profiles.find((p) => matches(p, where)) ?? null;
      }),
    },
    coachSubscription: {
      findUnique: jest.fn(async ({ where }: any) => {
        return subscriptions.find((s) => matches(s, where)) ?? null;
      }),
    },
    checkIn: {
      groupBy: jest.fn(async ({ by, where, _max }: any) => {
        const rows = checkIns.filter((c) => matches(c, where));
        const groups = new Map<string, any[]>();
        for (const r of rows) {
          const key = by.map((b: string) => r[b]).join('|');
          (groups.get(key) ?? groups.set(key, []).get(key))!.push(r);
        }
        const out: any[] = [];
        for (const [key, gs] of groups) {
          const parts = key.split('|');
          const g: any = {};
          by.forEach((b: string, i: number) => (g[b] = parts[i]));
          if (_max) {
            g._max = {};
            for (const k of Object.keys(_max)) {
              g._max[k] = gs.reduce((acc, r) => (acc === null || r[k] > acc ? r[k] : acc), null);
            }
          }
          out.push(g);
        }
        return out;
      }),
    },
    workoutSession: {
      groupBy: jest.fn(async ({ by, where, _max }: any) => {
        const rows = workouts.filter((c) => matches(c, where));
        const groups = new Map<string, any[]>();
        for (const r of rows) {
          const key = by.map((b: string) => r[b]).join('|');
          (groups.get(key) ?? groups.set(key, []).get(key))!.push(r);
        }
        const out: any[] = [];
        for (const [key, gs] of groups) {
          const parts = key.split('|');
          const g: any = {};
          by.forEach((b: string, i: number) => (g[b] = parts[i]));
          if (_max) {
            g._max = {};
            for (const k of Object.keys(_max)) {
              g._max[k] = gs.reduce((acc, r) => (acc === null || r[k] > acc ? r[k] : acc), null);
            }
          }
          out.push(g);
        }
        return out;
      }),
    },
  };
}

describe('V1CoachService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: V1CoachService;

  beforeEach(() => {
    prisma = makePrisma();
    prisma._users.push(
      { id: 'coach-A', name: 'Coach A', email: 'coach-a@x.com', role: 'coach', coach_id: null, archived_at: null, created_at: new Date('2026-01-01'), profile: { avatar_url: null } },
      { id: 'coach-B', name: 'Coach B', email: 'coach-b@x.com', role: 'coach', coach_id: null, archived_at: null, created_at: new Date('2026-01-01'), profile: { avatar_url: null } },
      { id: 'owner-1', name: 'Owner', email: 'o@x.com', role: 'owner', coach_id: null, archived_at: null, created_at: new Date('2026-01-01'), profile: { avatar_url: null } },
      { id: 'client-1', name: 'C1', email: 'c1@x.com', role: 'student', coach_id: 'coach-A', archived_at: null, created_at: new Date('2026-01-02'), profile: { avatar_url: null } },
      { id: 'client-2', name: 'C2', email: 'c2@x.com', role: 'student', coach_id: 'coach-A', archived_at: null, created_at: new Date('2026-01-03'), profile: { avatar_url: null } },
      { id: 'client-other', name: 'C3', email: 'c3@x.com', role: 'student', coach_id: 'coach-B', archived_at: null, created_at: new Date('2026-01-04'), profile: { avatar_url: null } },
    );
    const supabaseStub = { broadcastNewMessage: jest.fn().mockResolvedValue(undefined) } as any;
    svc = new V1CoachService(prisma as any, supabaseStub);
  });

  const coach = (id: string) => ({ id, role: 'coach' as const });
  const owner = () => ({ id: 'owner-1', role: 'owner' as const });
  const student = () => ({ id: 'client-1', role: 'student' as const });

  describe('scoping', () => {
    it('coach cannot send into another coach\'s thread', async () => {
      await expect(
        svc.sendMessage(coach('coach-A'), 'client-other', 'hi'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('coach cannot read another coach\'s draft', async () => {
      await expect(
        svc.getDraft(coach('coach-A'), 'client-other'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('owner can send into any thread (owner bypass)', async () => {
      const out = await svc.sendMessage(owner(), 'client-other', 'admin nudge');
      expect(out.body).toBe('admin nudge');
      // The persisted row keeps the actual coach as coach_id, not the owner.
      expect(prisma._messages[0].coach_id).toBe('coach-B');
      expect(prisma._messages[0].sender_id).toBe('owner-1');
    });

    it('rejects students at the role layer', async () => {
      await expect(svc.sendMessage(student(), 'client-1', 'no')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('sendMessage', () => {
    it('writes message + activity event + clears draft + pings supabase', async () => {
      // Pre-existing draft
      await svc.saveDraft(coach('coach-A'), 'client-1', 'in progress', undefined);
      expect(prisma._drafts).toHaveLength(1);
      const result = await svc.sendMessage(coach('coach-A'), 'client-1', 'hello there', 'acknowledge');
      expect(result.body).toBe('hello there');
      expect(result.snippetId).toBe('acknowledge');
      expect(prisma._messages).toHaveLength(1);
      // Allow async best-effort side effects to settle.
      await new Promise((r) => setImmediate(r));
      // Activity event recorded with snippet id in payload
      const evt = prisma._events.find((e) => e.type === 'coach.message_sent');
      expect(evt).toBeTruthy();
      expect(evt.payload.snippetId).toBe('acknowledge');
      // Draft cleared after send
      expect(prisma._drafts).toHaveLength(0);
    });

    it('strips an empty snippetId on activity payload', async () => {
      await svc.sendMessage(coach('coach-A'), 'client-1', 'plain', undefined);
      await new Promise((r) => setImmediate(r));
      const evt = prisma._events.find((e) => e.type === 'coach.message_sent');
      expect(evt.payload.snippetId).toBeNull();
    });
  });

  describe('saveDraft / getDraft', () => {
    it('upserts on (coachId, clientId) — second save overwrites in place', async () => {
      const a = await svc.saveDraft(coach('coach-A'), 'client-1', 'first', undefined);
      const b = await svc.saveDraft(coach('coach-A'), 'client-1', 'second', 'pullback');
      expect(prisma._drafts).toHaveLength(1);
      expect(b.body).toBe('second');
      expect(b.snippetId).toBe('pullback');
      expect(b.updatedAt.getTime()).toBeGreaterThanOrEqual(a.updatedAt.getTime());
    });

    it('empty body clears the draft and returns cleared:true', async () => {
      await svc.saveDraft(coach('coach-A'), 'client-1', 'something', undefined);
      const cleared = await svc.saveDraft(coach('coach-A'), 'client-1', '   ', undefined);
      expect(cleared.cleared).toBe(true);
      expect(prisma._drafts).toHaveLength(0);
    });

    it('getDraft returns null when nothing is saved', async () => {
      const out = await svc.getDraft(coach('coach-A'), 'client-1');
      expect(out).toBeNull();
    });
  });

  describe('listThreads', () => {
    it('returns one row per thread, sorted newest-first, with unread counts', async () => {
      await svc.sendMessage(coach('coach-A'), 'client-1', 'a1', undefined);
      await svc.sendMessage(coach('coach-A'), 'client-2', 'b1', undefined);
      // Manual back-from-client message — bypass send path so the helper can
      // directly insert a row originating from the client.
      prisma._messages.push({
        id: 'mx-1',
        coach_id: 'coach-A',
        client_id: 'client-1',
        sender_id: 'client-1',
        body: 'reply',
        created_at: new Date(Date.now() + 1000),
        read_at: null,
      });
      const threads = await svc.listThreads(coach('coach-A'));
      expect(threads).toHaveLength(2);
      const t1 = threads.find((t) => t.clientId === 'client-1')!;
      expect(t1.lastFrom).toBe('client');
      expect(t1.unreadCount).toBe(1);
      const t2 = threads.find((t) => t.clientId === 'client-2')!;
      expect(t2.unreadCount).toBe(0);
    });
  });
});
