import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AnalyticsService } from '../../../src/analytics/analytics.service';
import { Events } from '../../../src/analytics/events';
import { PrismaService } from '../../../src/prisma.service';
import { ScoutReconstructService } from '../../../src/scout/scout-reconstruct.service';
import { RECONSTRUCT_FAMILY, RECONSTRUCT_STATUS } from '../../../src/scout/scout-reconstruct.dto';

/**
 * IMPORTER-H parametrized-engine tests (the non-person families).
 *
 * The clients family is covered by scout-reconstruct.service.spec.ts. This spec
 * proves the SAME single engine drives `workouts` and `client_history` into the
 * ONE generic canonical table (ScoutReconstructedEntity) with identical
 * guarantees — honest accounting, idempotent replay, skip reasons, poison-row
 * isolation, P2002 retry-once convergence, tenant scoping, cross-family
 * separation — plus the fail-closed 400 for an unregistered family. As in the
 * clients spec, the Prisma dependency is a small in-memory fake with REAL
 * upsert + groupBy semantics keyed on the schema's unique tuples, so the
 * accounting is proven by behaviour rather than a pre-decided mock count.
 */

interface StagedRow {
  source_id: string;
  source_platform: string;
  payload: unknown;
}
interface LedgerRow {
  coach_id: string;
  intent_id: string;
  entity_type: string;
  source_id: string;
  status: string;
  target_id: string | null;
  reason: string | null;
}
interface EntityRow {
  id: string;
  coach_id: string;
  source_platform: string;
  entity_type: string;
  source_id: string;
  client_source_id: string | null;
  label: string | null;
}

class FakePrisma {
  terminalStatus: string | null | undefined = 'success';
  hasImport = true;
  staged: StagedRow[] = [];
  /** source_ids whose entity upsert should throw, to simulate poison rows. */
  poison = new Set<string>();
  /** source_ids for which the FIRST entity upsert loses a concurrent race (P2002 once). */
  p2002Once = new Set<string>();

  readonly entities = new Map<string, EntityRow>();
  readonly ledger = new Map<string, LedgerRow>();

  private entityKey(coach: string, platform: string, entityType: string, sourceId: string): string {
    return `${coach}|${platform}|${entityType}|${sourceId}`;
  }
  private ledgerKey(r: {
    coach_id: string;
    intent_id: string;
    entity_type: string;
    source_id: string;
  }): string {
    return `${r.coach_id}|${r.intent_id}|${r.entity_type}|${r.source_id}`;
  }

  scoutImport = {
    findUnique: async (_args: unknown) =>
      this.hasImport ? { terminal_status: this.terminalStatus } : null,
  };

  scoutIngestEntity = {
    count: async (_args: unknown) => this.staged.length,
    findMany: async (args: { take?: number; skip?: number }) => {
      const skip = args.skip ?? 0;
      const take = args.take ?? this.staged.length;
      const ordered = [...this.staged].sort((a, b) => a.source_id.localeCompare(b.source_id));
      return ordered.slice(skip, skip + take);
    },
  };

  scoutReconstructedEntity = {
    upsert: async (args: {
      where: {
        coach_id_source_platform_entity_type_source_id: {
          coach_id: string;
          source_platform: string;
          entity_type: string;
          source_id: string;
        };
      };
      create: Omit<EntityRow, 'id'>;
      update: Partial<EntityRow>;
    }) => {
      const w = args.where.coach_id_source_platform_entity_type_source_id;
      if (this.poison.has(w.source_id)) throw new Error('poison entity upsert');
      const key = this.entityKey(w.coach_id, w.source_platform, w.entity_type, w.source_id);
      if (this.p2002Once.has(w.source_id)) {
        this.p2002Once.delete(w.source_id);
        if (!this.entities.has(key)) {
          this.entities.set(key, { id: `entity-${this.entities.size + 1}`, ...args.create });
        }
        throw new Prisma.PrismaClientKnownRequestError('unique violation', {
          code: 'P2002',
          clientVersion: 'test',
        });
      }
      const existing = this.entities.get(key);
      if (existing) {
        Object.assign(existing, args.update);
        return { id: existing.id };
      }
      const created = { id: `entity-${this.entities.size + 1}`, ...args.create };
      this.entities.set(key, created);
      return { id: created.id };
    },
  };

