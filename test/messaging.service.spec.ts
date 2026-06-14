import { ConflictException, NotFoundException } from '@nestjs/common';
import { MessagingService } from '../src/messaging/messaging.service';

// In-memory Prisma mock for CoachMessage + User. Lets us exercise the full
// send → thread → read-marker → unread-count flow without a live database.
function makePrisma() {
  const users: Array<{ id: string; role: string; coach_id: string | null }> = [];
  const messages: Array<{
    id: string;
    coach_id: string;
    client_id: string;
    sender_id: string;
    body: string;
    created_at: Date;
    read_at: Date | null;
  }> = [];
  // ED.6 — per-thread coach-review markers (one row per coach/client pair).
  const reviews: Array<{
    id: string;
    coach_id: string;
    client_id: string;
    coach_reviewed_at: Date;
  }> = [];

  let seq = 0;
  const newId = () => `m-${++seq}`;

  const matches = (row: any, where: any): boolean => {
    if (!where) return true;
    for (const [k, v] of Object.entries(where)) {
      if (k === 'NOT') {
        if (matches(row, v)) return false;
        continue;
      }
      if (k === 'AND') {
        for (const clause of v as any[]) {
          if (!matches(row, clause)) return false;
        }
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
      if (typeof v === 'object' && v !== null && ('lt' in v || 'gt' in v || 'gte' in v || 'lte' in v || 'in' in v || 'not' in v)) {
        if ('lt' in v && !(val < (v as any).lt)) return false;
        if ('gt' in v && !(val > (v as any).gt)) return false;
        if ('gte' in v && !(val >= (v as any).gte)) return false;
        if ('lte' in v && !(val <= (v as any).lte)) return false;
        if ('in' in v && !((v as any).in as any[]).includes(val)) return false;
        if ('not' in v && val === (v as any).not) return false;
        continue;
      }
      if (val !== v) return false;
    }
    return true;
  };

  return {
    _users: users,
    _messages: messages,
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
    coachMessage: {
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: newId(),
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
      findMany: jest.fn(async ({ where, orderBy, take }: any) => {
        let out = messages.filter((m) => matches(m, where));
        if (orderBy?.created_at === 'desc') out.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
        if (orderBy?.created_at === 'asc') out.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
        if (take) out = out.slice(0, take);
        return out.map((m) => ({ ...m }));
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const m of messages) {
          if (matches(m, where)) {
            Object.assign(m, data);
            count++;
          }
        }
        return { count };
      }),
      groupBy: jest.fn(async ({ by, where }: any) => {
        const rows = messages.filter((m) => matches(m, where));
        const groups = new Map<string, number>();
        for (const r of rows) {
          const key = by.map((b: string) => (r as any)[b]).join('|');
          groups.set(key, (groups.get(key) ?? 0) + 1);
        }
        const out: any[] = [];
        for (const [key, count] of groups) {
          const parts = key.split('|');
          const g: any = { _count: { _all: count } };
          by.forEach((b: string, i: number) => (g[b] = parts[i]));
          out.push(g);
        }
        return out;
      }),
      count: jest.fn(async ({ where }: any) => messages.filter((m) => matches(m, where)).length),
    },
    // ED.6 — ConversationReview marker. Keyed on the composite unique
    // (coach_id, client_id), addressed through the named key the service uses.
    conversationReview: {
      _rows: reviews,
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const key = where.ConversationReview_coach_client_key;
        const existing = reviews.find(
          (r) => r.coach_id === key.coach_id && r.client_id === key.client_id,
        );
        if (existing) {
          Object.assign(existing, update);
          return { ...existing };
        }
        const row = {
          id: newId(),
          coach_id: create.coach_id,
          client_id: create.client_id,
          coach_reviewed_at: create.coach_reviewed_at ?? new Date(),
        };
        reviews.push(row);
        return { ...row };
      }),
      findUnique: jest.fn(async ({ where, select }: any) => {
        const key = where.ConversationReview_coach_client_key;
        const row = reviews.find(
          (r) => r.coach_id === key.coach_id && r.client_id === key.client_id,
        );
        if (!row) return null;
        if (select) {
          const out: any = {};
          for (const k of Object.keys(select)) if (select[k]) out[k] = (row as any)[k];
          return out;
        }
        return { ...row };
      }),
    },
  };
}

