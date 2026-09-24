import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import { AnalyticsService } from '../../../src/analytics/analytics.service';
import { PrismaService } from '../../../src/prisma.service';
import { buildFamilyRegistry, type StagedRow } from '../../../src/scout/reconstruct/families';
import {
  buildSourceMapperRegistry,
  resolveStagedFamily,
} from '../../../src/scout/reconstruct/source-mapper-registry';
import { RECONSTRUCT_FAMILY } from '../../../src/scout/scout-reconstruct.dto';
import { ScoutReconstructService } from '../../../src/scout/scout-reconstruct.service';

/**
 * S8-A — NEW SOURCE → CORE DIFF = 0 (mapping). `conformance_beta` is a third,
 * synthetic, non-production source added as ONE data file
 * (`src/scout/reconstruct/sources/conformance_beta.json`) plus this spec: no
 * TypeScript anywhere under `src/` names it or registers it. Its shape differs
 * from both earlier sources — deeper nesting (`data.person.fullName`), path
 * fallbacks (`nickname`, `athleteRef`, `summary`), and its own step tokens
 * (`athletes`/`programs`/`sessions`; `messages` is unmapped) — and it is
 * driven through the UNMODIFIED reconstruct engine end to end.
 */

const PLATFORM = 'conformance_beta';

function row(source_id: string, payload: Prisma.JsonValue): StagedRow {
  return { source_id, source_platform: PLATFORM, payload };
}

describe('conformance_beta — registered from data alone', () => {
  const registry = buildSourceMapperRegistry();

  it('is reachable by its source_platform with no TypeScript registration', () => {
    expect(registry.get(PLATFORM)?.sourcePlatform).toBe(PLATFORM);
  });

  it('no src TypeScript mentions the new source', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith('.ts') && readFileSync(path, 'utf8').includes(PLATFORM)) {
          offenders.push(path);
        }
      }
    };
    walk(join(__dirname, '../../../src'));
    expect(offenders).toEqual([]);
  });

  it('resolves its own step tokens and leaves `messages` explicitly unresolved', () => {
    expect(resolveStagedFamily(registry, PLATFORM, 'athletes')).toEqual({
      ok: true,
      family: 'clients',
    });
    expect(resolveStagedFamily(registry, PLATFORM, 'programs')).toEqual({
      ok: true,
      family: 'workouts',
    });
    expect(resolveStagedFamily(registry, PLATFORM, 'sessions')).toEqual({
      ok: true,
      family: 'client_history',
    });
    expect(resolveStagedFamily(registry, PLATFORM, 'messages')).toEqual({
      ok: false,
      reason: 'unresolved_family:messages',
    });
  });
});

describe('conformance_beta — family layer map()', () => {
  const families = buildFamilyRegistry();
  const clients = families.get(RECONSTRUCT_FAMILY.clients)!;
  const workouts = families.get(RECONSTRUCT_FAMILY.workouts)!;
  const history = families.get(RECONSTRUCT_FAMILY.client_history)!;

  it('maps the deep person name, falling back to the nickname path', () => {
    expect(
      clients.map(
        row(' ath-1 ', {
          data: { person: { fullName: '  Rae Kim ', email: 'x@y.z' } },
        }),
      ),
    ).toEqual({
      ok: true,
      mapped: {
        sourcePersonId: 'ath-1',
        sourcePlatform: PLATFORM,
        displayName: 'Rae Kim',
      },
    });
    expect(clients.map(row('ath-2', { data: { person: { nickname: 'Jo' } } }))).toEqual({
      ok: true,
      mapped: {
        sourcePersonId: 'ath-2',
        sourcePlatform: PLATFORM,
        displayName: 'Jo',
      },
    });
    expect(clients.map(row('ath-3', { fullName: 'Flat Name' }))).toEqual({
      ok: true,
      mapped: {
        sourcePersonId: 'ath-3',
        sourcePlatform: PLATFORM,
        displayName: null,
      },
    });
  });

  it('maps entity links and labels through nested paths and fallbacks', () => {
    expect(
      workouts.map(
        row('prg-1', {
          links: { athlete: { ref: 11 } },
          meta: { headline: 'Block A' },
          price: 9,
        }),
      ),
    ).toEqual({
      ok: true,
      mapped: {
        sourcePlatform: PLATFORM,
        clientSourceId: '11',
        label: 'Block A',
      },
    });
    expect(history.map(row('ses-1', { athleteRef: ' ath-1 ', summary: 'Tempo run' }))).toEqual({
      ok: true,
      mapped: {
        sourcePlatform: PLATFORM,
        clientSourceId: 'ath-1',
        label: 'Tempo run',
      },
    });
    expect(history.map(row('ses-2', []))).toEqual({
      ok: true,
      mapped: { sourcePlatform: PLATFORM, clientSourceId: null, label: null },
    });
  });

  it('keeps the core skip reasons', () => {
    expect(clients.map(row('   ', {}))).toEqual({
      ok: false,
      reason: 'missing_source_id',
    });
  });
});

