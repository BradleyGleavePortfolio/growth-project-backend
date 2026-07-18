import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PersonState } from '@prisma/client';
import { AnalyticsService } from '../../../src/analytics/analytics.service';
import { Events } from '../../../src/analytics/events';
import { PrismaService } from '../../../src/prisma.service';
import { ScoutRosterService } from '../../../src/scout/scout-roster.service';
import {
  ROSTER_DEFAULT_PAGE_SIZE,
  ROSTER_MAX_PAGE_SIZE,
} from '../../../src/scout/scout-roster.dto';
import { RECONSTRUCT_ENTITY_TYPE } from '../../../src/scout/scout-reconstruct.dto';

/**
 * ScoutRosterService unit tests.
 *
 * The Prisma dependency is a small in-memory fake with REAL count / groupBy /
 * findMany semantics (same unique tuples and ordering as the schema), so
 * coach-scoping, accounting, deterministic pagination, cursor round-tripping,
 * and deleted/cross-tenant exclusion are proven by BEHAVIOUR — not by a mock
 * that hands back a pre-decided page (a tautology the codebase avoids).
 */

const COACH = 'coach-1';
const OTHER = 'coach-2';
const INTENT = 'intent-1';
const ET = RECONSTRUCT_ENTITY_TYPE;

interface IngestRow {
  coach_id: string;
  intent_id: string;
  entity_type: string;
  source_id: string;
}
interface LedgerRow {
  coach_id: string;
  intent_id: string;
  entity_type: string;
  source_id: string;
  status: string;
  target_id: string | null;
}
interface PersonRow {
  id: string;
  coach_id: string;
  source_platform: string;
  source_person_id: string;
  display_name: string | null;
  state: PersonState;
  created_at: Date;
  updated_at: Date;
}

interface Where {
  coach_id?: string;
  intent_id?: string;
  entity_type?: string;
  status?: string;
  source_id?: { gt?: string };
  id?: { in?: string[] };
  state?: { not?: PersonState };
}

class FakePrisma {
  imports: Array<{
    coach_id: string;
    intent_id: string;
    id: string;
    terminal_status: string | null;
  }> = [];
  ingest: IngestRow[] = [];
  ledgerRows: LedgerRow[] = [];
  persons: PersonRow[] = [];

  // Observability for the snapshot test: how many interactive transactions ran,
  // with what isolation level, and whether every read happened inside one.
  transactionCalls: Array<{ isolationLevel?: string }> = [];
  private txDepth = 0;
  readsOutsideTx = 0;

  // Interactive $transaction: records the isolation option and runs the callback
  // against this same fake as the tx client, so the real service's reads (count,
  // groupBy, findMany, person.findMany) all execute inside the one snapshot.
  $transaction = async <T>(
    fn: (tx: FakePrisma) => Promise<T>,
    opts?: { isolationLevel?: string },
  ): Promise<T> => {
    this.transactionCalls.push({ isolationLevel: opts?.isolationLevel });
    this.txDepth += 1;
    try {
      return await fn(this);
    } finally {
      this.txDepth -= 1;
    }
  };

  private noteRead(): void {
    if (this.txDepth === 0) this.readsOutsideTx += 1;
  }

  scoutImport = {
    findUnique: async (args: {
      where: { coach_id_intent_id: { coach_id: string; intent_id: string } };
    }) => {
      this.noteRead();
      const { coach_id, intent_id } = args.where.coach_id_intent_id;
      const row = this.imports.find((i) => i.coach_id === coach_id && i.intent_id === intent_id);
      return row ? { terminal_status: row.terminal_status } : null;
    },
  };

  scoutIngestEntity = {
    count: async (args: { where: Where }) => {
      this.noteRead();
      return this.ingest.filter((r) => matchBase(r, args.where)).length;
    },
  };

