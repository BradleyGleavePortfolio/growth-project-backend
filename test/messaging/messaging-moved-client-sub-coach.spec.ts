/**
 * B-DP-4-2: a client who moved from head coach H to coach B must be out of
 * reach of H's sub-coach S, even though S's delegation row for that client is
 * still open (a coach move does not close it). S gets the same 404 that a
 * non-member gets on every coach-side thread path, and keeps working for H's
 * current clients. Uses the real SubCoachScopeService over an in-memory store.
 */
import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../src/prisma.service';
import { SupabaseService } from '../../src/supabase/supabase.service';
import { AnalyticsService } from '../../src/analytics/analytics.service';
import { PtmService } from '../../src/ptm/ptm.service';
import { MessageReceivedEmitter } from '../../src/notifications/emitters/message-received.emitter';
import { AuditService } from '../../src/audit/audit.service';
import { ClientAIContextService } from '../../src/ai/client-ai-context.service';
import { MessagesSafetyService } from '../../src/messages-safety/messages-safety.service';
import { SubCoachScopeService } from '../../src/sub-coach/sub-coach-scope.service';
import { MessagingService } from '../../src/messaging/messaging.service';

const HEAD = 'head-coach-h';
const NEW_COACH = 'coach-b';
const SUB = 'sub-coach-s';
const OUTSIDER = 'coach-x';
const MOVED = 'client-moved';
const CURRENT = 'client-current';

type Row = Record<string, unknown>;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'in' in (v as Row)) {
      return (v as { in: unknown[] }).in.includes(row[k]);
    }
    return (row[k] ?? null) === v;
  });
}

function fixture() {
  const users: Row[] = [
    { id: HEAD, role: 'coach', coach_id: null, deleted_at: null },
    { id: NEW_COACH, role: 'coach', coach_id: null, deleted_at: null },
    { id: OUTSIDER, role: 'coach', coach_id: null, deleted_at: null },
    { id: SUB, role: 'coach', coach_id: HEAD, deleted_at: null },
    // Moved from HEAD to NEW_COACH; S's delegation below stays open.
    { id: MOVED, role: 'student', coach_id: NEW_COACH, deleted_at: null },
    { id: CURRENT, role: 'student', coach_id: HEAD, deleted_at: null },
  ];
  const delegations: Row[] = [
    { id: 'd1', head_coach_id: HEAD, sub_coach_id: SUB, client_id: MOVED, unassigned_at: null },
    { id: 'd2', head_coach_id: HEAD, sub_coach_id: SUB, client_id: CURRENT, unassigned_at: null },
  ];
  const find =
    (rows: Row[]) =>
    async ({ where }: { where?: Row }) =>
      rows.find((r) => matches(r, where)) ?? null;
  const findAll =
    (rows: Row[]) =>
    async ({ where }: { where?: Row }) =>
      rows.filter((r) => matches(r, where));
  const message = { id: 'm1', coach_id: HEAD, sender_id: MOVED, body: 'Private health note' };
  const prisma = {
    user: {
      findFirst: jest.fn(find(users)),
      findUnique: jest.fn(find(users)),
      findMany: jest.fn(findAll(users)),
    },
    subCoachAssignment: {
      findFirst: jest.fn(find(delegations)),
      findMany: jest.fn(findAll(delegations)),
    },
    teamSubCoachAssignment: { findFirst: jest.fn().mockResolvedValue(null) },
    coachMessage: {
      findMany: jest.fn(async ({ where }: { where: Row }) => [
        { ...message, client_id: where.client_id },
      ]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(0),
    },
    $transaction: jest.fn(),
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
  };
  const dep = <T extends object>(cls: { prototype: T }, impl: object): T =>
    Object.assign(Object.create(cls.prototype) as T, impl);
  const prismaDep = dep(PrismaService, prisma);
  const messaging = new MessagingService(
    prismaDep,
    dep(SupabaseService, { getClient: jest.fn() }),
    dep(AnalyticsService, { capture: jest.fn() }),
    dep(PtmService, { emit: jest.fn() }),
    dep(MessageReceivedEmitter, { emit: jest.fn() }),
    dep(AuditService, { write: jest.fn() }),
    dep(ClientAIContextService, { invalidateForUser: jest.fn() }),
    dep(MessagesSafetyService, {
      getBlockedIdsFor: jest.fn().mockResolvedValue([]),
      isEitherSideBlocked: jest.fn().mockResolvedValue(false),
    }),
    new SubCoachScopeService(prismaDep),
  );
  return { prisma, messaging };
}

describe('B-DP-4-2: an old team sub-coach loses a moved client thread', () => {
  it.each([OUTSIDER, SUB])(
    '%s gets 404 and no content or write on every thread path',
    async (caller) => {
      const f = fixture();
      await expect(f.messaging.resolveThreadForCoach(caller, MOVED)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(f.messaging.listThreadForCoach(caller, MOVED, {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(
        f.messaging.sendAsCoach(caller, MOVED, { body: 'Still here?' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(f.messaging.markReadByCoach(caller, MOVED)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(f.prisma.coachMessage.findMany).not.toHaveBeenCalled();
      expect(f.prisma.coachMessage.create).not.toHaveBeenCalled();
      expect(f.prisma.coachMessage.updateMany).not.toHaveBeenCalled();
      expect(f.prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('the sub-coach keeps the head coach thread for a current delegated client', async () => {
    const f = fixture();
    await expect(f.messaging.resolveThreadForCoach(SUB, CURRENT)).resolves.toMatchObject({
      coachId: HEAD,
      clientId: CURRENT,
      actorId: SUB,
    });
    const rows = await f.messaging.listThreadForCoach(SUB, CURRENT, {});
    expect(rows).toHaveLength(1);
    expect(f.prisma.coachMessage.findMany.mock.calls[0][0].where).toMatchObject({
      coach_id: HEAD,
      client_id: CURRENT,
    });
  });

  it('the new coach and the old head see the expected result', async () => {
    const f = fixture();
    await expect(f.messaging.resolveThreadForCoach(NEW_COACH, MOVED)).resolves.toMatchObject({
      coachId: NEW_COACH,
    });
    await expect(f.messaging.resolveThreadForCoach(HEAD, MOVED)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
