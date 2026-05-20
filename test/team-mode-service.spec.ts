// test/team-mode-service.spec.ts
//
// ADR-0001 §10 — service-layer coverage of the locked decisions.
//
//   Q1: Pro = paid Stripe seat created on assignment.
//       Enterprise = no Stripe call.
//       Growth = throws structured ForbiddenException at the service
//       defence-in-depth check.
//   Q2: ≥2 head coaches per sub-coach throws ConflictException with
//       a structured envelope.
//   Q3: removeSubCoach reassigns N clients in a single transaction,
//       writes one audit event per client + one sub_coach_removed
//       event + one staff_seat_removed event when a Stripe item id
//       was attached.
//   Q4: listAuditEvents paginates and filters by event_kind.
//   Q5 + Q6: covered in tier-resolver and controller specs.

import 'reflect-metadata';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { TeamModeService } from '../src/team-mode/team-mode.service';

interface MockPrisma {
  teamSubCoachAssignment: {
    count: jest.Mock;
    create: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    findMany: jest.Mock;
  };
  teamAuditEvent: {
    create: jest.Mock;
    createMany: jest.Mock;
    findMany: jest.Mock;
  };
  user: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    updateMany: jest.Mock;
  };
  $transaction: jest.Mock;
}

function buildPrisma(overrides: Partial<MockPrisma> = {}): MockPrisma {
  const txFns = {
    teamSubCoachAssignment: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => ({
        id: 'asn-1',
        ...args.data,
        created_at: new Date(),
        archived_at: null,
      })),
      update: jest.fn(async () => ({ id: 'asn-1' })),
    },
    teamAuditEvent: {
      create: jest.fn(async () => ({ id: 'evt-1' })),
      createMany: jest.fn(async () => ({ count: 0 })),
    },
    user: {
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
  };
  const base: MockPrisma = {
    teamSubCoachAssignment: {
      count: jest.fn(async () => 0),
      create: txFns.teamSubCoachAssignment.create,
      findUnique: jest.fn(async () => null),
      update: txFns.teamSubCoachAssignment.update,
      findMany: jest.fn(async () => []),
    },
    teamAuditEvent: {
      create: txFns.teamAuditEvent.create,
      createMany: txFns.teamAuditEvent.createMany,
      findMany: jest.fn(async () => []),
    },
    user: {
      findUnique: jest.fn(async () => ({ id: 'sub-1', role: 'coach', name: 'Karen' })),
      findMany: jest.fn(async () => []),
      updateMany: txFns.user.updateMany,
    },
    $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb(base as unknown),
    ),
    ...overrides,
  };
  return base;
}

function buildStripe() {
  return {
    isConfigured: jest.fn(() => true),
    createSubscriptionItem: jest.fn(async () => ({ id: 'si_test' })),
    deleteSubscriptionItem: jest.fn(async () => ({ id: 'si_test', deleted: true })),
  };
}

