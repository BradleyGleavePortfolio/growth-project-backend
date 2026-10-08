import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { V1CoachService } from '../src/v1/v1-coach.service';
import { PrismaService } from '../src/prisma.service';
import { SupabaseService } from '../src/supabase/supabase.service';
import { AuditService } from '../src/audit/audit.service';
import { SubCoachScopeService } from '../src/sub-coach/sub-coach-scope.service';
import { ConsentService } from '../src/consent/consent.service';

/**
 * SUBCOACH-SCOPE-V1-132 (owner decision 10; the B-878-SOL-I-131-1 fix, on the
 * coach console routes under /v1/coach/me/threads): a sub-coach's scope is
 * `{ id: { in: assignedIds } }`. Spread into `{ id: clientId, ...scope }` it
 * replaced the requested id, so the lookup found one of the sub-coach's own
 * clients and the read or write that followed used the requested id: a
 * sub-coach could open, post in, or draft in the thread of a client who is
 * not assigned to them. The fake below evaluates the real `where` (AND,
 * equality, `in`) instead of always answering null, so the scope is tested
 * as Postgres reads it.
 */
type UserRow = {
  id: string;
  name: string;
  email: string;
  coach_id: string | null;
  role: string;
  archived_at: Date | null;
  created_at: Date;
};
type MessageRow = {
  id: string;
  coach_id: string;
  client_id: string;
  sender_id: string;
  body: string;
  created_at: Date;
  read_at: Date | null;
};
type DraftRow = { coach_id: string; client_id: string; body: string; snippet_id: string | null; updated_at: Date };
type DraftKey = { MessageDraft_coach_client_key: { coach_id: string; client_id: string } };
type Where = Record<string, unknown>;

function matches(row: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Where[]).every((w) => matches(row, w));
    const cell = row[key];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const ops = Object.keys(cond);
      if (ops.length !== 1 || ops[0] !== 'in') throw new Error(`fake: unsupported where on ${key}: ${ops.join(',')}`);
      return (cond as { in: unknown[] }).in.includes(cell);
    }
    return cell === cond;
  });
}

const HEAD = 'head-coach';
const SUB = 'sub-coach';
const OTHER_HEAD = 'other-head-coach';

function coach(id: string): { id: string; role: 'coach' } {
  return { id, role: 'coach' };
}

function makeWorld() {
  const users: UserRow[] = [
    { id: 'mine', name: 'Assigned', email: 'mine@example.test', coach_id: HEAD, role: 'student', archived_at: null, created_at: new Date('2026-09-01T00:00:00Z') },
    { id: 'theirs', name: 'Not assigned', email: 'theirs@example.test', coach_id: HEAD, role: 'student', archived_at: null, created_at: new Date('2026-09-02T00:00:00Z') },
  ];
  const messages: MessageRow[] = [
    { id: 'm-mine', coach_id: HEAD, client_id: 'mine', sender_id: 'mine', body: 'From the assigned client', created_at: new Date('2026-10-01T10:00:00Z'), read_at: null },
    { id: 'm-theirs', coach_id: HEAD, client_id: 'theirs', sender_id: 'theirs', body: 'From the unassigned client', created_at: new Date('2026-10-01T11:00:00Z'), read_at: null },
  ];
  const drafts: DraftRow[] = [
    { coach_id: HEAD, client_id: 'theirs', body: 'Head coach draft', snippet_id: null, updated_at: new Date('2026-10-01T12:00:00Z') },
  ];
  const findDraft = ({ MessageDraft_coach_client_key: k }: DraftKey) =>
    drafts.find((d) => d.coach_id === k.coach_id && d.client_id === k.client_id);

  const prisma = {
    user: {
      findFirst: jest.fn(async ({ where }: { where: Where }) => {
        const row = users.find((u) => matches(u, where));
        return row ? { ...row } : null;
      }),
      findMany: jest.fn(async ({ where }: { where: Where }) => users.filter((u) => matches(u, where)).map((u) => ({ ...u }))),
    },
    coachMessage: {
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        messages.filter((m) => matches(m, where)).map((m) => ({ ...m })),
      ),
      create: jest.fn(async ({ data }: { data: Pick<MessageRow, 'coach_id' | 'client_id' | 'sender_id' | 'body'> }) => {
        const row: MessageRow = { id: `m-${messages.length + 1}`, ...data, created_at: new Date(), read_at: null };
        messages.push(row);
        return { ...row };
      }),
      groupBy: jest.fn(async () => []),
    },
    messageDraft: {
      findUnique: jest.fn(async ({ where }: { where: DraftKey }) => {
        const d = findDraft(where);
        return d ? { ...d } : null;
      }),
      upsert: jest.fn(
        async ({ where, create, update }: { where: DraftKey; create: Omit<DraftRow, 'updated_at'>; update: Pick<DraftRow, 'body' | 'snippet_id'> }) => {
          const existing = findDraft(where);
          if (existing) {
            Object.assign(existing, update, { updated_at: new Date() });
            return { ...existing };
          }
          const row: DraftRow = { ...create, updated_at: new Date() };
          drafts.push(row);
          return { ...row };
        },
      ),
      delete: jest.fn(async ({ where }: { where: DraftKey }) => {
        const d = findDraft(where);
        if (!d) throw Object.assign(new Error('fake: draft not found'), { code: 'P2025' });
        drafts.splice(drafts.indexOf(d), 1);
        return d;
      }),
    },
    activityEvent: { create: jest.fn(async () => ({})) },
    checkIn: { groupBy: jest.fn(async () => []) },
    workoutSession: { groupBy: jest.fn(async () => []) },
  };
  return { users, messages, drafts, prisma };
}

