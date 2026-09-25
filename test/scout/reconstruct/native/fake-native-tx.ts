import type { Prisma } from '@prisma/client';

/**
 * A tiny in-memory stand-in for the Prisma transaction handle covering exactly
 * the primitives the S8-C native writers use. It records every call in order
 * (so tests can pin target-before-provenance ordering and "no touch" claims)
 * and snapshots/restores state around `$transaction` so a thrown error behaves
 * like a rollback. Real atomicity, RLS and CHECKs are proven on PostgreSQL by
 * `test/rls-g2-s8c.spec.ts`; this fake only pins writer logic.
 */
export interface ProvenanceRecord {
  id: string;
  coach_id: string;
  source_namespace: string;
  entity_type: string;
  source_id: string;
  native_kind: string;
  native_id: string | null;
  outcome: string;
  reason: string | null;
}

type Row = Record<string, unknown> & { id: string };

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${++counter}`;

export class FakeNativeTx {
  calls: string[] = [];
  provenance = new Map<string, ProvenanceRecord>();
  programs = new Map<string, Row>();
  plans = new Map<string, Row>();
  exercises = new Map<string, Row>();
  revisions = new Map<string, Row>();
  entities = new Map<string, Row>();
  catalog: { id: string; slug: string }[] = [];
  /** When set, the named model.method throws on its next call (simulates a mid-transaction failure). */
  failAt: string | null = null;

  private key(k: {
    coach_id: string;
    source_namespace: string;
    entity_type: string;
    source_id: string;
  }) {
    return `${k.coach_id}|${k.source_namespace}|${k.entity_type}|${k.source_id}`;
  }

  private hit(name: string) {
    this.calls.push(name);
    if (this.failAt === name) {
      this.failAt = null;
      throw new Error(`injected failure at ${name}`);
    }
  }

  importNativeProvenance = {
    findUnique: async (args: {
      where: {
        coach_id_source_namespace_entity_type_source_id: Parameters<FakeNativeTx['key']>[0];
      };
    }) => {
      this.hit('importNativeProvenance.findUnique');
      return (
        this.provenance.get(this.key(args.where.coach_id_source_namespace_entity_type_source_id)) ??
        null
      );
    },
    create: async (args: { data: Omit<ProvenanceRecord, 'id'> }) => {
      this.hit('importNativeProvenance.create');
      const k = this.key(args.data);
      if (this.provenance.has(k)) {
        const err = new Error('Unique constraint failed') as Error & { code: string };
        err.code = 'P2002';
        throw err;
      }
      const row = { id: nextId('prov'), ...args.data };
      this.provenance.set(k, row);
      return row;
    },
    update: async (args: { where: { id: string }; data: Partial<ProvenanceRecord> }) => {
      this.hit('importNativeProvenance.update');
      const row = [...this.provenance.values()].find((r) => r.id === args.where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, args.data);
      return row;
    },
    upsert: async (args: {
      where: {
        coach_id_source_namespace_entity_type_source_id: Parameters<FakeNativeTx['key']>[0];
      };
      create: Omit<ProvenanceRecord, 'id'>;
      update: Partial<ProvenanceRecord>;
    }) => {
      this.hit('importNativeProvenance.upsert');
      const k = this.key(args.where.coach_id_source_namespace_entity_type_source_id);
      const existing = this.provenance.get(k);
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }
      const row = { id: nextId('prov'), ...args.create };
      this.provenance.set(k, row);
      return row;
    },
    count: async (args: {
      where: {
        coach_id: string;
        source_namespace: string;
        entity_type: string;
        source_id: { startsWith: string };
        native_kind: string;
        outcome: string;
      };
    }) => {
      this.hit('importNativeProvenance.count');
      const w = args.where;
      return [...this.provenance.values()].filter(
        (r) =>
          r.coach_id === w.coach_id &&
          r.source_namespace === w.source_namespace &&
          r.entity_type === w.entity_type &&
          r.source_id.startsWith(w.source_id.startsWith) &&
          r.native_kind === w.native_kind &&
          r.outcome === w.outcome,
      ).length;
    },
  };

  private table(name: string, getStore: () => Map<string, Row>) {
    return {
      create: async (args: { data: Record<string, unknown> }) => {
        this.hit(`${name}.create`);
        const row = { id: nextId(name), archived_at: null, ...args.data } as Row;
        getStore().set(row.id, row);
        return { id: row.id };
      },
      findUnique: async (args: { where: { id: string } }) => {
        this.hit(`${name}.findUnique`);
        return getStore().get(args.where.id) ?? null;
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        this.hit(`${name}.update`);
        const row = getStore().get(args.where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, args.data);
        return row;
      },
    };
  }

  workoutProgram = this.table('workoutProgram', () => this.programs);
  workoutPlan = this.table('workoutPlan', () => this.plans);
  workoutPlanExercise = this.table('workoutPlanExercise', () => this.exercises);
  workoutPlanRevision = this.table('workoutPlanRevision', () => this.revisions);

  exerciseCatalogItem = {
    findMany: async (args: {
      where: { OR: [{ id: { in: string[] } }, { slug: { in: string[] } }] };
    }) => {
      this.hit('exerciseCatalogItem.findMany');
      const ids = new Set(args.where.OR[0].id.in);
      const slugs = new Set(args.where.OR[1].slug.in);
      return this.catalog.filter((c) => ids.has(c.id) || slugs.has(c.slug));
    },
  };

  scoutReconstructedEntity = {
    upsert: async (args: {
      where: { coach_id_source_platform_entity_type_source_id: Record<string, string> };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      this.hit('scoutReconstructedEntity.upsert');
      const w = args.where.coach_id_source_platform_entity_type_source_id;
      const k = `${w.coach_id}|${w.source_platform}|${w.entity_type}|${w.source_id}`;
      const existing = this.entities.get(k);
      if (existing) {
        Object.assign(existing, args.update);
        return { id: existing.id };
      }
      const row = { id: nextId('entity'), ...args.create } as Row;
      this.entities.set(k, row);
      return { id: row.id };
    },
  };

  /** Snapshot-and-restore transaction: a throw leaves no partial state behind. */
  async $transaction<T>(fn: (tx: FakeNativeTx) => Promise<T>): Promise<T> {
    const snapshot = [
      this.provenance,
      this.programs,
      this.plans,
      this.exercises,
      this.revisions,
      this.entities,
    ].map((m) => new Map([...m].map(([k, v]) => [k, { ...v }])));
    try {
      return await fn(this);
    } catch (err) {
      [this.provenance, this.programs, this.plans, this.exercises, this.revisions, this.entities] =
        snapshot as [
          Map<string, ProvenanceRecord>,
          Map<string, Row>,
          Map<string, Row>,
          Map<string, Row>,
          Map<string, Row>,
          Map<string, Row>,
        ];
      throw err;
    }
  }

  asTx(): Prisma.TransactionClient {
    return asTransactionClient(this);
  }
}

/**
 * Structural fake: the intersection assertion is honest about what callers
 * receive and needs no double cast. `this` is a polymorphic type parameter,
 * so the assertion is made from the concrete class type via a parameter.
 */
function asTransactionClient(fake: FakeNativeTx): Prisma.TransactionClient {
  return fake as FakeNativeTx & Prisma.TransactionClient;
}
