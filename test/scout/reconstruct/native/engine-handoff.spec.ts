import { Prisma } from '@prisma/client';
import { AnalyticsService } from '../../../../src/analytics/analytics.service';
import { PrismaService } from '../../../../src/prisma.service';
import type {
  FamilyReconstructor,
  PersistResult,
} from '../../../../src/scout/reconstruct/families';
import { ScoutReconstructService } from '../../../../src/scout/scout-reconstruct.service';

/**
 * S8-C typed persist handoff in the engine (grant amendment 2026-09-25): a
 * family's typed outcome lands its target kind/id (or unresolved reason) in the
 * SAME transaction and SAME precedence update as the ledger status, legacy
 * `string | null` results write NO kind, and success precedence is unchanged.
 * Families are stubbed so only the engine seam is under test.
 */
interface LedgerRow {
  coach_id: string;
  intent_id: string;
  entity_type: string;
  source_platform: string;
  source_id: string;
  status: string;
  target_id: string | null;
  target_kind?: string;
  reason: string | null;
}

class FakePrisma {
  staged: { source_id: string; source_platform: string; payload: Prisma.JsonValue }[] = [];
  readonly ledger = new Map<string, LedgerRow>();
  /** Ordered log of (model.method) calls seen INSIDE $transaction callbacks. */
  txLog: string[][] = [];
  private current: string[] | null = null;
  private note(name: string) {
    if (this.current) this.current.push(name);
  }
  private ledgerKey(r: Omit<LedgerRow, 'status' | 'target_id' | 'reason' | 'target_kind'>) {
    return `${r.coach_id}|${r.intent_id}|${r.entity_type}|${r.source_platform}|${r.source_id}`;
  }
  scoutImport = { findUnique: async () => ({ terminal_status: 'success' }) };
  scoutIngestEntity = {
    count: async () => this.staged.length,
    findMany: async (args: { take?: number; skip?: number }) => {
      const skip = args.skip ?? 0;
      return [...this.staged]
        .sort((a, b) => a.source_id.localeCompare(b.source_id))
        .slice(skip, skip + (args.take ?? this.staged.length));
    },
  };
  scoutReconstructionLedger = {
    upsert: async (args: {
      where: { coach_id_intent_id_entity_type_source_platform_source_id: LedgerRow };
      create: LedgerRow;
      update: Partial<LedgerRow>;
    }) => {
      this.note('ledger.upsert');
      const key = this.ledgerKey(
        args.where.coach_id_intent_id_entity_type_source_platform_source_id,
      );
      const existing = this.ledger.get(key);
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }
      const row = { ...args.create };
      this.ledger.set(key, row);
      return row;
    },
    updateMany: async (args: {
      where: Omit<LedgerRow, 'status' | 'target_id' | 'reason'> & { status?: { not: string } };
      data: Partial<LedgerRow>;
    }) => {
      this.note('ledger.updateMany');
      const row = this.ledger.get(this.ledgerKey(args.where));
      if (!row || (args.where.status && row.status === args.where.status.not)) return { count: 0 };
      Object.assign(row, args.data);
      return { count: 1 };
    },
    groupBy: async (args: { where: { entity_type: string } }) => {
      const counts = new Map<string, number>();
      for (const row of this.ledger.values()) {
        if (row.entity_type !== args.where.entity_type) continue;
        counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
      }
      return [...counts.entries()].map(([status, n]) => ({ status, _count: { _all: n } }));
    },
  };
  $transaction = async <T>(cb: (tx: FakePrisma) => Promise<T>): Promise<T> => {
    const log: string[] = [];
    this.txLog.push(log);
    this.current = log;
    try {
      return await cb(this);
    } finally {
      this.current = null;
    }
  };
}

const COACH = 'coach-a';
const INTENT = 'intent-1';
const FAMILY = 'workouts';

function build(persist: (tx: FakePrisma, sourceId: string) => Promise<PersistResult>) {
  const prisma = new FakePrisma();
  const service = new ScoutReconstructService(
    Object.assign(Object.create(PrismaService.prototype) as PrismaService, prisma),
    Object.assign(Object.create(AnalyticsService.prototype) as AnalyticsService, {
      capture: jest.fn(),
    }),
  );
  const family: FamilyReconstructor<string> = {
    entityType: FAMILY,
    map: (row) => ({ ok: true, mapped: row.source_id }),
    persist: (tx, _coach, sourceId) => {
      prisma['note']('family.persist');
      return persist(tx as Prisma.TransactionClient & FakePrisma, sourceId);
    },
  };
  Object.assign(service, {
    families: new Map<string, FamilyReconstructor>([[FAMILY, family]]),
  });
  return { service, prisma };
}

const staged = (sourceId: string) => ({
  source_id: sourceId,
  source_platform: 's8c-proof',
  payload: {},
});
const rowOf = (prisma: FakePrisma, sourceId: string) =>
  [...prisma.ledger.values()].find((r) => r.source_id === sourceId)!;