describe('MessagingService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: MessagingService;

  beforeEach(() => {
    prisma = makePrisma();
    prisma._users.push(
      { id: 'coach-A', role: 'coach', coach_id: null },
      { id: 'coach-B', role: 'coach', coach_id: null },
      { id: 'client-1', role: 'student', coach_id: 'coach-A' },
      { id: 'client-2', role: 'student', coach_id: 'coach-A' },
      { id: 'client-other', role: 'student', coach_id: 'coach-B' },
      { id: 'client-orphan', role: 'student', coach_id: null },
    );
    // Stub the SupabaseService — Realtime broadcasts are best-effort and
    // unrelated to the messaging-service unit under test.
    const supabaseStub = { broadcastNewMessage: jest.fn().mockResolvedValue(undefined) } as any;
    const analyticsStub = { capture: jest.fn(), identify: jest.fn() } as any;
    const ptmStub = { emit: jest.fn() } as any;
    const messageReceivedStub = { emit: jest.fn().mockResolvedValue(undefined) } as any;
    const auditStub = { write: jest.fn().mockResolvedValue(undefined) } as any;
    svc = new MessagingService(
      prisma as any,
      supabaseStub,
      analyticsStub,
      ptmStub,
      messageReceivedStub,
      auditStub,
      { invalidateForUser: jest.fn() } as any,
    );
  });

  describe('send flows', () => {
    it('coach sends → client sees the message in their thread', async () => {
      await svc.sendAsCoach('coach-A', 'client-1', 'hi from coach');
      const thread = await svc.listThreadForClient('client-1', {});
      expect(thread).toHaveLength(1);
      expect(thread[0].body).toBe('hi from coach');
      expect(thread[0].sender_id).toBe('coach-A');
      expect(thread[0].coach_id).toBe('coach-A');
      expect(thread[0].client_id).toBe('client-1');
    });

    it('client sends → coach sees the message in their thread', async () => {
      await svc.sendAsClient('client-1', 'hi from client');
      const thread = await svc.listThreadForCoach('coach-A', 'client-1', {});
      expect(thread).toHaveLength(1);
      expect(thread[0].sender_id).toBe('client-1');
      expect(thread[0].body).toBe('hi from client');
    });

    it('stamps coach_id from the client record (client cannot spoof coach_id)', async () => {
      await svc.sendAsClient('client-1', 'hello');
      expect(prisma._messages[0].coach_id).toBe('coach-A');
    });
  });

  describe('authorization', () => {
    it("coach cannot read another coach's thread (404)", async () => {
      await svc.sendAsCoach('coach-B', 'client-other', 'private');
      await expect(
        svc.listThreadForCoach('coach-A', 'client-other', {}),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("coach cannot send into another coach's thread (404)", async () => {
      await expect(
        svc.sendAsCoach('coach-A', 'client-other', 'nope'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('client without coach gets 409 on list/send', async () => {
      await expect(svc.listThreadForClient('client-orphan', {})).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(svc.sendAsClient('client-orphan', 'hi')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('pagination', () => {
    it('`before` cursor returns strictly-older rows and respects limit', async () => {
      const base = Date.now();
      for (let i = 0; i < 10; i++) {
        await svc.sendAsCoach('coach-A', 'client-1', `m${i}`);
        prisma._messages[i].created_at = new Date(base + i * 1000);
      }
      const page1 = await svc.listThreadForClient('client-1', { limit: 3 });
      expect(page1).toHaveLength(3);
      expect(page1.map((m) => m.body)).toEqual(['m9', 'm8', 'm7']);

      const page2 = await svc.listThreadForClient('client-1', {
        limit: 3,
        before: page1[page1.length - 1].created_at.toISOString(),
      });
      expect(page2.map((m) => m.body)).toEqual(['m6', 'm5', 'm4']);
    });

    it('default limit is 50 and max is 100', async () => {
      for (let i = 0; i < 120; i++) await svc.sendAsCoach('coach-A', 'client-1', `m${i}`);
      const def = await svc.listThreadForClient('client-1', {});
      expect(def).toHaveLength(50);
      const huge = await svc.listThreadForClient('client-1', { limit: 999 });
      expect(huge).toHaveLength(100);
    });
  });

  describe('read markers', () => {
    it('coach marking read only touches client→coach messages (not the coach\'s own)', async () => {
      await svc.sendAsClient('client-1', 'from client 1');
      await svc.sendAsClient('client-1', 'from client 2');
      await svc.sendAsCoach('coach-A', 'client-1', 'from coach — should stay unread');

      const result = await svc.markReadByCoach('coach-A', 'client-1');
      expect(result).toEqual({ updated: 2 });
      const thread = await svc.listThreadForCoach('coach-A', 'client-1', {});
      const coachMsg = thread.find((m) => m.sender_id === 'coach-A')!;
      const clientMsgs = thread.filter((m) => m.sender_id === 'client-1');
      expect(coachMsg.read_at).toBeNull();
      for (const m of clientMsgs) expect(m.read_at).toBeInstanceOf(Date);
    });

    it('client marking read only touches coach→client messages', async () => {
      await svc.sendAsCoach('coach-A', 'client-1', 'c1');
      await svc.sendAsCoach('coach-A', 'client-1', 'c2');
      await svc.sendAsClient('client-1', 'me');
      const result = await svc.markReadByClient('client-1');
      expect(result).toEqual({ updated: 2 });
      const thread = await svc.listThreadForClient('client-1', {});
      const myMsg = thread.find((m) => m.sender_id === 'client-1')!;
      expect(myMsg.read_at).toBeNull();
    });

    it('is idempotent — second call returns updated=0 and keeps original timestamps', async () => {
      await svc.sendAsClient('client-1', 'hi');
      await svc.markReadByCoach('coach-A', 'client-1');
      const firstReadAt = prisma._messages[0].read_at;
      const again = await svc.markReadByCoach('coach-A', 'client-1');
      expect(again).toEqual({ updated: 0 });
      expect(prisma._messages[0].read_at).toBe(firstReadAt);
    });
  });

  // ED.6 — coach thread-review marker stamped on markReadByCoach and read back
  // for the client. Verifies the flag gate, most-recent re-stamp, the client
  // read shape, and that a marker failure never fails the coach read.
  describe('coach thread-review marker (ED.6)', () => {
    const FLAG = 'FEATURE_ROMAN_COACH_REVIEWED_AT';
    let prev: string | undefined;
    beforeEach(() => {
      prev = process.env[FLAG];
    });
    afterEach(() => {
      if (prev === undefined) delete process.env[FLAG];
      else process.env[FLAG] = prev;
    });

    it('flag ON: markReadByCoach stamps a ConversationReview marker', async () => {
      process.env[FLAG] = 'true';
      await svc.sendAsClient('client-1', 'hi');
      await svc.markReadByCoach('coach-A', 'client-1');
      expect(prisma.conversationReview._rows).toHaveLength(1);
      expect(prisma.conversationReview._rows[0]).toMatchObject({
        coach_id: 'coach-A',
        client_id: 'client-1',
      });
      expect(prisma.conversationReview._rows[0].coach_reviewed_at).toBeInstanceOf(
        Date,
      );
    });

    it('flag OFF: markReadByCoach writes NO marker', async () => {
      process.env[FLAG] = 'false';
      await svc.sendAsClient('client-1', 'hi');
      await svc.markReadByCoach('coach-A', 'client-1');
      expect(prisma.conversationReview._rows).toHaveLength(0);
    });

    it('flag UNSET defaults OFF (no marker)', async () => {
      delete process.env[FLAG];
      await svc.sendAsClient('client-1', 'hi');
      await svc.markReadByCoach('coach-A', 'client-1');
      expect(prisma.conversationReview._rows).toHaveLength(0);
    });

    it('most-recent semantics: a second read re-stamps the same single marker', async () => {
      process.env[FLAG] = 'true';
      await svc.sendAsClient('client-1', 'hi');
      await svc.markReadByCoach('coach-A', 'client-1');
      const t1 = prisma.conversationReview._rows[0].coach_reviewed_at.getTime();
      await new Promise((r) => setTimeout(r, 5));
      await svc.sendAsClient('client-1', 'again');
      await svc.markReadByCoach('coach-A', 'client-1');
      expect(prisma.conversationReview._rows).toHaveLength(1);
      expect(
        prisma.conversationReview._rows[0].coach_reviewed_at.getTime(),
      ).toBeGreaterThanOrEqual(t1);
    });

    it('coachReviewForClient returns the ISO timestamp when a marker exists', async () => {
      process.env[FLAG] = 'true';
      await svc.sendAsClient('client-1', 'hi');
      await svc.markReadByCoach('coach-A', 'client-1');
      const out = await svc.coachReviewForClient('client-1');
      expect(out.coachReviewedAt).toEqual(expect.any(String));
      expect(Number.isNaN(Date.parse(out.coachReviewedAt!))).toBe(false);
    });

    it('coachReviewForClient returns null when no marker exists', async () => {
      const out = await svc.coachReviewForClient('client-1');
      expect(out.coachReviewedAt).toBeNull();
    });

    it('marker upsert failure does not fail the coach read acknowledgement', async () => {
      process.env[FLAG] = 'true';
      await svc.sendAsClient('client-1', 'hi');
      (prisma.conversationReview.upsert as jest.Mock).mockRejectedValueOnce(
        new Error('boom'),
      );
      const result = await svc.markReadByCoach('coach-A', 'client-1');
      expect(result).toEqual({ updated: 1 });
    });
  });

  describe('unread counts', () => {
    it('coach unread: total + per-client breakdown, excludes coach-sent rows', async () => {
      await svc.sendAsClient('client-1', 'a');
      await svc.sendAsClient('client-1', 'b');
      await svc.sendAsClient('client-2', 'c');
      await svc.sendAsCoach('coach-A', 'client-1', 'coach-sent not counted');

      const out = await svc.unreadCountForCoach('coach-A');
      expect(out.total).toBe(3);
      expect(out.by_client['client-1']).toBe(2);
      expect(out.by_client['client-2']).toBe(1);
    });

    it('coach unread ignores messages in another coach\'s thread', async () => {
      await svc.sendAsClient('client-other', 'for B only');
      const out = await svc.unreadCountForCoach('coach-A');
      expect(out.total).toBe(0);
    });

    it('client unread counts only coach→client unread messages', async () => {
      await svc.sendAsCoach('coach-A', 'client-1', 'hi');
      await svc.sendAsCoach('coach-A', 'client-1', 'hi2');
      await svc.sendAsClient('client-1', 'me'); // own message — not counted
      const out = await svc.unreadCountForClient('client-1');
      expect(out).toEqual({ total: 2 });
    });

    it('orphan client (no coach) returns {total:0} instead of 409 — mobile polls this', async () => {
      const out = await svc.unreadCountForClient('client-orphan');
      expect(out).toEqual({ total: 0 });
    });

    // P1-2 regression: sub-coach messages share the head-coach thread but have
    // sender_id = subCoachId. The pre-fix filter (sender_id = coachId) missed
    // them entirely — client-side unread badge stayed at 0 and mark-read left
    // them permanently unread. The fix uses sender_id != clientId.
    describe('sub-coach senders in the head-coach thread (P1-2)', () => {
      const SUB_COACH = 'sub-coach-1';

      const seedSubCoachMessage = (body: string) => {
        prisma._messages.push({
          id: `m-sub-${prisma._messages.length + 1}`,
          coach_id: 'coach-A',
          client_id: 'client-1',
          sender_id: SUB_COACH,
          body,
          created_at: new Date(),
          read_at: null,
        });
      };

      it('sub-coach send increments the client unread count', async () => {
        seedSubCoachMessage('from sub-coach');
        const out = await svc.unreadCountForClient('client-1');
        expect(out).toEqual({ total: 1 });
      });

      it('client mark-read clears sub-coach messages too', async () => {
        seedSubCoachMessage('from sub-coach');
        const result = await svc.markReadByClient('client-1');
        expect(result).toEqual({ updated: 1 });
        const after = await svc.unreadCountForClient('client-1');
        expect(after).toEqual({ total: 0 });
      });

      it('head-coach message still counted + marked read (no regression)', async () => {
        await svc.sendAsCoach('coach-A', 'client-1', 'from head coach');
        seedSubCoachMessage('from sub-coach');
        const before = await svc.unreadCountForClient('client-1');
        expect(before).toEqual({ total: 2 });
        const marked = await svc.markReadByClient('client-1');
        expect(marked).toEqual({ updated: 2 });
        const after = await svc.unreadCountForClient('client-1');
        expect(after).toEqual({ total: 0 });
      });

      it('client own message is never counted or marked', async () => {
        await svc.sendAsClient('client-1', 'me');
        seedSubCoachMessage('from sub-coach');
        const out = await svc.unreadCountForClient('client-1');
        expect(out).toEqual({ total: 1 });
        await svc.markReadByClient('client-1');
        const own = prisma._messages.find((m) => m.sender_id === 'client-1')!;
        expect(own.read_at).toBeNull();
      });
    });
  });
});
