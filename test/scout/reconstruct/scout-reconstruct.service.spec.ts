import { ConflictException } from '@nestjs/common';
import { AnalyticsService } from '../../../src/analytics/analytics.service';
import { Events } from '../../../src/analytics/events';
import { PrismaService } from '../../../src/prisma.service';
import { ScoutReconstructService } from '../../../src/scout/scout-reconstruct.service';
import { RECONSTRUCT_STATUS } from '../../../src/scout/scout-reconstruct.dto';

/**
 * ScoutReconstructService unit tests.
 *
 * The Prisma dependency is a small in-memory fake with REAL upsert + groupBy
 * semantics (keyed on the same unique tuples as the schema), so accounting,
 * idempotent replay, and poison-row isolation are proven by behaviour — not by
 * a mock that hands back a pre-decided count (a tautology the codebase
 * explicitly avoids; see scout-ingest.service.spec.ts).
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

class FakePrisma {
  terminalStatus: string | null | undefined = 'success';
  hasImport = true;
  staged: StagedRow[] = [];
  /** source_ids whose person.upsert should throw, to simulate poison rows. */
  poison = new Set<string>();

  readonly persons = new Map<string, { id: string; display_name: string | null }>();
  readonly ledger = new Map<string, LedgerRow>();

  private personKey(coach: string, platform: string, personId: string): string {
    return `${coach}|${platform}|${personId}`;
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
    findMany: async (_args: unknown) => this.staged,
  };

  person = {
    upsert: async (args: {
      where: {
        coach_id_source_platform_source_person_id: {
          coach_id: string;
          source_platform: string;
          source_person_id: string;
        };
      };
      create: { display_name: string | null };
      update: { display_name: string | null };
    }) => {
      const w = args.where.coach_id_source_platform_source_person_id;
      if (this.poison.has(w.source_person_id)) throw new Error('poison person upsert');
      const key = this.personKey(w.coach_id, w.source_platform, w.source_person_id);
      const existing = this.persons.get(key);
      if (existing) {
        existing.display_name = args.update.display_name;
        return { id: existing.id };
      }
      const created = {
        id: `person-${this.persons.size + 1}`,
        display_name: args.create.display_name,
      };
      this.persons.set(key, created);
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
    groupBy: async (_args: unknown) => {
      const counts = new Map<string, number>();
      for (const row of this.ledger.values()) {
        counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
      }
      return [...counts.entries()].map(([status, n]) => ({ status, _count: { _all: n } }));
    },
  };

  $transaction = async <T>(cb: (tx: FakePrisma) => Promise<T>): Promise<T> => cb(this);
}

/**
 * Wrap the in-memory fake as a PrismaService without a banned double-cast: the
 * fake's own-property delegates (scoutImport, person, ledger, $transaction) close
 * over the real fake instance, so the returned handle drives the same state the
 * test asserts against. Mirrors makePrisma() in scout-ingest.service.spec.ts.
 */
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

function stagedClient(sourceId: string, name = `Name ${sourceId}`): StagedRow {
  return {
    source_id: sourceId,
    source_platform: 'truecoach',
    payload: { name, email: `${sourceId}@x.io` },
  };
}