  scoutReconstructionLedger = {
    groupBy: async (args: { where: Where }) => {
      this.noteRead();
      const rows = this.ledgerRows.filter((r) => matchBase(r, args.where));
      const byStatus = new Map<string, number>();
      for (const r of rows) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
      return Array.from(byStatus.entries()).map(([status, n]) => ({
        status,
        _count: { _all: n },
      }));
    },
    findMany: async (args: { where: Where; take?: number }) => {
      this.noteRead();
      let rows = this.ledgerRows.filter(
        (r) =>
          matchBase(r, args.where) &&
          (args.where.status === undefined || r.status === args.where.status) &&
          (args.where.source_id?.gt === undefined || r.source_id > args.where.source_id.gt),
      );
      rows = rows.sort((a, b) => a.source_id.localeCompare(b.source_id));
      if (args.take !== undefined) rows = rows.slice(0, args.take);
      return rows.map((r) => ({ source_id: r.source_id, target_id: r.target_id }));
    },
  };

  person = {
    findMany: async (args: { where: Where }) => {
      this.noteRead();
      const ids = new Set(args.where.id?.in ?? []);
      return this.persons
        .filter(
          (p) =>
            ids.has(p.id) &&
            (args.where.coach_id === undefined || p.coach_id === args.where.coach_id) &&
            (args.where.state?.not === undefined || p.state !== args.where.state.not),
        )
        .map((p) => ({
          id: p.id,
          state: p.state,
          source_platform: p.source_platform,
          source_person_id: p.source_person_id,
          display_name: p.display_name,
          created_at: p.created_at,
          updated_at: p.updated_at,
        }));
    },
  };
}

function matchBase(
  r: { coach_id: string; intent_id: string; entity_type: string },
  w: Where,
): boolean {
  return (
    (w.coach_id === undefined || r.coach_id === w.coach_id) &&
    (w.intent_id === undefined || r.intent_id === w.intent_id) &&
    (w.entity_type === undefined || r.entity_type === w.entity_type)
  );
}

function makeService(fake: FakePrisma): {
  service: ScoutRosterService;
  capture: jest.Mock;
} {
  const capture = jest.fn();
  const analytics = { capture } as object as AnalyticsService;
  const service = new ScoutRosterService(fake as object as PrismaService, analytics);
  return { service, capture };
}

/** Seed one settled intent with N reconstructed persons + optional skipped/failed. */
function seed(
  fake: FakePrisma,
  opts: {
    coach?: string;
    intent?: string;
    reconstructed?: number;
    skipped?: number;
    failed?: number;
    stagedExtra?: number;
    terminalStatus?: string | null;
  },
): void {
  const coach = opts.coach ?? COACH;
  const intent = opts.intent ?? INTENT;
  fake.imports.push({
    coach_id: coach,
    intent_id: intent,
    id: `imp-${coach}-${intent}`,
    // Settled by default; a test may pass terminalStatus: null for an unsettled intent.
    terminal_status: opts.terminalStatus === undefined ? 'succeeded' : opts.terminalStatus,
  });

  const recN = opts.reconstructed ?? 0;
  const skipN = opts.skipped ?? 0;
  const failN = opts.failed ?? 0;
  let idx = 0;
  const push = (status: string, withPerson: boolean): void => {
    // Zero-padded source_id so lexical asc order is human-obvious (s000, s001...).
    const sid = `s${String(idx).padStart(3, '0')}`;
    idx += 1;
    const targetId = withPerson ? `p-${coach}-${sid}` : null;
    fake.ingest.push({ coach_id: coach, intent_id: intent, entity_type: ET, source_id: sid });
    fake.ledgerRows.push({
      coach_id: coach,
      intent_id: intent,
      entity_type: ET,
      source_id: sid,
      status,
      target_id: targetId,
    });
    if (withPerson && targetId) {
      fake.persons.push({
        id: targetId,
        coach_id: coach,
        source_platform: 'truecoach',
        source_person_id: `tc_${sid}`,
        display_name: `Client ${sid}`,
        state: PersonState.InvitePending,
        created_at: new Date('2026-07-16T00:00:00.000Z'),
        updated_at: new Date('2026-07-16T00:00:00.000Z'),
      });
    }
  };
  for (let i = 0; i < recN; i++) push('reconstructed', true);
  for (let i = 0; i < skipN; i++) push('skipped', false);
  for (let i = 0; i < failN; i++) push('failed', false);
  // Extra staged rows with no ledger row at all (a partial pass): they inflate
  // the authoritative staged count above reconstructed + skipped + failed.
  for (let i = 0; i < (opts.stagedExtra ?? 0); i++) {
    fake.ingest.push({
      coach_id: coach,
      intent_id: intent,
      entity_type: ET,
      source_id: `extra${i}`,
    });
  }
}