  scoutReconstructionLedger = {
    upsert: async (args: {
      where: { coach_id_intent_id_entity_type_source_id: LedgerRow };
      create: LedgerRow;
      update: Partial<LedgerRow>;
    }) => {
      const key = this.ledgerKey(args.where.coach_id_intent_id_entity_type_source_id);
      const existing = this.ledger.get(key);
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }
      const row = { ...args.create };
      this.ledger.set(key, row);
      return row;
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

  $transaction = async <T>(cb: (tx: FakePrisma) => Promise<T>): Promise<T> => cb(this);
}

function asPrisma(fake: FakePrisma): PrismaService {
  return Object.assign(Object.create(PrismaService.prototype) as PrismaService, fake);
}
function makeAnalytics(capture: jest.Mock): AnalyticsService {
  return Object.assign(Object.create(AnalyticsService.prototype) as AnalyticsService, { capture });
}
function build(configure: (p: FakePrisma) => void = () => {}) {
  const prisma = new FakePrisma();
  configure(prisma);
  const capture = jest.fn();
  const service = new ScoutReconstructService(asPrisma(prisma), makeAnalytics(capture));
  return { service, prisma, capture };
}

function stagedEntity(sourceId: string, label = `Item ${sourceId}`, clientId = '7'): StagedRow {
  return {
    source_id: sourceId,
    source_platform: 'truecoach',
    payload: { title: label, client_id: clientId, price: 49.99, invoice_id: `inv_${sourceId}` },
  };
}

describe('ScoutReconstructService — parametrized non-person families', () => {
  for (const entityType of [RECONSTRUCT_FAMILY.workouts, RECONSTRUCT_FAMILY.client_history]) {
    describe(`family: ${entityType}`, () => {
      it('reconstructs every mappable row into the generic canonical table', async () => {
        const { service, prisma } = build((p) => {
          p.staged = [stagedEntity('501'), stagedEntity('502'), stagedEntity('503')];
        });
        const result = await service.reconstruct('coach-1', 'intent-1', entityType);
        expect(result).toEqual({
          intent_id: 'intent-1',
          staged: 3,
          reconstructed: 3,
          skipped: 0,
          failed: 0,
        });
        expect(result.staged).toBe(result.reconstructed + result.skipped + result.failed);
        expect(prisma.entities.size).toBe(3);
        for (const row of prisma.entities.values()) expect(row.entity_type).toBe(entityType);
      });

      it('is an idempotent no-op on replay: identical counts, no new rows', async () => {
        const { service, prisma } = build((p) => {
          p.staged = [stagedEntity('501'), stagedEntity('502')];
        });
        const first = await service.reconstruct('coach-1', 'intent-1', entityType);
        const second = await service.reconstruct('coach-1', 'intent-1', entityType);
        expect(second).toEqual(first);
        expect(prisma.entities.size).toBe(2);
        expect(prisma.ledger.size).toBe(2);
      });

      it('links each reconstructed ledger row to the canonical entity via target_id', async () => {
        const { service, prisma } = build((p) => {
          p.staged = [stagedEntity('501')];
        });
        await service.reconstruct('coach-1', 'intent-1', entityType);
        const entity = [...prisma.entities.values()][0];
        const ledgerRow = [...prisma.ledger.values()][0];
        expect(ledgerRow.status).toBe(RECONSTRUCT_STATUS.reconstructed);
        expect(ledgerRow.target_id).toBe(entity.id);
        expect(ledgerRow.entity_type).toBe(entityType);
        expect(ledgerRow.reason).toBeNull();
      });

      it('skips an unmappable row (wrong platform) with a reason and no entity', async () => {
        const { service, prisma } = build((p) => {
          p.staged = [
            stagedEntity('501'),
            { source_id: '502', source_platform: 'trainerize', payload: {} },
          ];
        });
        const result = await service.reconstruct('coach-1', 'intent-1', entityType);
        expect(result).toEqual({
          intent_id: 'intent-1',
          staged: 2,
          reconstructed: 1,
          skipped: 1,
          failed: 0,
        });
        expect(prisma.entities.size).toBe(1);
        const skipped = [...prisma.ledger.values()].find(
          (r) => r.status === RECONSTRUCT_STATUS.skipped,
        );
        expect(skipped?.reason).toBe('unsupported_platform:trainerize');
        expect(skipped?.target_id).toBeNull();
      });

      it('isolates a poison row to failed while its siblings still reconstruct', async () => {
        const { service, prisma } = build((p) => {
          p.staged = [stagedEntity('501'), stagedEntity('502'), stagedEntity('503')];
          p.poison.add('502');
        });
        const result = await service.reconstruct('coach-1', 'intent-1', entityType);
        expect(result).toEqual({
          intent_id: 'intent-1',
          staged: 3,
          reconstructed: 2,
          skipped: 0,
          failed: 1,
        });
        expect(prisma.entities.size).toBe(2);
        const failed = [...prisma.ledger.values()].find(
          (r) => r.status === RECONSTRUCT_STATUS.failed,
        );
        expect(failed?.source_id).toBe('502');
        expect(failed?.reason).toBe('error:Error');
      });

      it('retries once on a lost insert race and converges to reconstructed', async () => {
        const { service, prisma } = build((p) => {
          p.staged = [stagedEntity('501')];
          p.p2002Once.add('501');
        });
        const result = await service.reconstruct('coach-1', 'intent-1', entityType);
        expect(result.reconstructed).toBe(1);
        expect(result.failed).toBe(0);
        expect(prisma.entities.size).toBe(1);
        expect(prisma.ledger.size).toBe(1);
      });

      it('emits one completion event carrying the family entity_type and no PII', async () => {
        const { service, capture } = build((p) => {
          p.staged = [stagedEntity('501')];
        });
        await service.reconstruct('coach-1', 'intent-1', entityType);
        expect(capture).toHaveBeenCalledTimes(1);
        expect(capture).toHaveBeenCalledWith('coach-1', Events.SCOUT_RECONSTRUCT_COMPLETED, {
          intent_id: 'intent-1',
          entity_type: entityType,
          staged: 1,
          reconstructed: 1,
          skipped: 0,
          failed: 0,
        });
      });

      it('scopes count, findMany, and tally.groupBy by the token coach_id + family', async () => {
        const prisma = new FakePrisma();
        prisma.staged = [stagedEntity('501')];
        const count = jest.spyOn(prisma.scoutIngestEntity, 'count');
        const findMany = jest.spyOn(prisma.scoutIngestEntity, 'findMany');
        const groupBy = jest.spyOn(prisma.scoutReconstructionLedger, 'groupBy');
        const service = new ScoutReconstructService(asPrisma(prisma), makeAnalytics(jest.fn()));

        await service.reconstruct('coach-7', 'intent-1', entityType);

        for (const spy of [count, findMany, groupBy]) {
          const arg = spy.mock.calls[0][0] as { where: { coach_id: string; entity_type: string } };
          expect(arg.where.coach_id).toBe('coach-7');
          expect(arg.where.entity_type).toBe(entityType);
        }
        expect([...prisma.entities.keys()][0]).toContain('coach-7');
      });
    });
  }

  it('fails closed with a 400 on an unregistered family BEFORE any read', async () => {
    const { service, prisma, capture } = build((p) => {
      p.staged = [stagedEntity('501')];
    });
    const findUnique = jest.spyOn(prisma.scoutImport, 'findUnique');
    const count = jest.spyOn(prisma.scoutIngestEntity, 'count');
    await expect(service.reconstruct('coach-1', 'intent-1', 'billing')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // Fail-closed BEFORE the settled gate, any staged read, or any write.
    expect(findUnique).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
    expect(prisma.entities.size).toBe(0);
    expect(prisma.ledger.size).toBe(0);
    expect(capture).not.toHaveBeenCalled();
  });

  it('keeps two families of the same intent separate (no cross-family double count)', async () => {
    const prisma = new FakePrisma();
    prisma.staged = [stagedEntity('501'), stagedEntity('502')];
    const service = new ScoutReconstructService(asPrisma(prisma), makeAnalytics(jest.fn()));

    const workouts = await service.reconstruct('coach-1', 'intent-1', RECONSTRUCT_FAMILY.workouts);
    const history = await service.reconstruct(
      'coach-1',
      'intent-1',
      RECONSTRUCT_FAMILY.client_history,
    );

    expect(workouts.reconstructed).toBe(2);
    expect(history.reconstructed).toBe(2);
    // Two families × two rows = four ledger rows and four canonical entities,
    // separated by entity_type — one family's tally never leaks the other's.
    expect(prisma.ledger.size).toBe(4);
    expect(prisma.entities.size).toBe(4);
  });

  it('carries the client link and label onto the canonical entity', async () => {
    const { service, prisma } = build((p) => {
      p.staged = [stagedEntity('501', 'Upper Body A', '7')];
    });
    await service.reconstruct('coach-1', 'intent-1', RECONSTRUCT_FAMILY.workouts);
    const entity = [...prisma.entities.values()][0];
    expect(entity.client_source_id).toBe('7');
    expect(entity.label).toBe('Upper Body A');
    // Billing noise from the staged payload never reaches the canonical entity.
    const serialized = JSON.stringify(entity).toLowerCase();
    expect(serialized).not.toContain('price');
    expect(serialized).not.toContain('invoice');
  });
});
