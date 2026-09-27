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

/** A roster `Person` as the S8-D1 writer sees it (no `archived_at`; `state` carries removal). */
export interface PersonRecord {
  id: string;
  coach_id: string;
  source_platform: string;
  source_person_id: string;
  display_name: string | null;
  state: 'InvitePending' | 'Invited' | 'Claimed' | 'Suspended' | 'Deleted';
}

/** Structural P2002 (the writer/engine only read `.code`). */
function uniqueViolation(): Error {
  const err = new Error('Unique constraint failed') as Error & { code: string };
  err.code = 'P2002';
  return err;
}

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
  /** Persons keyed by id; the external ref (coach|platform|source_person_id) is enforced on create. */
  persons = new Map<string, PersonRecord>();
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
      if (this.provenance.has(k)) throw uniqueViolation();
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

  /**
   * S8-D1 `Person` primitives: exactly `findUnique` (by id or by the external
   * ref) and `create`. Deliberately NO `upsert`/`update`: the writer is
   * create-only, so a fake that silently accepted an update would hide a
   * display_name overwrite. A duplicate external ref on create is P2002, as on
   * PostgreSQL (`@@unique([coach_id, source_platform, source_person_id])`).
   */
  person = {
    findUnique: async (args: {
      where:
        | { id: string }
        | {
            coach_id_source_platform_source_person_id: {
              coach_id: string;
              source_platform: string;
              source_person_id: string;
            };
          };
    }) => {
      this.hit('person.findUnique');
      if ('id' in args.where) return this.persons.get(args.where.id) ?? null;
      const ref = args.where.coach_id_source_platform_source_person_id;
      return (
        [...this.persons.values()].find(
          (p) =>
            p.coach_id === ref.coach_id &&
            p.source_platform === ref.source_platform &&
            p.source_person_id === ref.source_person_id,
        ) ?? null
      );
    },
    create: async (args: {
      data: {
        coach_id: string;
        source_platform: string;
        source_person_id: string;
        display_name: string | null;
      };
    }) => {
      this.hit('person.create');
      const d = args.data;
      const clash = [...this.persons.values()].some(
        (p) =>
          p.coach_id === d.coach_id &&
          p.source_platform === d.source_platform &&
          p.source_person_id === d.source_person_id,
      );
      if (clash) throw uniqueViolation();
      const row: PersonRecord = { id: nextId('person'), state: 'InvitePending', ...d };
      this.persons.set(row.id, row);
      return { id: row.id };
    },
  };

  /** Seed a Person directly (a pre-D1 row, another coach's row, a Deleted row). */
  seedPerson(fields: Omit<PersonRecord, 'id'> & { id?: string }): PersonRecord {
    const row: PersonRecord = { id: fields.id ?? nextId('person'), ...fields };
    this.persons.set(row.id, row);
    return row;
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
    const clone = <V extends object>(m: Map<string, V>): Map<string, V> =>
      new Map([...m].map(([k, v]) => [k, { ...v }]));
    const snapshot = {
      provenance: clone(this.provenance),
      programs: clone(this.programs),
      plans: clone(this.plans),
      exercises: clone(this.exercises),
      revisions: clone(this.revisions),
      entities: clone(this.entities),
      persons: clone(this.persons),
    };
    try {
      return await fn(this);
    } catch (err) {
      this.provenance = snapshot.provenance;
      this.programs = snapshot.programs;
      this.plans = snapshot.plans;
      this.exercises = snapshot.exercises;
      this.revisions = snapshot.revisions;
      this.entities = snapshot.entities;
      this.persons = snapshot.persons;
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