function buildTier(tier: 'growth' | 'pro' | 'enterprise' | 'unknown') {
  return {
    resolveTier: jest.fn(async () => ({
      tier,
      stripe_subscription_id: tier === 'unknown' ? null : 'sub_X',
      stripe_price_id: tier === 'unknown' ? null : `price_${tier}`,
    })),
    priceIdToTier: jest.fn(() => tier),
  };
}

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('TeamModeService.assignSubCoach', () => {
  it('Q1+Q2: Pro tier creates a Stripe staff seat and writes assignment + audit events', async () => {
    process.env.STRIPE_PRICE_STAFF_SEAT = 'price_seat_1';
    const prisma = buildPrisma();
    const stripe = buildStripe();
    const tier = buildTier('pro');
    const svc = new TeamModeService(
      prisma as never,
      stripe as never,
      tier as never,
    );

    const result = await svc.assignSubCoach({
      headCoachId: 'head-1',
      subCoachId: 'sub-1',
    });

    expect(stripe.createSubscriptionItem).toHaveBeenCalledTimes(1);
    expect((stripe.createSubscriptionItem.mock.calls[0] as unknown[])[0]).toMatchObject({
      subscription: 'sub_X',
      priceId: 'price_seat_1',
      quantity: 1,
    });
    expect(result.tier).toBe('pro');
    expect(result.stripeSubscriptionItemId).toBe('si_test');

    // sub_coach_assigned + staff_seat_added events both written.
    const auditCalls = prisma.teamAuditEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { event_kind: string } }).data.event_kind,
    );
    expect(auditCalls).toContain('sub_coach_assigned');
    expect(auditCalls).toContain('staff_seat_added');
  });

  it('Q1: Enterprise tier creates assignment WITHOUT a Stripe call', async () => {
    const prisma = buildPrisma();
    const stripe = buildStripe();
    const tier = buildTier('enterprise');
    const svc = new TeamModeService(
      prisma as never,
      stripe as never,
      tier as never,
    );

    const result = await svc.assignSubCoach({
      headCoachId: 'head-1',
      subCoachId: 'sub-1',
    });

    expect(stripe.createSubscriptionItem).not.toHaveBeenCalled();
    expect(result.stripeSubscriptionItemId).toBeNull();
    expect(result.tier).toBe('enterprise');

    const auditCalls = prisma.teamAuditEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { event_kind: string } }).data.event_kind,
    );
    // staff_seat_added is Pro-only — Enterprise should NOT emit it.
    expect(auditCalls).toContain('sub_coach_assigned');
    expect(auditCalls).not.toContain('staff_seat_added');
  });

  it('Q1+Q6: Growth tier is rejected with the structured upsell envelope', async () => {
    const prisma = buildPrisma();
    const stripe = buildStripe();
    const tier = buildTier('growth');
    const svc = new TeamModeService(
      prisma as never,
      stripe as never,
      tier as never,
    );

    await expect(
      svc.assignSubCoach({ headCoachId: 'head-1', subCoachId: 'sub-1' }),
    ).rejects.toThrow(ForbiddenException);
    expect(stripe.createSubscriptionItem).not.toHaveBeenCalled();
    expect(prisma.teamSubCoachAssignment.create).not.toHaveBeenCalled();
  });

  it('Q2: throws ConflictException with cap envelope when sub-coach already has 2 head coaches', async () => {
    const prisma = buildPrisma({
      teamSubCoachAssignment: {
        count: jest.fn(async () => 2),
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
      },
    });
    const stripe = buildStripe();
    const tier = buildTier('pro');
    const svc = new TeamModeService(
      prisma as never,
      stripe as never,
      tier as never,
    );

    let thrown: unknown = null;
    try {
      await svc.assignSubCoach({ headCoachId: 'head-1', subCoachId: 'sub-1' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConflictException);
    const body = (thrown as ConflictException).getResponse() as { kind: string; cap: number };
    expect(body.kind).toBe('sub_coach_head_cap_exceeded');
    expect(body.cap).toBe(2);
  });

  it('rejects self-assignment', async () => {
    const prisma = buildPrisma();
    const svc = new TeamModeService(
      prisma as never,
      buildStripe() as never,
      buildTier('pro') as never,
    );
    await expect(
      svc.assignSubCoach({ headCoachId: 'a', subCoachId: 'a' }),
    ).rejects.toThrow();
  });

  it('rejects non-coach target user', async () => {
    const prisma = buildPrisma({
      user: {
        findUnique: jest.fn(async () => ({ id: 'sub-1', role: 'student', name: 'Karen' })),
        findMany: jest.fn(),
        updateMany: jest.fn(),
      },
    });
    const svc = new TeamModeService(
      prisma as never,
      buildStripe() as never,
      buildTier('pro') as never,
    );
    await expect(
      svc.assignSubCoach({ headCoachId: 'head-1', subCoachId: 'sub-1' }),
    ).rejects.toThrow();
  });
});

