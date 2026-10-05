import { BroadcastsService } from '../../src/broadcasts/broadcasts.service';
import { Prisma } from '@prisma/client';
import { BroadcastHttpError } from '../../src/broadcasts/broadcast-errors';
import type { PrismaService } from '../../src/prisma.service';
import type { AuditService } from '../../src/audit/audit.service';
import type {
  BroadcastScopeService,
  CoachScope,
} from '../../src/broadcasts/broadcast-scope.service';
import type { SegmentResolverService } from '../../src/broadcasts/segment-resolver.service';
import type { CardsService } from '../../src/broadcasts/cards.service';
import { stub } from './_stub';

const NOW = new Date('2027-02-01T15:00:00Z');

function harness(
  scope: CoachScope,
  opts: { recipients?: string[]; row?: Record<string, unknown> | null } = {},
) {
  const findFirst = jest.fn(async () => opts.row ?? null);
  const findMany = jest.fn(async () => []);
  const create = jest.fn(async (a: { data: Record<string, unknown> }) => ({
    id: 'b-new',
    created_at: NOW,
    updated_at: NOW,
    occurrences_sent: 0,
    ...a.data,
  }));
  const prisma = {
    coachBroadcast: {
      findUnique: jest.fn(async () => null),
      findFirst,
      findMany,
      create,
      count: jest.fn(async () => 0),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    coachBroadcastDelivery: { groupBy: jest.fn(async () => []) },
    coachBroadcastRun: { findMany: jest.fn(async () => []), count: jest.fn(async () => 0) },
  };
  const svc = new BroadcastsService(
    stub<PrismaService>(prisma),
    stub<BroadcastScopeService>({ resolve: async () => scope }),
    stub<SegmentResolverService>({
      resolve: async () => ({
        recipientIds: opts.recipients ?? ['c1'],
        blockedIds: [],
        rosterSize: 3,
      }),
    }),
    stub<CardsService>({}),
    stub<AuditService>({ write: async () => undefined }),
  );
  return { svc, prisma, create, findFirst, findMany };
}

const head: CoachScope = { actorId: 'coach-a', tenantId: 'coach-a', clientIds: ['c1', 'c2'] };
const sub: CoachScope = { actorId: 'sub-1', tenantId: 'coach-a', clientIds: ['c1'] };
const input = { body: 'Hello', segment: {}, timezone: 'America/Chicago' };

async function code(p: Promise<unknown>) {
  return p.then(
    () => 'resolved',
    (e: unknown) => (e instanceof BroadcastHttpError ? e.code : String(e)),
  );
}

describe('BroadcastsService', () => {
  it('refuses to schedule a broadcast nobody would receive', async () => {
    const h = harness(head, { recipients: [] });
    expect(await code(h.svc.create('coach-a', input, undefined, NOW))).toBe(
      'broadcast.no_recipients',
    );
    expect(h.create).not.toHaveBeenCalled();
  });

  it('writes under the head coach tenant with the sub-coach as author, and arms next_run_at', async () => {
    const h = harness(sub);
    await h.svc.create('sub-1', input, 'key-1', NOW);
    expect(h.create.mock.calls[0][0].data).toMatchObject({
      coach_id: 'coach-a',
      author_user_id: 'sub-1',
      status: 'scheduled',
      next_run_at: NOW,
      idempotency_key: 'key-1',
    });
  });

  it('a recurring series pins its anchor and first occurrence in the broadcast time zone', async () => {
    const h = harness(head);
    await h.svc.create(
      'coach-a',
      { ...input, recurrence: { freq: 'weekly', local_time: '07:00', by_weekday: [1] } },
      undefined,
      NOW,
    );
    const data = h.create.mock.calls[0][0].data;
    // 2027-02-01 is a Monday; 07:00 Chicago (CST) already passed at 15:00Z, so next Monday.
    expect(data.next_run_at).toEqual(new Date('2027-02-08T13:00:00Z'));
    expect(data.recurrence).toMatchObject({ anchor_date: '2027-02-01', by_weekday: [1] });
  });

  it('rejects a send time in the past and an invalid time zone with specific codes', async () => {
    const h = harness(head);
    expect(
      await code(
        h.svc.create('coach-a', { ...input, send_at: '2027-01-01T00:00:00Z' }, undefined, NOW),
      ),
    ).toBe('broadcast.send_at_invalid');
    expect(
      await code(h.svc.create('coach-a', { ...input, timezone: 'Mars/Olympus' }, undefined, NOW)),
    ).toBe('broadcast.timezone_invalid');
  });

  it('a sub-coach only ever loads broadcasts they wrote', async () => {
    const h = harness(sub);
    expect(await code(h.svc.get('sub-1', 'b1'))).toBe('broadcast.not_found');
    expect(h.findFirst.mock.calls[0]).toEqual([
      { where: { id: 'b1', coach_id: 'coach-a', author_user_id: 'sub-1' } },
    ]);
  });

  it('a sent broadcast cannot be edited or canceled', async () => {
    const row = {
      id: 'b1',
      coach_id: 'coach-a',
      status: 'sent',
      updated_at: NOW,
      body: 'x',
      segment: {},
      timezone: 'UTC',
      card: null,
      recurrence: null,
    };
    const h = harness(head, { row });
    expect(await code(h.svc.update('coach-a', 'b1', input, NOW))).toBe('broadcast.not_editable');
    expect(await code(h.svc.transition('coach-a', 'b1', 'cancel', NOW))).toBe(
      'broadcast.invalid_transition',
    );
  });
});

// ---- A-659-6: Idempotency-Key replay is bound to the author ------------------

describe('BroadcastsService idempotency (A-659-6)', () => {
  type Row = Record<string, unknown> & { id: string };
  function store(rows: Row[], opts: { p2002Once?: Row } = {}) {
    const matches = (r: Row, where: Record<string, unknown>) =>
      Object.entries(where).every(([k, v]) => r[k] === v);
    let raced = false;
    const prisma = {
      coachBroadcast: {
        // The pre-fix namespace: (tenant, key) only.
        findUnique: jest.fn(
          async (a: {
            where: { coach_id_idempotency_key: { coach_id: string; idempotency_key: string } };
          }) =>
            rows.find(
              (r) =>
                r.coach_id === a.where.coach_id_idempotency_key.coach_id &&
                r.idempotency_key === a.where.coach_id_idempotency_key.idempotency_key,
            ) ?? null,
        ),
        findFirst: jest.fn(
          async (a: { where: Record<string, unknown> }) =>
            rows.find((r) => matches(r, a.where)) ?? null,
        ),
        create: jest.fn(async (a: { data: Record<string, unknown> }) => {
          if (opts.p2002Once && !raced) {
            raced = true;
            rows.push(opts.p2002Once);
            throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
              code: 'P2002',
              clientVersion: 'test',
            });
          }
          const row = {
            id: `b-${rows.length + 1}`,
            created_at: NOW,
            updated_at: NOW,
            occurrences_sent: 0,
            ...a.data,
          };
          rows.push(row);
          return row;
        }),
        count: jest.fn(async () => 0),
      },
    };
    return prisma;
  }
  function svcFor(prisma: unknown, scope: CoachScope) {
    return new BroadcastsService(
      stub<PrismaService>(prisma),
      stub<BroadcastScopeService>({ resolve: async () => scope }),
      stub<SegmentResolverService>({
        resolve: async () => ({ recipientIds: ['c9'], blockedIds: [], rosterSize: 1 }),
      }),
      stub<CardsService>({}),
      stub<AuditService>({ write: async () => undefined }),
    );
  }
  const subA: CoachScope = { actorId: 'sub-a', tenantId: 'coach-a', clientIds: ['c1'] };
  const subB: CoachScope = { actorId: 'sub-b', tenantId: 'coach-a', clientIds: ['c9'] };
  const rowA: Row = {
    id: 'b-a',
    coach_id: 'coach-a',
    author_user_id: 'sub-a',
    idempotency_key: 'k1',
    status: 'scheduled',
    body: 'Hello',
    card: null,
    segment: { match: 'all', rules: [], exclude_client_ids: ['private-client'] },
    timezone: 'UTC',
    created_at: NOW,
    updated_at: NOW,
  };

  it('a sibling sub-coach with the same key and text gets a broadcast of their own and learns nothing about the other', async () => {
    const rows: Row[] = [{ ...rowA }];
    const prisma = store(rows);
    const out = await svcFor(prisma, subB).create('sub-b', input, 'k1', NOW);
    expect(out.id).not.toBe('b-a');
    expect(out.author_user_id).toBe('sub-b');
    expect(JSON.stringify(out)).not.toContain('private-client');
    expect(JSON.stringify(out)).not.toContain('sub-a');
    expect(prisma.coachBroadcast.create).toHaveBeenCalledTimes(1);
  });

  it('the head coach colliding with a sub-coach key is independent too', async () => {
    const rows: Row[] = [{ ...rowA }];
    const out = await svcFor(store(rows), head).create('coach-a', input, 'k1', NOW);
    expect(out.id).not.toBe('b-a');
    expect(out.author_user_id).toBe('coach-a');
  });

  it('the same author replays the same broadcast (and a different text is a conflict)', async () => {
    const rows: Row[] = [{ ...rowA }];
    const prisma = store(rows);
    const again = await svcFor(prisma, subA).create('sub-a', input, 'k1', NOW);
    expect(again.id).toBe('b-a');
    expect(prisma.coachBroadcast.create).not.toHaveBeenCalled();
    expect(
      await code(svcFor(prisma, subA).create('sub-a', { ...input, body: 'Other' }, 'k1', NOW)),
    ).toBe('broadcast.idempotency_conflict');
  });

  it('a concurrent loser (P2002) of the same author replays the winner', async () => {
    const rows: Row[] = [];
    const prisma = store(rows, { p2002Once: { ...rowA } });
    const out = await svcFor(prisma, subA).create('sub-a', input, 'k1', NOW);
    expect(out.id).toBe('b-a');
  });
});