describe('ScoutReconstructService typed persist handoff (S8-C)', () => {
  it('writes target_kind with the target id in the same transaction and precedence update', async () => {
    const { service, prisma } = build(async () => ({
      ok: true,
      targetId: 'plan-1',
      targetKind: 'workout_plan',
      unresolvedChildren: 0,
    }));
    prisma.staged = [staged('w-1')];
    const result = await service.reconstruct(COACH, INTENT, FAMILY);
    expect(result).toMatchObject({ staged: 1, reconstructed: 1, skipped: 0, failed: 0 });
    expect(rowOf(prisma, 'w-1')).toEqual({
      coach_id: COACH,
      intent_id: INTENT,
      entity_type: FAMILY,
      source_platform: 's8c-proof',
      source_id: 'w-1',
      status: 'reconstructed',
      target_id: 'plan-1',
      target_kind: 'workout_plan',
      reason: null,
    });
    // One transaction: persist → ledger upsert → precedence update. No second write for the kind.
    expect(prisma.txLog).toEqual([['family.persist', 'ledger.upsert', 'ledger.updateMany']]);
  });

  it('records a typed unresolved outcome as skipped with the exact reason, in the same transaction', async () => {
    const { service, prisma } = build(async () => ({
      ok: false,
      reason: 'unresolved:relationship_pending:programs',
    }));
    prisma.staged = [staged('w-1')];
    const result = await service.reconstruct(COACH, INTENT, FAMILY);
    expect(result).toMatchObject({ reconstructed: 0, skipped: 1, failed: 0 });
    expect(rowOf(prisma, 'w-1')).toMatchObject({
      status: 'skipped',
      target_id: null,
      reason: 'unresolved:relationship_pending:programs',
    });
    expect(rowOf(prisma, 'w-1')).not.toHaveProperty('target_kind');
    expect(prisma.txLog).toEqual([['family.persist', 'ledger.upsert', 'ledger.updateMany']]);
  });

  it('leaves the ledger kind untouched for legacy string results (historical NULL kinds are not reinterpreted)', async () => {
    const { service, prisma } = build(async () => 'person-1');
    prisma.staged = [staged('c-1')];
    await service.reconstruct(COACH, INTENT, FAMILY);
    const row = rowOf(prisma, 'c-1');
    expect(row).toMatchObject({ status: 'reconstructed', target_id: 'person-1', reason: null });
    expect(row).not.toHaveProperty('target_kind');
  });

  it('keeps success precedence: a later unresolved replay cannot overwrite a committed native target', async () => {
    let calls = 0;
    const { service, prisma } = build(async () => {
      calls += 1;
      return calls === 1
        ? { ok: true, targetId: 'plan-1', targetKind: 'workout_plan', unresolvedChildren: 0 }
        : { ok: false, reason: 'unresolved:native_target_removed' };
    });
    prisma.staged = [staged('w-1')];
    await service.reconstruct(COACH, INTENT, FAMILY);
    const second = await service.reconstruct(COACH, INTENT, FAMILY);
    expect(second).toMatchObject({ reconstructed: 1, skipped: 0 });
    expect(rowOf(prisma, 'w-1')).toMatchObject({
      status: 'reconstructed',
      target_id: 'plan-1',
      target_kind: 'workout_plan',
      reason: null,
    });
  });

  it('a typed success replaces an earlier skipped attempt (kind and id arrive together)', async () => {
    let calls = 0;
    const { service, prisma } = build(async () => {
      calls += 1;
      return calls === 1
        ? { ok: false, reason: 'unresolved:relationship_pending:programs' }
        : { ok: true, targetId: 'plan-1', targetKind: 'workout_plan', unresolvedChildren: 2 };
    });
    prisma.staged = [staged('w-1')];
    await service.reconstruct(COACH, INTENT, FAMILY);
    expect(rowOf(prisma, 'w-1').status).toBe('skipped');
    const second = await service.reconstruct(COACH, INTENT, FAMILY);
    expect(second).toMatchObject({ reconstructed: 1, skipped: 0 });
    expect(rowOf(prisma, 'w-1')).toMatchObject({
      status: 'reconstructed',
      target_id: 'plan-1',
      target_kind: 'workout_plan',
    });
  });

  it('propagates a persist failure as failed (no fabricated kind) and still retries P2002 once', async () => {
    let calls = 0;
    const { service, prisma } = build(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Prisma.PrismaClientKnownRequestError('unique violation', {
          code: 'P2002',
          clientVersion: 'test',
        });
      }
      return { ok: true, targetId: 'plan-1', targetKind: 'workout_plan', unresolvedChildren: 0 };
    });
    prisma.staged = [staged('w-1'), staged('w-2')];
    const failing = build(async () => {
      throw new Error('catalog offline');
    });
    failing.prisma.staged = [staged('w-9')];
    await service.reconstruct(COACH, INTENT, FAMILY);
    expect(calls).toBe(3);
    expect(rowOf(prisma, 'w-1')).toMatchObject({
      status: 'reconstructed',
      target_kind: 'workout_plan',
    });
    await failing.service.reconstruct(COACH, INTENT, FAMILY);
    expect(rowOf(failing.prisma, 'w-9')).toMatchObject({
      status: 'failed',
      target_id: null,
      reason: 'error:Error',
    });
    expect(rowOf(failing.prisma, 'w-9')).not.toHaveProperty('target_kind');
  });
});