describe('TeamModeService.removeSubCoach', () => {
  function withRemoval(
    options: {
      assignment?: Record<string, unknown> | null;
      clients?: { id: string }[];
      stripeError?: boolean;
    } = {},
  ) {
    const assignment =
      'assignment' in options
        ? options.assignment
        : {
            id: 'asn-1',
            head_coach_id: 'head-1',
            sub_coach_id: 'sub-1',
            stripe_subscription_item_id: 'si_test',
            archived_at: null,
          };
    const clients = options.clients ?? [];
    const prisma = buildPrisma({
      teamSubCoachAssignment: {
        count: jest.fn(async () => 0),
        create: jest.fn(),
        findUnique: jest.fn(async () => assignment),
        update: jest.fn(async () => ({ id: 'asn-1' })),
        findMany: jest.fn(async () => []),
      },
      user: {
        findUnique: jest.fn(async () => ({ id: 'sub-1', name: 'Karen' })),
        findMany: jest.fn(async () => clients),
        updateMany: jest.fn(async () => ({ count: clients.length })),
      },
    });
    const stripe = buildStripe();
    if (options.stripeError) {
      stripe.deleteSubscriptionItem = jest.fn(async () => {
        throw new Error('stripe_unavailable');
      });
    }
    const svc = new TeamModeService(
      prisma as never,
      stripe as never,
      buildTier('pro') as never,
    );
    return { svc, prisma, stripe };
  }

  it('Q3: 0-client removal still archives + writes sub_coach_removed event', async () => {
    const { svc, prisma } = withRemoval({ clients: [] });
    const result = await svc.removeSubCoach({
      headCoachId: 'head-1',
      subCoachId: 'sub-1',
    });
    expect(result.reassignedClientCount).toBe(0);
    expect(result.removed).toBe(true);
    const kinds = prisma.teamAuditEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { event_kind: string } }).data.event_kind,
    );
    expect(kinds).toContain('sub_coach_removed');
    // 0 clients → no client_reassigned events.
    expect(kinds.filter((k) => k === 'client_reassigned')).toHaveLength(0);
  });

  it('Q3: 1-client removal reassigns + writes one client_reassigned event', async () => {
    const { svc, prisma } = withRemoval({ clients: [{ id: 'c-1' }] });
    const result = await svc.removeSubCoach({
      headCoachId: 'head-1',
      subCoachId: 'sub-1',
    });
    expect(result.reassignedClientCount).toBe(1);
    expect(prisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['c-1'] } },
        data: { coach_id: 'head-1' },
      }),
    );
    // client_reassigned events are written via createMany (bulk).
    expect(prisma.teamAuditEvent.createMany).toHaveBeenCalledTimes(1);
    const createManyCall = prisma.teamAuditEvent.createMany.mock.calls[0][0] as {
      data: Array<{ event_kind: string }>;
    };
    expect(createManyCall.data.filter((d) => d.event_kind === 'client_reassigned')).toHaveLength(1);
  });

  it('Q3: N-client removal reassigns all + writes N client_reassigned events', async () => {
    const clients = [{ id: 'c-1' }, { id: 'c-2' }, { id: 'c-3' }];
    const { svc, prisma } = withRemoval({ clients });
    const result = await svc.removeSubCoach({
      headCoachId: 'head-1',
      subCoachId: 'sub-1',
    });
    expect(result.reassignedClientCount).toBe(3);
    // client_reassigned events are written via createMany (bulk).
    expect(prisma.teamAuditEvent.createMany).toHaveBeenCalledTimes(1);
    const createManyCall = prisma.teamAuditEvent.createMany.mock.calls[0][0] as {
      data: Array<{ event_kind: string }>;
    };
    expect(createManyCall.data.filter((d) => d.event_kind === 'client_reassigned')).toHaveLength(3);
    // sub_coach_removed and staff_seat_removed written via individual create calls.
    const createKinds = prisma.teamAuditEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { event_kind: string } }).data.event_kind,
    );
    expect(createKinds).toContain('sub_coach_removed');
    expect(createKinds).toContain('staff_seat_removed');
  });

  it('Q3: Stripe failure does not block reassignment — error stored in audit metadata', async () => {
    const clients = [{ id: 'c-1' }];
    const { svc, prisma } = withRemoval({ clients, stripeError: true });
    const result = await svc.removeSubCoach({
      headCoachId: 'head-1',
      subCoachId: 'sub-1',
    });
    expect(result.removed).toBe(true);
    expect(result.reassignedClientCount).toBe(1);
    const removedEvent = prisma.teamAuditEvent.create.mock.calls
      .map((c) => c[0] as { data: { event_kind: string; metadata?: { stripe_error?: string } } })
      .find((c) => c.data.event_kind === 'sub_coach_removed');
    expect(removedEvent?.data.metadata?.stripe_error).toBe('stripe_unavailable');
  });

  it('throws NotFoundException for an unknown assignment', async () => {
    const { svc } = withRemoval({ assignment: null });
    await expect(
      svc.removeSubCoach({ headCoachId: 'head-1', subCoachId: 'sub-1' }),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('TeamModeService.listAuditEvents', () => {
  it('Q4: paginates with cursor + applies event_kind filter', async () => {
    const rows = [
      { id: 'e3', event_kind: 'session_held', occurred_at: new Date('2026-05-10T03:00:00Z') },
      { id: 'e2', event_kind: 'session_held', occurred_at: new Date('2026-05-10T02:00:00Z') },
      { id: 'e1', event_kind: 'session_held', occurred_at: new Date('2026-05-10T01:00:00Z') },
    ];
    const prisma = buildPrisma({
      teamAuditEvent: {
        create: jest.fn(),
        createMany: jest.fn(async () => ({ count: 0 })),
        findMany: jest.fn(async () => rows),
      },
    });
    const svc = new TeamModeService(
      prisma as never,
      buildStripe() as never,
      buildTier('pro') as never,
    );
    const out = await svc.listAuditEvents({
      headCoachId: 'head-1',
      eventKind: 'session_held',
      limit: 50,
    });
    expect(out.data).toHaveLength(3);
    expect(out.next_cursor).toBeNull();
    const findArgs = prisma.teamAuditEvent.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(findArgs.where.event_kind).toBe('session_held');
    expect(findArgs.where.head_coach_id).toBe('head-1');
  });

  it('Q4: returns next_cursor when more rows exist than the page limit', async () => {
    const make = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `e${n - i}`,
        event_kind: 'message_sent',
        occurred_at: new Date(),
      }));
    const prisma = buildPrisma({
      teamAuditEvent: {
        create: jest.fn(),
        createMany: jest.fn(async () => ({ count: 0 })),
        findMany: jest.fn(async () => make(11)),
      },
    });
    const svc = new TeamModeService(
      prisma as never,
      buildStripe() as never,
      buildTier('pro') as never,
    );
    const out = await svc.listAuditEvents({
      headCoachId: 'head-1',
      limit: 10,
    });
    expect(out.data).toHaveLength(10);
    expect(out.next_cursor).not.toBeNull();
  });

  it('Q4: from/to date range translates into a where.occurred_at filter', async () => {
    const prisma = buildPrisma({
      teamAuditEvent: {
        create: jest.fn(),
        createMany: jest.fn(async () => ({ count: 0 })),
        findMany: jest.fn(async () => []),
      },
    });
    const svc = new TeamModeService(
      prisma as never,
      buildStripe() as never,
      buildTier('pro') as never,
    );
    await svc.listAuditEvents({
      headCoachId: 'head-1',
      fromDate: new Date('2026-05-01T00:00:00Z'),
      toDate: new Date('2026-05-10T00:00:00Z'),
    });
    const findArgs = prisma.teamAuditEvent.findMany.mock.calls[0][0] as {
      where: { occurred_at: { gte?: Date; lte?: Date } };
    };
    expect(findArgs.where.occurred_at.gte).toBeInstanceOf(Date);
    expect(findArgs.where.occurred_at.lte).toBeInstanceOf(Date);
  });
});
