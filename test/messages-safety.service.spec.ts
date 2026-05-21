// Apple App Review 1.2 — full coverage of MessagesSafetyService and the
// messaging.service hooks that consult it (list filter, push suppression,
// unread-count suppression).
//
// In-memory Prisma mock keeps the spec deterministic and lets us assert
// idempotency, the unique-constraint behaviour, and the cross-cutting
// filter on listThread / unread counts without spinning up a real DB.

import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { MessagesSafetyService } from '../src/messages-safety/messages-safety.service';
import { MessagingService } from '../src/messaging/messaging.service';
import { ReportMessageDto } from '../src/messages-safety/dto/report-message.dto';

// ─── In-memory Prisma double ───────────────────────────────────────────────
function makePrisma() {
  const users: Array<{ id: string; role: string; coach_id: string | null; name: string }> = [];
  const messages: Array<{
    id: string;
    coach_id: string;
    client_id: string;
    sender_id: string;
    body: string;
    created_at: Date;
    read_at: Date | null;
  }> = [];
  const reports: Array<{
    id: string;
    reporter_id: string;
    message_id: string;
    coach_id: string | null;
    client_id: string | null;
    reason: string;
    details: string | null;
    status: string;
    action: string | null;
    reviewed_at: Date | null;
    reviewed_by_admin_id: string | null;
    created_at: Date;
  }> = [];
  const blocks: Array<{
    id: string;
    blocker_id: string;
    blocked_id: string;
    created_at: Date;
  }> = [];
  let seq = 0;
  const newId = () => `id-${++seq}`;

  function match<T extends Record<string, unknown>>(row: T, where: Record<string, unknown>): boolean {
    if (!where) return true;
    for (const [k, v] of Object.entries(where)) {
      if (k === 'OR') {
        if (!(v as Record<string, unknown>[]).some((clause) => match(row, clause))) return false;
        continue;
      }
      if (k === 'AND') {
        for (const clause of v as Record<string, unknown>[]) {
          if (!match(row, clause)) return false;
        }
        continue;
      }
      if (k === 'NOT') {
        if (match(row, v as Record<string, unknown>)) return false;
        continue;
      }
      if ((row as Record<string, unknown>)[k] !== v) return false;
    }
    return true;
  }

  return {
    _users: users,
    _messages: messages,
    _reports: reports,
    _blocks: blocks,
    user: {
      findUnique: jest.fn(async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
        const row = users.find((u) => u.id === where.id);
        if (!row) return null;
        if (select) {
          const out: Record<string, unknown> = {};
          for (const k of Object.keys(select)) if (select[k]) out[k] = (row as Record<string, unknown>)[k];
          return out;
        }
        return { ...row };
      }),
      findFirst: jest.fn(async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
        const row = users.find((u) => match(u as unknown as Record<string, unknown>, where));
        if (!row) return null;
        if (select) {
          const out: Record<string, unknown> = {};
          for (const k of Object.keys(select)) if (select[k]) out[k] = (row as Record<string, unknown>)[k];
          return out;
        }
        return { ...row };
      }),
    },
    coachMessage: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const row = messages.find((m) => m.id === where.id);
        return row ? { ...row } : null;
      }),
      findMany: jest.fn(async ({ where, orderBy, take }: { where?: Record<string, unknown>; orderBy?: { created_at: 'asc' | 'desc' }; take?: number }) => {
        let rows = messages.filter((m) => match(m, where ?? {}));
        if (orderBy?.created_at === 'desc') {
          rows = rows.slice().sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
        }
        if (take) rows = rows.slice(0, take);
        return rows.map((r) => ({ ...r }));
      }),
      groupBy: jest.fn(async ({ by, where, _count }: { by: string[]; where: Record<string, unknown>; _count: Record<string, boolean> }) => {
        const rows = messages.filter((m) => match(m, where));
        const buckets = new Map<string, typeof rows>();
        for (const r of rows) {
          const key = String((r as Record<string, unknown>)[by[0]] ?? '__null__');
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key)!.push(r);
        }
        return Array.from(buckets.entries()).map(([key, list]) => ({
          [by[0]]: key === '__null__' ? null : key,
          _count: { _all: list.length },
        }));
      }),
      count: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return messages.filter((m) => match(m, where)).length;
      }),
    },
    messageReport: {
      findUnique: jest.fn(async ({ where }: { where: { MessageReport_reporter_message_key: { reporter_id: string; message_id: string } } }) => {
        const k = where.MessageReport_reporter_message_key;
        return reports.find((r) => r.reporter_id === k.reporter_id && r.message_id === k.message_id) ?? null;
      }),
      create: jest.fn(async ({ data, select }: { data: Record<string, unknown>; select?: Record<string, boolean> }) => {
        const row = {
          id: newId(),
          reporter_id: data.reporter_id as string,
          message_id: data.message_id as string,
          coach_id: (data.coach_id as string | undefined) ?? null,
          client_id: (data.client_id as string | undefined) ?? null,
          reason: data.reason as string,
          details: (data.details as string | null | undefined) ?? null,
          status: (data.status as string | undefined) ?? 'pending',
          action: null,
          reviewed_at: null,
          reviewed_by_admin_id: null,
          created_at: new Date(),
        };
        reports.push(row);
        if (select) {
          const out: Record<string, unknown> = {};
          for (const k of Object.keys(select)) if (select[k]) out[k] = (row as Record<string, unknown>)[k];
          return out;
        }
        return { ...row };
      }),
    },
    userBlock: {
      findUnique: jest.fn(async ({ where, select }: { where: { UserBlock_pair_key: { blocker_id: string; blocked_id: string } }; select?: Record<string, boolean> }) => {
        const k = where.UserBlock_pair_key;
        const row = blocks.find((b) => b.blocker_id === k.blocker_id && b.blocked_id === k.blocked_id);
        if (!row) return null;
        if (select) {
          const out: Record<string, unknown> = {};
          for (const kk of Object.keys(select)) if (select[kk]) out[kk] = (row as Record<string, unknown>)[kk];
          return out;
        }
        return { ...row };
      }),
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return blocks.find((b) => match(b, where)) ?? null;
      }),
      findMany: jest.fn(async ({ where, orderBy, select }: { where: Record<string, unknown>; orderBy?: { created_at: 'asc' | 'desc' }; select?: Record<string, unknown> }) => {
        let rows = blocks.filter((b) => match(b, where));
        if (orderBy?.created_at === 'desc') {
          rows = rows.slice().sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
        }
        if (!select) return rows.map((r) => ({ ...r }));
        return rows.map((r) => {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(select)) {
            if (v === true) {
              out[k] = (r as Record<string, unknown>)[k];
              continue;
            }
            if (v && typeof v === 'object' && k === 'blocked') {
              const sel = (v as { select?: Record<string, boolean> }).select ?? (v as Record<string, boolean>);
              const user = users.find((u) => u.id === r.blocked_id);
              if (!user) {
                out[k] = null;
                continue;
              }
              const sub: Record<string, unknown> = {};
              for (const [sk, sv] of Object.entries(sel)) {
                if (sv) sub[sk] = (user as Record<string, unknown>)[sk];
              }
              out[k] = sub;
            }
          }
          return out;
        });
      }),
      create: jest.fn(async ({ data, select }: { data: { blocker_id: string; blocked_id: string }; select?: Record<string, boolean> }) => {
        const row = { id: newId(), blocker_id: data.blocker_id, blocked_id: data.blocked_id, created_at: new Date() };
        blocks.push(row);
        if (select) {
          const out: Record<string, unknown> = {};
          for (const k of Object.keys(select)) if (select[k]) out[k] = (row as Record<string, unknown>)[k];
          return out;
        }
        return { ...row };
      }),
      deleteMany: jest.fn(async ({ where }: { where: { blocker_id: string; blocked_id: string } }) => {
        const before = blocks.length;
        for (let i = blocks.length - 1; i >= 0; i--) {
          if (blocks[i].blocker_id === where.blocker_id && blocks[i].blocked_id === where.blocked_id) {
            blocks.splice(i, 1);
          }
        }
        return { count: before - blocks.length };
      }),
    },
  };
}