describe('SUBCOACH-SCOPE-V1-132 — a sub-coach reaches only the client threads assigned to them', () => {
  let world: ReturnType<typeof makeWorld>;
  let service: V1CoachService;
  let supabase: { broadcastNewMessage: jest.Mock };

  beforeEach(async () => {
    world = makeWorld();
    supabase = { broadcastNewMessage: jest.fn(async () => undefined) };
    const mod = await Test.createTestingModule({
      providers: [
        V1CoachService,
        { provide: PrismaService, useValue: world.prisma },
        { provide: SupabaseService, useValue: supabase },
        { provide: AuditService, useValue: { write: jest.fn(async () => undefined) } },
        {
          provide: SubCoachScopeService,
          useValue: {
            isSubCoach: jest.fn(async (id: string) => id === SUB),
            getAuthorizedClientIds: jest.fn(async (id: string) => (id === SUB ? ['mine'] : [])),
            getHeadCoachIdForSubCoach: jest.fn(async (id: string) => (id === SUB ? HEAD : null)),
          },
        },
        { provide: ConsentService, useValue: { grantedScopesByClient: jest.fn(async () => new Map()) } },
      ],
    }).compile();
    service = mod.get(V1CoachService);
  });

  it('Open thread: an unassigned client id is refused before any message or draft is read', async () => {
    await expect(service.getThread(coach(SUB), 'theirs')).rejects.toBeInstanceOf(NotFoundException);
    expect(world.prisma.coachMessage.findMany).not.toHaveBeenCalled();
    expect(world.prisma.messageDraft.findUnique).not.toHaveBeenCalled();
  });

  it('Send: a message to an unassigned client is refused, nothing is written or pushed, and the head coach draft stays', async () => {
    await expect(service.sendMessage(coach(SUB), 'theirs', 'Hello')).rejects.toBeInstanceOf(NotFoundException);
    expect(world.prisma.coachMessage.create).not.toHaveBeenCalled();
    expect(world.messages).toHaveLength(2);
    expect(supabase.broadcastNewMessage).not.toHaveBeenCalled();
    expect(world.drafts).toHaveLength(1);
  });

  it('Draft: saving, clearing or reading an unassigned client draft is refused and the head coach draft stays', async () => {
    await expect(service.saveDraft(coach(SUB), 'theirs', 'Overwritten')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.saveDraft(coach(SUB), 'theirs', '')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getDraft(coach(SUB), 'theirs')).rejects.toBeInstanceOf(NotFoundException);
    expect(world.prisma.messageDraft.upsert).not.toHaveBeenCalled();
    expect(world.prisma.messageDraft.delete).not.toHaveBeenCalled();
    expect(world.drafts).toEqual([expect.objectContaining({ client_id: 'theirs', body: 'Head coach draft' })]);
  });

  it('the assigned client still works for the sub-coach, under the head coach thread', async () => {
    const thread = await service.getThread(coach(SUB), 'mine');
    expect(thread).toMatchObject({ clientId: 'mine', clientName: 'Assigned' });
    expect(thread.messages.map((m) => m.id)).toEqual(['m-mine']);

    await expect(service.sendMessage(coach(SUB), 'mine', 'On it')).resolves.toMatchObject({
      coachId: HEAD,
      clientId: 'mine',
      from: 'coach',
    });
    expect(world.messages[world.messages.length - 1]).toMatchObject({ coach_id: HEAD, client_id: 'mine', sender_id: SUB });

    await expect(service.saveDraft(coach(SUB), 'mine', 'Next week')).resolves.toMatchObject({
      coachId: HEAD,
      clientId: 'mine',
      cleared: false,
    });
    await expect(service.getDraft(coach(SUB), 'mine')).resolves.toMatchObject({ body: 'Next week' });
  });

  it('the head coach keeps every client of the roster, and another head coach is refused', async () => {
    await expect(service.getThread(coach(HEAD), 'theirs')).resolves.toMatchObject({
      clientId: 'theirs',
      clientName: 'Not assigned',
      draft: { body: 'Head coach draft' },
    });
    await expect(service.getDraft(coach(HEAD), 'theirs')).resolves.toMatchObject({ body: 'Head coach draft' });
    await expect(service.sendMessage(coach(HEAD), 'theirs', 'Checking in')).resolves.toMatchObject({
      coachId: HEAD,
      clientId: 'theirs',
    });
    await expect(service.saveDraft(coach(HEAD), 'mine', 'Plan for Monday')).resolves.toMatchObject({ coachId: HEAD, clientId: 'mine' });

    await expect(service.getThread(coach(OTHER_HEAD), 'theirs')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.sendMessage(coach(OTHER_HEAD), 'theirs', 'Hello')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('the roster list (listClients) shows a sub-coach only the assigned client and the head coach the whole roster', async () => {
    const sub = await service.listClients(coach(SUB));
    expect(sub.map((c) => c.id)).toEqual(['mine']);
    const head = await service.listClients(coach(HEAD));
    expect(head.map((c) => c.id).sort()).toEqual(['mine', 'theirs']);
  });
});