// ---------------------------------------------------------------------------
// Minimal in-memory Prisma double for the REAL ScoutReconstructService: just the
// calls the engine makes for one (coach, intent, family) scope.
// ---------------------------------------------------------------------------

interface Staged {
  readonly entity_type: string;
  readonly source_id: string;
  readonly source_platform: string;
  readonly payload: Prisma.JsonValue;
}
interface Ledger {
  entity_type: string;
  source_platform: string;
  source_id: string;
  status: string;
  target_id: string | null;
  reason: string | null;
}
interface PersonRow {
  id: string;
  coach_id: string;
  source_platform: string;
  source_person_id: string;
  display_name: string | null;
}
interface Where {
  entity_type: string;
}

class FakePrisma {
  readonly staged: Staged[] = [];
  readonly persons = new Map<string, PersonRow>();
  readonly entities = new Map<
    string,
    { id: string; client_source_id: string | null; label: string | null }
  >();
  readonly ledger = new Map<string, Ledger>();

  scoutImport = { findUnique: async () => ({ terminal_status: 'success' }) };

  scoutIngestEntity = {
    count: async (args: { where: Where }) =>
      this.staged.filter((r) => r.entity_type === args.where.entity_type).length,
    findMany: async (args: { where: Where; take: number; skip: number }) =>
      this.staged
        .filter((r) => r.entity_type === args.where.entity_type)
        .sort((a, b) => (a.source_id < b.source_id ? -1 : a.source_id > b.source_id ? 1 : 0))
        .slice(args.skip, args.skip + args.take)
        .map(({ source_id, source_platform, payload }) => ({
          source_id,
          source_platform,
          payload,
        })),
  };

  person = {
    upsert: async (args: {
      where: {
        coach_id_source_platform_source_person_id: Record<string, string>;
      };
      create: Omit<PersonRow, 'id'>;
      update: { display_name: string | null };
    }) => {
      const w = args.where.coach_id_source_platform_source_person_id;
      const key = `${w.coach_id}|${w.source_platform}|${w.source_person_id}`;
      const existing = this.persons.get(key);
      if (existing) {
        existing.display_name = args.update.display_name;
        return { id: existing.id };
      }
      const created = { id: `person-${this.persons.size + 1}`, ...args.create };
      this.persons.set(key, created);
      return { id: created.id };
    },
  };

  scoutReconstructedEntity = {
    upsert: async (args: {
      where: {
        coach_id_source_platform_entity_type_source_id: Record<string, string>;
      };
      create: { client_source_id: string | null; label: string | null };
      update: { client_source_id: string | null; label: string | null };
    }) => {
      const w = args.where.coach_id_source_platform_entity_type_source_id;
      const key = `${w.coach_id}|${w.source_platform}|${w.entity_type}|${w.source_id}`;
      const existing = this.entities.get(key);
      if (existing) {
        Object.assign(existing, args.update);
        return { id: existing.id };
      }
      const created = {
        id: `entity-${this.entities.size + 1}`,
        client_source_id: args.create.client_source_id,
        label: args.create.label,
      };
      this.entities.set(key, created);
      return { id: created.id };
    },
  };