describe('ScoutRosterService.getRoster', () => {
  it('404s for an unknown intent (no ScoutImport evidence)', async () => {
    const fake = new FakePrisma();
    const { service } = makeService(fake);
    await expect(service.getRoster(COACH, 'nope', undefined, undefined)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("404s for another tenant's intent — no existence oracle", async () => {
    const fake = new FakePrisma();
    seed(fake, { coach: OTHER, intent: INTENT, reconstructed: 3 });
    const { service } = makeService(fake);
    // Same intent id, wrong caller: indistinguishable from unknown (both 404).
    await expect(service.getRoster(COACH, INTENT, undefined, undefined)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('returns honest ledger-derived accounting', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: 3, skipped: 1, failed: 1 });
    const { service } = makeService(fake);
    const res = await service.getRoster(COACH, INTENT, undefined, undefined);
    expect(res.accounting).toEqual({ staged: 5, reconstructed: 3, skipped: 1, failed: 1 });
    expect(res.accounting.staged).toBe(
      res.accounting.reconstructed + res.accounting.skipped + res.accounting.failed,
    );
  });

  it('exposes a partial pass as staged > reconstructed + skipped + failed', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: 2, skipped: 0, failed: 0, stagedExtra: 3 });
    const { service } = makeService(fake);
    const res = await service.getRoster(COACH, INTENT, undefined, undefined);
    expect(res.accounting.staged).toBe(5);
    expect(res.accounting.reconstructed).toBe(2);
    expect(res.accounting.staged).toBeGreaterThan(
      res.accounting.reconstructed + res.accounting.skipped + res.accounting.failed,
    );
  });

  it('returns only reconstructed persons in the roster list, in deterministic source_id order', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: 3, skipped: 2, failed: 1 });
    const { service } = makeService(fake);
    const res = await service.getRoster(COACH, INTENT, undefined, undefined);
    expect(res.persons).toHaveLength(3);
    expect(res.persons.map((p) => p.source_person_id)).toEqual(['tc_s000', 'tc_s001', 'tc_s002']);
  });

  it('returns an empty roster + zero accounting for a settled-but-unreconstructed intent', async () => {
    const fake = new FakePrisma();
    fake.imports.push({
      coach_id: COACH,
      intent_id: INTENT,
      id: 'imp-1',
      terminal_status: 'succeeded',
    });
    const { service } = makeService(fake);
    const res = await service.getRoster(COACH, INTENT, undefined, undefined);
    expect(res.persons).toEqual([]);
    expect(res.accounting).toEqual({ staged: 0, reconstructed: 0, skipped: 0, failed: 0 });
    expect(res.page).toEqual({
      limit: ROSTER_DEFAULT_PAGE_SIZE,
      next_cursor: null,
      has_more: false,
    });
  });

  it('excludes deleted persons but still counts them in accounting (erasure preserved)', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: 3 });
    // Soft-delete the middle person.
    const target = fake.persons.find((p) => p.source_person_id === 'tc_s001');
    if (target) target.state = PersonState.Deleted;
    const { service } = makeService(fake);
    const res = await service.getRoster(COACH, INTENT, undefined, undefined);
    expect(res.persons.map((p) => p.source_person_id)).toEqual(['tc_s000', 'tc_s002']);
    // Ledger still counts the reconstruction — accounting is honest.
    expect(res.accounting.reconstructed).toBe(3);
  });

  it('paginates deterministically across pages with an opaque cursor', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: 5 });
    const { service } = makeService(fake);

    const page1 = await service.getRoster(COACH, INTENT, undefined, 2);
    expect(page1.persons.map((p) => p.source_person_id)).toEqual(['tc_s000', 'tc_s001']);
    expect(page1.page.has_more).toBe(true);
    expect(page1.page.next_cursor).toBeTruthy();
    // Cursor is opaque (base64url), not the raw source_id.
    expect(page1.page.next_cursor).not.toBe('s001');

    const page2 = await service.getRoster(COACH, INTENT, page1.page.next_cursor ?? undefined, 2);
    expect(page2.persons.map((p) => p.source_person_id)).toEqual(['tc_s002', 'tc_s003']);
    expect(page2.page.has_more).toBe(true);

    const page3 = await service.getRoster(COACH, INTENT, page2.page.next_cursor ?? undefined, 2);
    expect(page3.persons.map((p) => p.source_person_id)).toEqual(['tc_s004']);
    expect(page3.page.has_more).toBe(false);
    expect(page3.page.next_cursor).toBeNull();
  });

  it('does not double-return or skip rows across the full page walk', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: 7 });
    const { service } = makeService(fake);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 100; guard++) {
      const page = await service.getRoster(COACH, INTENT, cursor, 3);
      seen.push(...page.persons.map((p) => p.source_person_id));
      if (!page.page.has_more) break;
      cursor = page.page.next_cursor ?? undefined;
    }
    expect(seen).toEqual([
      'tc_s000',
      'tc_s001',
      'tc_s002',
      'tc_s003',
      'tc_s004',
      'tc_s005',
      'tc_s006',
    ]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('rejects a malformed cursor (fail closed, never a silent full scan)', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: 2 });
    const { service } = makeService(fake);
    await expect(
      service.getRoster(COACH, INTENT, 'not-a-valid-cursor!!!', undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an out-of-range limit at the service boundary', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: 2 });
    const { service } = makeService(fake);
    await expect(
      service.getRoster(COACH, INTENT, undefined, ROSTER_MAX_PAGE_SIZE + 1),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.getRoster(COACH, INTENT, undefined, 0)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('never leaks another tenant persons even if a ledger target_id points cross-tenant', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: 1 });
    // Corrupt: point this coach ledger row at a person owned by OTHER.
    fake.persons.push({
      id: 'p-foreign',
      coach_id: OTHER,
      source_platform: 'truecoach',
      source_person_id: 'tc_foreign',
      display_name: 'Foreign',
      state: PersonState.InvitePending,
      created_at: new Date(),
      updated_at: new Date(),
    });
    fake.ledgerRows.push({
      coach_id: COACH,
      intent_id: INTENT,
      entity_type: ET,
      source_id: 's999',
      status: 'reconstructed',
      target_id: 'p-foreign',
    });
    const { service } = makeService(fake);
    const res = await service.getRoster(COACH, INTENT, undefined, undefined);
    // The coach_id-scoped Person read drops the foreign row entirely.
    expect(res.persons.some((p) => p.source_person_id === 'tc_foreign')).toBe(false);
  });

  it('returns no email or billing fields on a roster row', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: 1 });
    const { service } = makeService(fake);
    const res = await service.getRoster(COACH, INTENT, undefined, undefined);
    const row = res.persons[0];
    expect(Object.keys(row).sort()).toEqual(
      [
        'created_at',
        'display_name',
        'id',
        'source_person_id',
        'source_platform',
        'state',
        'updated_at',
      ].sort(),
    );
    expect(row).not.toHaveProperty('email');
    expect(row).not.toHaveProperty('coach_id');
  });

  it('emits a PII-safe analytics read signal (counts only, no display names)', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: 2 });
    const { service, capture } = makeService(fake);
    await service.getRoster(COACH, INTENT, undefined, undefined);
    expect(capture).toHaveBeenCalledWith(
      COACH,
      Events.SCOUT_RECONSTRUCT_ROSTER_READ,
      expect.objectContaining({ intent_id: INTENT, returned: 2, has_more: false }),
    );
    const props = capture.mock.calls[0][2] as Record<string, unknown>;
    expect(JSON.stringify(props)).not.toContain('Client ');
  });

  it('holds accounting + pagination at 100x the default page size', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: ROSTER_DEFAULT_PAGE_SIZE * 100 });
    const { service } = makeService(fake);
    const res = await service.getRoster(COACH, INTENT, undefined, ROSTER_MAX_PAGE_SIZE);
    expect(res.accounting.reconstructed).toBe(ROSTER_DEFAULT_PAGE_SIZE * 100);
    expect(res.persons).toHaveLength(ROSTER_MAX_PAGE_SIZE);
    expect(res.page.has_more).toBe(true);
  });

  describe('settled-intent gate (terminal_status must be non-null)', () => {
    it('404s for an intent that exists for the coach but has NOT settled', async () => {
      const fake = new FakePrisma();
      // A ScoutImport row owned by the caller, reconstructed rows present, but the
      // crawl has not settled (terminal_status === null): reading it now would
      // expose a partial, still-arriving roster.
      seed(fake, { reconstructed: 3, terminalStatus: null });
      const { service } = makeService(fake);
      await expect(service.getRoster(COACH, INTENT, undefined, undefined)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('is indistinguishable from an unknown intent — same uniform 404, no settle oracle', async () => {
      const unsettled = new FakePrisma();
      seed(unsettled, { reconstructed: 2, terminalStatus: null });
      const unknown = new FakePrisma();
      const svcUnsettled = makeService(unsettled).service;
      const svcUnknown = makeService(unknown).service;

      const errUnsettled = await svcUnsettled
        .getRoster(COACH, INTENT, undefined, undefined)
        .catch((e: unknown) => e);
      const errUnknown = await svcUnknown
        .getRoster(COACH, INTENT, undefined, undefined)
        .catch((e: unknown) => e);

      expect(errUnsettled).toBeInstanceOf(NotFoundException);
      expect(errUnknown).toBeInstanceOf(NotFoundException);
      // Same status AND same message: the response cannot betray whether the
      // intent exists-but-unsettled versus does-not-exist.
      expect((errUnsettled as NotFoundException).getResponse()).toEqual(
        (errUnknown as NotFoundException).getResponse(),
      );
    });

    it('reads a settled intent (non-null terminal_status) normally', async () => {
      const fake = new FakePrisma();
      seed(fake, { reconstructed: 2, terminalStatus: 'failed' }); // any non-null terminal is settled
      const { service } = makeService(fake);
      const res = await service.getRoster(COACH, INTENT, undefined, undefined);
      expect(res.persons).toHaveLength(2);
    });
  });

  describe('single consistent snapshot (one RepeatableRead transaction)', () => {
    it('runs every read inside ONE RepeatableRead $transaction', async () => {
      const fake = new FakePrisma();
      seed(fake, { reconstructed: 3, skipped: 1, failed: 1 });
      const { service } = makeService(fake);

      await service.getRoster(COACH, INTENT, undefined, undefined);

      // Exactly one interactive transaction, opened at RepeatableRead.
      expect(fake.transactionCalls).toEqual([{ isolationLevel: 'RepeatableRead' }]);
      // The gate, the count, the groupBy, the ledger page, AND the person
      // materialize all executed inside that transaction — nothing leaked out
      // into a separate database moment.
      expect(fake.readsOutsideTx).toBe(0);
    });

    it('reads the gate inside the snapshot too (unsettled 404 still opens exactly one txn)', async () => {
      const fake = new FakePrisma();
      seed(fake, { reconstructed: 1, terminalStatus: null });
      const { service } = makeService(fake);
      await expect(service.getRoster(COACH, INTENT, undefined, undefined)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(fake.transactionCalls).toHaveLength(1);
      expect(fake.readsOutsideTx).toBe(0);
    });
  });
});