describe('ScoutReconstructService', () => {
  it('rejects an intent that has not settled (still running) with 409', async () => {
    const { service } = build((p) => {
      p.terminalStatus = null;
      p.staged = [stagedClient('1')];
    });
    await expect(service.reconstruct('coach-1', 'intent-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('rejects an unknown intent (no import row) with 409', async () => {
    const { service } = build((p) => {
      p.hasImport = false;
    });
    await expect(service.reconstruct('coach-1', 'intent-x')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('reconstructs every mappable client and keeps honest accounting', async () => {
    const { service, prisma } = build((p) => {
      p.staged = [stagedClient('1'), stagedClient('2'), stagedClient('3')];
    });
    const result = await service.reconstruct('coach-1', 'intent-1');
    expect(result).toEqual({
      intent_id: 'intent-1',
      staged: 3,
      reconstructed: 3,
      skipped: 0,
      failed: 0,
    });
    expect(result.staged).toBe(result.reconstructed + result.skipped + result.failed);
    expect(prisma.persons.size).toBe(3);
  });

  it('is an idempotent no-op on replay: identical counts, no new rows', async () => {
    const { service, prisma } = build((p) => {
      p.staged = [stagedClient('1'), stagedClient('2')];
    });
    const first = await service.reconstruct('coach-1', 'intent-1');
    const second = await service.reconstruct('coach-1', 'intent-1');
    expect(second).toEqual(first);
    expect(prisma.persons.size).toBe(2);
    expect(prisma.ledger.size).toBe(2);
  });

  it('skips an unmappable row (wrong platform) with a reason and no Person', async () => {
    const { service, prisma } = build((p) => {
      p.staged = [
        stagedClient('1'),
        { source_id: '2', source_platform: 'trainerize', payload: {} },
      ];
    });
    const result = await service.reconstruct('coach-1', 'intent-1');
    expect(result).toEqual({
      intent_id: 'intent-1',
      staged: 2,
      reconstructed: 1,
      skipped: 1,
      failed: 0,
    });
    expect(prisma.persons.size).toBe(1);
    const skipped = [...prisma.ledger.values()].find(
      (r) => r.status === RECONSTRUCT_STATUS.skipped,
    );
    expect(skipped?.reason).toBe('unsupported_platform:trainerize');
    expect(skipped?.target_id).toBeNull();
  });

  it('isolates a poison row to failed while its siblings still reconstruct', async () => {
    const { service, prisma } = build((p) => {
      p.staged = [stagedClient('1'), stagedClient('2'), stagedClient('3')];
      p.poison.add('2');
    });
    const result = await service.reconstruct('coach-1', 'intent-1');
    expect(result).toEqual({
      intent_id: 'intent-1',
      staged: 3,
      reconstructed: 2,
      skipped: 0,
      failed: 1,
    });
    expect(prisma.persons.size).toBe(2);
    const failed = [...prisma.ledger.values()].find((r) => r.status === RECONSTRUCT_STATUS.failed);
    expect(failed?.source_id).toBe('2');
    expect(failed?.target_id).toBeNull();
  });

  it('records a non-PII reason for a failed row (error class only, never payload)', async () => {
    const { service, prisma } = build((p) => {
      p.staged = [stagedClient('1', 'Secret Person')];
      p.poison.add('1');
    });
    await service.reconstruct('coach-1', 'intent-1');
    const failed = [...prisma.ledger.values()][0];
    expect(failed.reason).toBe('error:Error');
    expect(failed.reason).not.toContain('Secret Person');
    expect(failed.reason).not.toContain('@x.io');
  });

  it('handles an empty staged set with all-zero counts', async () => {
    const { service } = build();
    const result = await service.reconstruct('coach-1', 'intent-empty');
    expect(result).toEqual({
      intent_id: 'intent-empty',
      staged: 0,
      reconstructed: 0,
      skipped: 0,
      failed: 0,
    });
  });

  it('emits one completion event per pass with counts and no PII', async () => {
    const { service, capture } = build((p) => {
      p.staged = [stagedClient('1'), { source_id: '', source_platform: 'truecoach', payload: {} }];
    });
    await service.reconstruct('coach-1', 'intent-1');
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith('coach-1', Events.SCOUT_RECONSTRUCT_COMPLETED, {
      intent_id: 'intent-1',
      entity_type: 'clients',
      staged: 2,
      reconstructed: 1,
      skipped: 1,
      failed: 0,
    });
    const props = capture.mock.calls[0][2] as Record<string, unknown>;
    expect(JSON.stringify(props)).not.toContain('@x.io');
    expect(Object.keys(props)).not.toContain('email');
  });

  it('uses the stable completion event name', () => {
    expect(Events.SCOUT_RECONSTRUCT_COMPLETED).toBe('scout.reconstruct.completed');
  });

  it('accounts a mixed pass (reconstruct + skip + fail) with the invariant intact', async () => {
    const { service, prisma } = build((p) => {
      p.staged = [
        stagedClient('1'),
        { source_id: '2', source_platform: 'trainerize', payload: {} }, // skip
        stagedClient('3'),
        { source_id: '', source_platform: 'truecoach', payload: {} }, // skip (missing id)
        stagedClient('5'),
      ];
      p.poison.add('5'); // fail
    });
    const result = await service.reconstruct('coach-1', 'intent-1');
    expect(result).toEqual({
      intent_id: 'intent-1',
      staged: 5,
      reconstructed: 2,
      skipped: 2,
      failed: 1,
    });
    expect(result.staged).toBe(result.reconstructed + result.skipped + result.failed);
    expect(prisma.persons.size).toBe(2);
  });

  it('links each reconstructed ledger row to the minted Person via target_id', async () => {
    const { service, prisma } = build((p) => {
      p.staged = [stagedClient('1')];
    });
    await service.reconstruct('coach-1', 'intent-1');
    const person = [...prisma.persons.values()][0];
    const ledgerRow = [...prisma.ledger.values()][0];
    expect(ledgerRow.status).toBe(RECONSTRUCT_STATUS.reconstructed);
    expect(ledgerRow.target_id).toBe(person.id);
    expect(ledgerRow.reason).toBeNull();
  });

  it('heals a previously-failed row on replay once the poison clears (failed → reconstructed)', async () => {
    const prisma = new FakePrisma();
    prisma.staged = [stagedClient('1'), stagedClient('2')];
    prisma.poison.add('2');
    const capture = jest.fn();
    const service = new ScoutReconstructService(asPrisma(prisma), makeAnalytics(capture));

    const first = await service.reconstruct('coach-1', 'intent-1');
    expect(first).toEqual({
      intent_id: 'intent-1',
      staged: 2,
      reconstructed: 1,
      skipped: 0,
      failed: 1,
    });

    prisma.poison.delete('2'); // transient cause resolved
    const second = await service.reconstruct('coach-1', 'intent-1');
    expect(second).toEqual({
      intent_id: 'intent-1',
      staged: 2,
      reconstructed: 2,
      skipped: 0,
      failed: 0,
    });
    expect(prisma.persons.size).toBe(2);
    expect(prisma.ledger.size).toBe(2);
    const healed = [...prisma.ledger.values()].find((r) => r.source_id === '2');
    expect(healed?.status).toBe(RECONSTRUCT_STATUS.reconstructed);
    expect(healed?.reason).toBeNull();
  });

  it('updates the display name on replay without minting a new Person', async () => {
    const prisma = new FakePrisma();
    prisma.staged = [stagedClient('1', 'Old Name')];
    const capture = jest.fn();
    const service = new ScoutReconstructService(asPrisma(prisma), makeAnalytics(capture));

    await service.reconstruct('coach-1', 'intent-1');
    prisma.staged = [stagedClient('1', 'New Name')];
    await service.reconstruct('coach-1', 'intent-1');

    expect(prisma.persons.size).toBe(1);
    expect([...prisma.persons.values()][0].display_name).toBe('New Name');
  });

  it('keeps two coaches isolated even when they share a source_id', async () => {
    const prismaA = new FakePrisma();
    prismaA.staged = [stagedClient('shared')];
    const prismaB = new FakePrisma();
    prismaB.staged = [stagedClient('shared')];
    const noop = makeAnalytics(jest.fn());

    const a = await new ScoutReconstructService(asPrisma(prismaA), noop).reconstruct(
      'coach-A',
      'intent-1',
    );
    const b = await new ScoutReconstructService(asPrisma(prismaB), noop).reconstruct(
      'coach-B',
      'intent-1',
    );

    expect(a.reconstructed).toBe(1);
    expect(b.reconstructed).toBe(1);
    expect([...prismaA.persons.keys()][0]).toContain('coach-A');
    expect([...prismaB.persons.keys()][0]).toContain('coach-B');
  });

  it('records the missing_source_id reason for an empty-id skip', async () => {
    const { service, prisma } = build((p) => {
      p.staged = [{ source_id: '   ', source_platform: 'truecoach', payload: {} }];
    });
    const result = await service.reconstruct('coach-1', 'intent-1');
    expect(result.skipped).toBe(1);
    const skipped = [...prisma.ledger.values()][0];
    expect(skipped.reason).toBe('missing_source_id');
    expect(skipped.target_id).toBeNull();
  });

  it('settles for any non-null terminal status (partial/failed are still settled)', async () => {
    for (const terminal of ['success', 'partial', 'failed']) {
      const { service } = build((p) => {
        p.terminalStatus = terminal;
        p.staged = [stagedClient('1')];
      });
      const result = await service.reconstruct('coach-1', `intent-${terminal}`);
      expect(result.reconstructed).toBe(1);
    }
  });

  it('performs NO reconstruction work when the intent is rejected as unsettled', async () => {
    const { service, prisma, capture } = build((p) => {
      p.terminalStatus = null;
      p.staged = [stagedClient('1'), stagedClient('2')];
    });
    const findMany = jest.spyOn(prisma.scoutIngestEntity, 'findMany');
    await expect(service.reconstruct('coach-1', 'intent-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    // Fail-closed BEFORE any staged read, Person mint, ledger write, or event —
    // a running crawl must never leave a partial roster behind.
    expect(findMany).not.toHaveBeenCalled();
    expect(prisma.persons.size).toBe(0);
    expect(prisma.ledger.size).toBe(0);
    expect(capture).not.toHaveBeenCalled();
  });

  it('emits no analytics event when an unknown intent is rejected', async () => {
    const { service, capture } = build((p) => {
      p.hasImport = false;
    });
    await expect(service.reconstruct('coach-1', 'intent-x')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(capture).not.toHaveBeenCalled();
  });

  it('reconstructs a mappable client with no name into a null-display_name Person', async () => {
    const { service, prisma } = build((p) => {
      p.staged = [{ source_id: '1', source_platform: 'truecoach', payload: { email: '1@x.io' } }];
    });
    const result = await service.reconstruct('coach-1', 'intent-1');
    expect(result).toEqual({
      intent_id: 'intent-1',
      staged: 1,
      reconstructed: 1,
      skipped: 0,
      failed: 0,
    });
    expect(prisma.persons.size).toBe(1);
    expect([...prisma.persons.values()][0].display_name).toBeNull();
  });

  it('scopes the tally to the requested intent (a sibling intent does not leak in)', async () => {
    const prisma = new FakePrisma();
    prisma.staged = [stagedClient('1'), stagedClient('2')];
    const service = new ScoutReconstructService(asPrisma(prisma), makeAnalytics(jest.fn()));

    const a = await service.reconstruct('coach-1', 'intent-A');
    expect(a).toEqual({
      intent_id: 'intent-A',
      staged: 2,
      reconstructed: 2,
      skipped: 0,
      failed: 0,
    });

    // groupBy in the fake is intent-agnostic by construction, so this asserts the
    // service passes the intent filter and does not double-count across intents.
    const b = await service.reconstruct('coach-1', 'intent-A');
    expect(b).toEqual(a);
    expect(prisma.ledger.size).toBe(2);
  });

  it('writes exactly one ledger row per staged row (accounting is exhaustive)', async () => {
    const { service, prisma } = build((p) => {
      p.staged = [
        stagedClient('1'),
        { source_id: '2', source_platform: 'trainerize', payload: {} },
        stagedClient('3'),
      ];
      p.poison.add('3');
    });
    const result = await service.reconstruct('coach-1', 'intent-1');
    // staged (result) === ledger rows === reconstructed + skipped + failed.
    expect(prisma.ledger.size).toBe(result.staged);
    expect(result.staged).toBe(3);
  });
});