  scoutReconstructionLedger = {
    upsert: async (args: {
      where: {
        coach_id_intent_id_entity_type_source_platform_source_id: Ledger;
      };
      create: Ledger;
    }) => {
      const w = args.where.coach_id_intent_id_entity_type_source_platform_source_id;
      const key = `${w.entity_type}|${w.source_platform}|${w.source_id}`;
      if (!this.ledger.has(key)) this.ledger.set(key, { ...args.create });
      return this.ledger.get(key);
    },
    updateMany: async (args: {
      where: Ledger & { status?: { not: string } };
      data: Partial<Ledger>;
    }) => {
      const w = args.where;
      const existing = this.ledger.get(`${w.entity_type}|${w.source_platform}|${w.source_id}`);
      if (!existing || (w.status && existing.status === w.status.not)) return { count: 0 };
      Object.assign(existing, args.data);
      return { count: 1 };
    },
    groupBy: async (args: { where: Where }) => {
      const counts = new Map<string, number>();
      for (const entry of this.ledger.values()) {
        if (entry.entity_type !== args.where.entity_type) continue;
        counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
      }
      return [...counts.entries()].map(([status, n]) => ({
        status,
        _count: { _all: n },
      }));
    },
  };

  $transaction = async <T>(cb: (tx: FakePrisma) => Promise<T>): Promise<T> => cb(this);
}

function build() {
  const prisma = new FakePrisma();
  const service = new ScoutReconstructService(
    Object.assign(Object.create(PrismaService.prototype) as PrismaService, prisma),
    Object.assign(Object.create(AnalyticsService.prototype) as AnalyticsService, {
      capture: jest.fn(),
    }),
  );
  return { prisma, service };
}

describe('conformance_beta — the unmodified engine reconstructs it end to end', () => {
  it('reconstructs clients and workouts with honest, replay-stable accounting', async () => {
    const { prisma, service } = build();
    const stage = (entity_type: string, source_id: string, payload: Prisma.JsonValue) =>
      prisma.staged.push({
        entity_type,
        source_id,
        source_platform: PLATFORM,
        payload,
      });
    stage('clients', 'ath-1', { data: { person: { fullName: 'Rae Kim' } } });
    stage('clients', 'ath-2', { data: { person: { nickname: 'Jo' } } });
    stage('clients', '   ', { data: { person: { fullName: 'Poison' } } });
    stage('workouts', 'prg-1', {
      links: { athlete: { ref: 'ath-1' } },
      meta: { headline: 'A' },
    });

    const first = {
      clients: await service.reconstruct('coach-1', 'intent-1', RECONSTRUCT_FAMILY.clients),
      workouts: await service.reconstruct('coach-1', 'intent-1', RECONSTRUCT_FAMILY.workouts),
    };
    expect(first.clients).toEqual({
      intent_id: 'intent-1',
      staged: 3,
      reconstructed: 2,
      skipped: 1,
      failed: 0,
    });
    expect(first.workouts).toEqual({
      intent_id: 'intent-1',
      staged: 1,
      reconstructed: 1,
      skipped: 0,
      failed: 0,
    });
    expect([...prisma.persons.values()]).toEqual([
      {
        id: 'person-1',
        coach_id: 'coach-1',
        source_platform: PLATFORM,
        source_person_id: 'ath-1',
        display_name: 'Rae Kim',
      },
      {
        id: 'person-2',
        coach_id: 'coach-1',
        source_platform: PLATFORM,
        source_person_id: 'ath-2',
        display_name: 'Jo',
      },
    ]);
    expect([...prisma.entities.values()]).toEqual([
      { id: 'entity-1', client_source_id: 'ath-1', label: 'A' },
    ]);
    expect(prisma.ledger.get('clients|conformance_beta|   ')).toMatchObject({
      status: 'skipped',
      reason: 'missing_source_id',
    });

    const replay = await service.reconstruct('coach-1', 'intent-1', RECONSTRUCT_FAMILY.clients);
    expect(replay).toEqual(first.clients);
    expect(prisma.persons.size).toBe(2);
  });
});
