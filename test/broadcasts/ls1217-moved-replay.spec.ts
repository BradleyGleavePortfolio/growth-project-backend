import { BroadcastsService } from '../../src/broadcasts/broadcasts.service';
import type { PrismaService } from '../../src/prisma.service';
import type { AuditService } from '../../src/audit/audit.service';
import type { BroadcastScopeService } from '../../src/broadcasts/broadcast-scope.service';
import type { SegmentResolverService } from '../../src/broadcasts/segment-resolver.service';
import type { CardsService } from '../../src/broadcasts/cards.service';
import { stub } from './_stub';

const OLD = '00000001-0000-4000-8000-000000000001';
const NEW = '00000002-0000-4000-8000-000000000002';
const MOVED = '00000003-0000-4000-8000-000000000003';
const NOW = new Date('2026-11-03T12:00:00.000Z');

function harness() {
  let coachId = OLD;
  const row = {
    id: '00000006-0000-4000-8000-000000000006',
    coach_id: OLD,
    author_user_id: OLD,
    idempotency_key: 'draft-key',
    status: 'draft',
    body: 'Hello',
    card: null,
    segment: { match: 'all', rules: [], exclude_client_ids: [MOVED] },
    timezone: 'UTC',
    recurrence: null,
    send_at: null,
    next_run_at: null,
    urgent: false,
    occurrences_sent: 0,
    last_run_at: null,
    failure_code: null,
    canceled_at: null,
    created_at: NOW,
    updated_at: NOW,
  };
  const prisma = {
    coachBroadcast: {
      findFirst: jest.fn(async () => row),
      findMany: jest.fn(async () => [row]),
      create: jest.fn(async () => row),
    },
    user: {
      findMany: jest.fn(async () => (coachId === OLD ? [] : [{ id: MOVED }])),
    },
    subCoachAssignment: { findMany: jest.fn(async () => []) },
    coachBroadcastDelivery: { groupBy: jest.fn(async () => []) },
    coachBroadcastRun: { findMany: jest.fn(async () => []) },
  };
  const service = new BroadcastsService(
    stub<PrismaService>(prisma),
    stub<BroadcastScopeService>({
      resolve: async () => ({
        actorId: OLD,
        tenantId: OLD,
        clientIds: coachId === OLD ? [MOVED] : [],
      }),
    }),
    stub<SegmentResolverService>({}),
    stub<CardsService>({}),
    stub<AuditService>({ write: async () => undefined }),
  );
  return { service, row, prisma, move: () => { coachId = NEW; } };
}

describe('LS-1217: moved identifiers are hidden on broadcast retry reads', () => {
  it('control: detail is readable before the move and scrubbed after it', async () => {
    const h = harness();
    expect(JSON.stringify(await h.service.get(OLD, h.row.id))).toContain(MOVED);
    h.move();
    expect(JSON.stringify(await h.service.get(OLD, h.row.id))).not.toContain(MOVED);
  });

  it('B1: retrying the same draft after the move must scrub the stored exclusion', async () => {
    const h = harness();
    h.move();
    expect(JSON.stringify(await h.service.get(OLD, h.row.id))).not.toContain(MOVED);
    const response = await h.service.create(
      OLD,
      { body: 'Hello', segment: {}, timezone: 'UTC', status: 'draft' },
      'draft-key',
      NOW,
    );
    expect(response.id).toBe(h.row.id);
    expect(h.prisma.coachBroadcast.create).not.toHaveBeenCalled();
    // The request contains no moved identifier. This is a server read of
    // persisted data, not an echo of a client-supplied exclusion.
    expect(JSON.stringify(response)).not.toContain(MOVED);
  });
});