// ---- B-659-1: a claimed occurrence is never sent twice -----------------------

describe('BroadcastsService edit / resume after a claim (B-659-1)', () => {
  function withRun(row: Record<string, unknown>, lastRun: Date | null) {
    const h = harness(head, { row });
    h.prisma.coachBroadcastRun = {
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => (lastRun ? 1 : 0)),
      findFirst: jest.fn(async () => (lastRun ? { scheduled_for: lastRun } : null)),
    } as unknown as typeof h.prisma.coachBroadcastRun;
    return h;
  }
  const base = {
    id: 'b1',
    coach_id: 'coach-a',
    author_user_id: 'coach-a',
    updated_at: NOW,
    body: 'Old text',
    segment: {},
    timezone: 'America/Chicago',
    card: null,
  };
  // 2027-02-01T13:00Z = 07:00 Chicago (CST); NOW = 09:00 Chicago.
  const today0700 = new Date('2027-02-01T13:00:00Z');

  it('pause mid-run, edit, resume: the edit of a started one-off is refused and nothing is re-armed', async () => {
    const h = withRun(
      { ...base, status: 'paused', recurrence: null, next_run_at: null },
      today0700,
    );
    expect(await code(h.svc.update('coach-a', 'b1', { ...input, body: 'Fixed typo' }, NOW))).toBe(
      'broadcast.already_sending',
    );
    expect(h.prisma.coachBroadcast.updateMany).not.toHaveBeenCalled();
  });

  it('a series with a claimed occurrence cannot become a one-off (that would resend now)', async () => {
    const rule = { freq: 'daily', interval: 1, local_time: '07:00', anchor_date: '2027-01-30' };
    const h = withRun(
      { ...base, status: 'scheduled', recurrence: rule, next_run_at: null },
      today0700,
    );
    expect(await code(h.svc.update('coach-a', 'b1', input, NOW))).toBe('broadcast.series_started');
    expect(h.prisma.coachBroadcast.updateMany).not.toHaveBeenCalled();
  });

  it('a series edit applies from the next occurrence and never adds a second copy on a day already sent', async () => {
    const rule = { freq: 'daily', interval: 1, local_time: '07:00', anchor_date: '2027-01-30' };
    const h = withRun(
      { ...base, status: 'scheduled', recurrence: rule, next_run_at: null },
      today0700,
    );
    // Moving the time to 10:00 at 09:00 would otherwise send again today at 10:00.
    await h.svc.update(
      'coach-a',
      'b1',
      { ...input, recurrence: { freq: 'daily', local_time: '10:00' } },
      NOW,
    );
    const data = (
      h.prisma.coachBroadcast.updateMany.mock.calls[0] as unknown as [
        { data: { next_run_at: Date } },
      ]
    )[0].data;
    expect(data.next_run_at).toEqual(new Date('2027-02-02T16:00:00Z'));
  });

  it('a one-off that never started is still editable', async () => {
    const h = withRun({ ...base, status: 'paused', recurrence: null, next_run_at: NOW }, null);
    expect(await code(h.svc.update('coach-a', 'b1', input, NOW))).toBe('resolved');
  });

  it('resume never re-arms a one-off that already has a run', async () => {
    const h = withRun({ ...base, status: 'paused', recurrence: null, next_run_at: NOW }, today0700);
    await h.svc.transition('coach-a', 'b1', 'resume', NOW);
    const data = (
      h.prisma.coachBroadcast.updateMany.mock.calls[0] as unknown as [
        { data: Record<string, unknown> },
      ]
    )[0].data;
    expect(data.next_run_at).toBeNull();
    expect(data.status).toBe('sending');
  });

  it('resume of a series skips to a day that has not had a copy yet', async () => {
    const rule = { freq: 'daily', interval: 1, local_time: '10:00', anchor_date: '2027-01-30' };
    const h = withRun(
      { ...base, status: 'paused', recurrence: rule, next_run_at: null },
      today0700,
    );
    await h.svc.transition('coach-a', 'b1', 'resume', NOW);
    const data = (
      h.prisma.coachBroadcast.updateMany.mock.calls[0] as unknown as [
        { data: Record<string, unknown> },
      ]
    )[0].data;
    expect(data.next_run_at).toEqual(new Date('2027-02-02T16:00:00Z'));
    expect(data.status).toBe('scheduled');
  });
});
