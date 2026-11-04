import { Prisma } from '@prisma/client';
import { BroadcastsService } from '../../src/broadcasts/broadcasts.service';
import type { PrismaService } from '../../src/prisma.service';
import type { AuditService } from '../../src/audit/audit.service';
import type { BroadcastScopeService } from '../../src/broadcasts/broadcast-scope.service';
import type { SegmentResolverService } from '../../src/broadcasts/segment-resolver.service';
import type { CardsService } from '../../src/broadcasts/cards.service';
import { stub } from './_stub';

// FR-1217R1 (LS-1217 B1, class-first): every path that answers with one or
// more stored broadcasts leaves out an excluded client who has moved away.
const OLD = '00000001-0000-4000-8000-000000000001';
const NEW = '00000002-0000-4000-8000-000000000002';
const MOVED = '00000003-0000-4000-8000-000000000003';
const NOW = new Date('2026-11-03T12:00:00.000Z');
const INPUT = {
  body: 'Hello', segment: { match: 'all', rules: [], exclude_client_ids: [MOVED] },
  timezone: 'UTC', status: 'draft',
};

type Path = 'fresh create' | 'early replay' | 'P2002 replay' | 'get' | 'list';

function harness(path: Path, moved: boolean) {
  const row = {
    id: '00000006-0000-4000-8000-000000000006', coach_id: OLD, author_user_id: OLD,
    idempotency_key: 'draft-key', status: 'draft', body: 'Hello', card: null,
    segment: { match: 'all', rules: [], exclude_client_ids: [MOVED] }, timezone: 'UTC',
    recurrence: null, send_at: null, next_run_at: null, urgent: false, occurrences_sent: 0,
    last_run_at: null, failure_code: null, canceled_at: null, created_at: NOW, updated_at: NOW,
  };
  let lookups = 0;
  const findFirst = jest.fn(async () => {
    lookups += 1;
    if (path === 'fresh create') return null;
    if (path === 'P2002 replay') return lookups === 1 ? null : row;
    return row;
  });
  const create = jest.fn(async () => {
    if (path === 'P2002 replay') {
      throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
    }
    return row;
  });
  const prisma = {
    coachBroadcast: { findFirst, findMany: jest.fn(async () => [row]), create },
    user: { findMany: jest.fn(async () => (moved ? [{ id: MOVED, coach_id: NEW }] : [])) },
    subCoachAssignment: { findMany: jest.fn(async () => []) },
    coachBroadcastDelivery: { groupBy: jest.fn(async () => []) },
    coachBroadcastRun: { findMany: jest.fn(async () => []) },
  };
  const service = new BroadcastsService(
    stub<PrismaService>(prisma),
    stub<BroadcastScopeService>({
      resolve: async () => ({ actorId: OLD, tenantId: OLD, clientIds: moved ? [] : [MOVED] }),
    }),
    stub<SegmentResolverService>({}),
    stub<CardsService>({}),
    stub<AuditService>({ write: async () => undefined }),
  );
  const read = (): Promise<unknown> => {
    switch (path) {
      case 'get': return service.get(OLD, row.id);
      case 'list': return service.list(OLD, {});
      default: return service.create(OLD, INPUT, 'draft-key', NOW);
    }
  };
  return { read, create };
}

const PATHS: Path[] = ['fresh create', 'early replay', 'P2002 replay', 'get', 'list'];

describe('FR-1217R1: every broadcast answer path hides moved-away exclusions', () => {
  it.each(PATHS)('control: %s keeps an exclusion still on the roster', async (path) => {
    const h = harness(path, false);
    expect(JSON.stringify(await h.read())).toContain(MOVED);
  });

  it.each(PATHS)('%s leaves out an exclusion who has moved away', async (path) => {
    const h = harness(path, true);
    const answer = JSON.stringify(await h.read());
    expect(answer).toContain('00000006-0000-4000-8000-000000000006');
    expect(answer).not.toContain(MOVED);
    if (path === 'early replay') expect(h.create).not.toHaveBeenCalled();
    if (path === 'P2002 replay') expect(h.create).toHaveBeenCalledTimes(1);
  });
});