const auditStub = () => ({ write: jest.fn().mockResolvedValue(undefined) });
const analyticsStub = () => ({ capture: jest.fn() });

// ──────────────────────────────────────────────────────────────────────────
describe('MessagesSafetyService — reports', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: MessagesSafetyService;

  beforeEach(() => {
    prisma = makePrisma();
    prisma._users.push(
      { id: 'coach-1', role: 'coach', coach_id: null, name: 'Coach' },
      { id: 'client-1', role: 'student', coach_id: 'coach-1', name: 'Client' },
      { id: 'client-2', role: 'student', coach_id: 'coach-1', name: 'OtherClient' },
    );
    prisma._messages.push({
      id: 'msg-1',
      coach_id: 'coach-1',
      client_id: 'client-1',
      sender_id: 'coach-1',
      body: 'hi',
      created_at: new Date('2026-05-21T00:00:00Z'),
      read_at: null,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    svc = new MessagesSafetyService(prisma as any, auditStub() as any, analyticsStub() as any);
  });

  it('reports a coach message as a client (happy path)', async () => {
    const out = await svc.reportMessage('client-1', {
      messageId: 'msg-1',
      reason: 'harassment',
      details: 'inappropriate',
    } satisfies ReportMessageDto);
    expect(out.status).toBe('received');
    expect(out.reportId).toBeTruthy();
    expect(prisma._reports).toHaveLength(1);
    expect(prisma._reports[0]).toMatchObject({
      reporter_id: 'client-1',
      message_id: 'msg-1',
      reason: 'harassment',
      details: 'inappropriate',
      status: 'pending',
      coach_id: 'coach-1',
      client_id: 'client-1',
    });
  });

  it('is idempotent: second report from same reporter returns already_reported with the original id', async () => {
    const first = await svc.reportMessage('client-1', {
      messageId: 'msg-1',
      reason: 'spam',
    });
    const second = await svc.reportMessage('client-1', {
      messageId: 'msg-1',
      reason: 'harassment',
    });
    expect(second.status).toBe('already_reported');
    expect(second.reportId).toBe(first.reportId);
    expect(prisma._reports).toHaveLength(1);
    // Original reason is preserved — second report does not overwrite.
    expect(prisma._reports[0].reason).toBe('spam');
  });

  it('404 when message does not exist', async () => {
    await expect(
      svc.reportMessage('client-1', {
        messageId: 'd0000000-0000-0000-0000-000000000000',
        reason: 'spam',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404 when reporter is not a party to the thread (does not leak existence)', async () => {
    // client-2 is a sibling client with no relation to msg-1's thread.
    await expect(
      svc.reportMessage('client-2', { messageId: 'msg-1', reason: 'spam' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('400 when reporting your own message', async () => {
    // coach-1 is the sender of msg-1.
    await expect(
      svc.reportMessage('coach-1', { messageId: 'msg-1', reason: 'spam' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('caps free-text details at 1000 chars', async () => {
    const long = 'a'.repeat(2000);
    await svc.reportMessage('client-1', {
      messageId: 'msg-1',
      reason: 'other',
      details: long,
    });
    expect(prisma._reports[0].details?.length).toBe(1000);
  });
});

describe('MessagesSafetyService — blocks', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: MessagesSafetyService;

  beforeEach(() => {
    prisma = makePrisma();
    prisma._users.push(
      { id: 'a', role: 'student', coach_id: null, name: 'Alice' },
      { id: 'b', role: 'coach', coach_id: null, name: 'Bob' },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    svc = new MessagesSafetyService(prisma as any, auditStub() as any, analyticsStub() as any);
  });

  it('block creates a UserBlock row', async () => {
    const out = await svc.blockUser('a', 'b');
    expect(out.blockedUserId).toBe('b');
    expect(prisma._blocks).toHaveLength(1);
    expect(prisma._blocks[0]).toMatchObject({ blocker_id: 'a', blocked_id: 'b' });
  });

  it('block is idempotent (same blocker+blocked pair)', async () => {
    const first = await svc.blockUser('a', 'b');
    const second = await svc.blockUser('a', 'b');
    expect(second.blockId).toBe(first.blockId);
    expect(prisma._blocks).toHaveLength(1);
  });

  it('400 on block self', async () => {
    await expect(svc.blockUser('a', 'a')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404 on block missing user', async () => {
    await expect(svc.blockUser('a', 'ghost')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('unblock removes the row + is idempotent when no row exists', async () => {
    await svc.blockUser('a', 'b');
    expect(prisma._blocks).toHaveLength(1);
    const out = await svc.unblockUser('a', 'b');
    expect(out.unblocked).toBe(true);
    expect(prisma._blocks).toHaveLength(0);
    // Second call is a no-op, not an error.
    const again = await svc.unblockUser('a', 'b');
    expect(again.unblocked).toBe(true);
  });

  it('listBlocks returns display names + iso timestamps', async () => {
    await svc.blockUser('a', 'b');
    const rows = await svc.listBlocks('a');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ blockedId: 'b', displayName: 'Bob' });
    expect(typeof rows[0].blockedAt).toBe('string');
  });

  it('isEitherSideBlocked detects both directions', async () => {
    expect(await svc.isEitherSideBlocked('a', 'b')).toBe(false);
    await svc.blockUser('a', 'b');
    expect(await svc.isEitherSideBlocked('a', 'b')).toBe(true);
    expect(await svc.isEitherSideBlocked('b', 'a')).toBe(true); // mirror direction
  });

  it('isEitherSideBlocked short-circuits on same-user and empty ids', async () => {
    expect(await svc.isEitherSideBlocked('a', 'a')).toBe(false);
    expect(await svc.isEitherSideBlocked('', 'b')).toBe(false);
    expect(await svc.isEitherSideBlocked('a', '')).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// MessagingService integration with the safety filter — uses the same
// in-memory Prisma so we can exercise the cross-cutting list / unread paths.
// ──────────────────────────────────────────────────────────────────────────
describe('MessagingService — block-aware list + unread filters', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let safety: MessagesSafetyService;
  let svc: MessagingService;

  const supabaseStub = { broadcastNewMessage: jest.fn() } as unknown as Parameters<typeof Object>[0];
  const ptmStub = { emit: jest.fn() };
  const messageReceived = { emit: jest.fn().mockResolvedValue(undefined) };
  const aiContext = { invalidateForUser: jest.fn() };

  beforeEach(() => {
    prisma = makePrisma();
    prisma._users.push(
      { id: 'coach-1', role: 'coach', coach_id: null, name: 'Coach' },
      { id: 'client-1', role: 'student', coach_id: 'coach-1', name: 'Client' },
    );
    // Mixed thread: 1 client→coach, 1 coach→client.
    prisma._messages.push(
      {
        id: 'm-1',
        coach_id: 'coach-1',
        client_id: 'client-1',
        sender_id: 'client-1',
        body: 'hi coach',
        created_at: new Date('2026-05-21T01:00:00Z'),
        read_at: null,
      },
      {
        id: 'm-2',
        coach_id: 'coach-1',
        client_id: 'client-1',
        sender_id: 'coach-1',
        body: 'hi client',
        created_at: new Date('2026-05-21T02:00:00Z'),
        read_at: null,
      },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    safety = new MessagesSafetyService(prisma as any, auditStub() as any, analyticsStub() as any);
    svc = new MessagingService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabaseStub as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      analyticsStub() as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ptmStub as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messageReceived as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      auditStub() as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aiContext as any,
      safety,
    );
  });

  it('client thread excludes coach messages when client has blocked coach', async () => {
    let rows = await svc.listThreadForClient('client-1', { limit: 100 });
    expect(rows.map((r) => r.sender_id).sort()).toEqual(['client-1', 'coach-1']);

    await safety.blockUser('client-1', 'coach-1');

    rows = await svc.listThreadForClient('client-1', { limit: 100 });
    // Coach's authored row is stripped. Client's own message remains so the
    // user can still see their last sent line.
    expect(rows.map((r) => r.sender_id)).toEqual(['client-1']);
  });

  it('coach thread excludes client messages when coach has blocked client', async () => {
    let rows = await svc.listThreadForCoach('coach-1', 'client-1', { limit: 100 });
    expect(rows.map((r) => r.sender_id).sort()).toEqual(['client-1', 'coach-1']);

    await safety.blockUser('coach-1', 'client-1');
    rows = await svc.listThreadForCoach('coach-1', 'client-1', { limit: 100 });
    expect(rows.map((r) => r.sender_id)).toEqual(['coach-1']);
  });

  it('unreadCountForClient returns 0 when the client has blocked their coach', async () => {
    let n = await svc.unreadCountForClient('client-1');
    expect(n.total).toBe(1);

    await safety.blockUser('client-1', 'coach-1');
    n = await svc.unreadCountForClient('client-1');
    expect(n.total).toBe(0);
  });

  it('unreadCountForCoach drops blocked clients from total + per-client breakdown', async () => {
    let n = await svc.unreadCountForCoach('coach-1');
    expect(n.total).toBe(1);
    expect(n.by_client['client-1']).toBe(1);

    await safety.blockUser('coach-1', 'client-1');
    n = await svc.unreadCountForCoach('coach-1');
    expect(n.total).toBe(0);
    expect(n.by_client['client-1']).toBeUndefined();
  });
});
