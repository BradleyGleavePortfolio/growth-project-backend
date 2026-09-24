import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AnalyticsService } from '../../../src/analytics/analytics.service';
import { Events } from '../../../src/analytics/events';
import { PrismaService } from '../../../src/prisma.service';
import { ScoutEntitiesService } from '../../../src/scout/scout-entities.service';
import {
  ENTITIES_DEFAULT_PAGE_SIZE,
  ENTITIES_MAX_PAGE_SIZE,
  ENTITY_REVIEW_FAMILIES,
} from '../../../src/scout/scout-entities.dto';
import { RECONSTRUCT_FAMILY } from '../../../src/scout/scout-reconstruct.dto';
import { decodeScoutCursor } from '../../../src/scout/scout-cursor';

/**
 * ScoutEntitiesService unit tests (IMPORTER-I).
 *
 * The Prisma dependency is a small in-memory fake with REAL findMany semantics
 * (same unique tuples and source_id ordering as the schema), so coach-scoping,
 * family isolation, deterministic pagination, context-bound cursor
 * round-tripping, and cascade-erasure exclusion are proven by BEHAVIOUR — not by
 * a mock that hands back a pre-decided page.
 */

const COACH = 'coach-1';
const OTHER = 'coach-2';
const INTENT = 'intent-1';
const FAM = RECONSTRUCT_FAMILY.workouts;

interface LedgerRow {
  coach_id: string;
  intent_id: string;
  entity_type: string;
  source_id: string;
  source_platform: string;
  status: string;
  target_id: string | null;
}
interface EntityRow {
  id: string;
  coach_id: string;
  source_platform: string;
  entity_type: string;
  source_id: string;
  client_source_id: string | null;
  label: string | null;
  created_at: Date;
  updated_at: Date;
}

interface Where {
  coach_id?: string;
  intent_id?: string;
  entity_type?: string;
  status?: string;
  source_id?: string | { gt?: string };
  source_platform?: { gt?: string };
  OR?: Where[];
  id?: { in?: string[] };
}

class FakePrisma {
  imports: Array<{
    coach_id: string;
    intent_id: string;
    id: string;
    terminal_status: string | null;
  }> = [];
  ledgerRows: LedgerRow[] = [];
  entities: EntityRow[] = [];

  transactionCalls: Array<{ isolationLevel?: string }> = [];
  private txDepth = 0;
  readsOutsideTx = 0;
  /** Every ledger findMany, in order, so tests can prove what was (not) read. */
  ledgerReads: Array<{ where: Where; take?: number; orderBy?: unknown }> = [];

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

  scoutReconstructionLedger = {
    findMany: async (args: { where: Where; take?: number; orderBy?: unknown }) => {
      this.noteRead();
      this.ledgerReads.push(args);
      // Real (source_id, source_platform) order and predicate semantics: the
      // fake mirrors the schema's wide identity so tie-break paging is proven
      // by behaviour (PG remains the authority; see the NQ1 real-PG proof).
      let rows = this.ledgerRows.filter((r) => matchLedger(r, args.where)).sort(byIdentity);
      if (args.take !== undefined) rows = rows.slice(0, args.take);
      return rows.map((r) => ({
        source_id: r.source_id,
        source_platform: r.source_platform,
        target_id: r.target_id,
      }));
    },
  };

  scoutReconstructedEntity = {
    findMany: async (args: { where: Where }) => {
      this.noteRead();
      const ids = new Set(args.where.id?.in ?? []);
      return this.entities
        .filter(
          (e) =>
            ids.has(e.id) &&
            (args.where.coach_id === undefined || e.coach_id === args.where.coach_id) &&
            (args.where.entity_type === undefined || e.entity_type === args.where.entity_type),
        )
        .map((e) => ({
          id: e.id,
          source_platform: e.source_platform,
          entity_type: e.entity_type,
          source_id: e.source_id,
          client_source_id: e.client_source_id,
          label: e.label,
          created_at: e.created_at,
          updated_at: e.updated_at,
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

function matchLedger(r: LedgerRow, w: Where): boolean {
  if (!matchBase(r, w)) return false;
  if (w.status !== undefined && r.status !== w.status) return false;
  if (typeof w.source_id === 'string' && r.source_id !== w.source_id) return false;
  if (
    typeof w.source_id === 'object' &&
    w.source_id.gt !== undefined &&
    !(r.source_id > w.source_id.gt)
  )
    return false;
  if (w.source_platform?.gt !== undefined && !(r.source_platform > w.source_platform.gt))
    return false;
  if (w.OR !== undefined && !w.OR.some((o) => matchLedger(r, o))) return false;
  return true;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byIdentity = (a: LedgerRow, b: LedgerRow): number =>
  cmp(a.source_id, b.source_id) || cmp(a.source_platform, b.source_platform);

const b64 = (v: string): string => Buffer.from(v, 'utf8').toString('base64url');
/** The exact scoped v2 token Q1 must emit for an entity-family boundary. */
function expectedV2(coach: string, intent: string, f: string, s: string, p: string): string {
  const o = 'source_id:asc,source_platform:asc';
  return `v2.${b64(JSON.stringify({ v: 2, c: coach, i: intent, f, o, s, p }))}`;
}
/** The legacy scope-bound token Q0 emitted for an entity-family boundary. */
function legacyEntities(coach: string, intent: string, f: string, s: string): string {
  return b64(JSON.stringify({ c: coach, i: intent, f, o: 'source_id:asc', s }));
}

// Wire the service through the Nest DI container: `useValue` is typed to accept
// any provider value, so the in-memory FakePrisma and the capture-only analytics
// stub are injected WITHOUT any cast — no widening assertion is used to launder
// the structural mismatch between the fake and the real providers.
async function makeService(fake: FakePrisma): Promise<{
  service: ScoutEntitiesService;
  capture: jest.Mock;
}> {
  const capture = jest.fn();
  const moduleRef = await Test.createTestingModule({
    providers: [
      ScoutEntitiesService,
      { provide: PrismaService, useValue: fake },
      { provide: AnalyticsService, useValue: { capture } },
    ],
  }).compile();
  return { service: moduleRef.get(ScoutEntitiesService), capture };
}

/** Seed one settled intent with N reconstructed entities of a family. */
function seed(
  fake: FakePrisma,
  opts: {
    coach?: string;
    intent?: string;
    family?: string;
    reconstructed?: number;
    sourcePlatform?: string;
    terminalStatus?: string | null;
  },
): void {
  const coach = opts.coach ?? COACH;
  const intent = opts.intent ?? INTENT;
  const family = opts.family ?? FAM;
  const platform = opts.sourcePlatform ?? 'truecoach';
  if (!fake.imports.some((i) => i.coach_id === coach && i.intent_id === intent)) {
    fake.imports.push({
      coach_id: coach,
      intent_id: intent,
      id: `imp-${coach}-${intent}`,
      terminal_status: opts.terminalStatus === undefined ? 'succeeded' : opts.terminalStatus,
    });
  }
  const recN = opts.reconstructed ?? 0;
  for (let i = 0; i < recN; i++) {
    const sid = `s${String(i).padStart(3, '0')}`;
    const targetId = `e-${coach}-${family}-${sid}`;
    fake.ledgerRows.push({
      coach_id: coach,
      intent_id: intent,
      entity_type: family,
      source_id: sid,
      source_platform: platform,
      status: 'reconstructed',
      target_id: targetId,
    });
    fake.entities.push({
      id: targetId,
      coach_id: coach,
      source_platform: platform,
      entity_type: family,
      source_id: `${platform}_${sid}`,
      client_source_id: `${platform}_client_${i % 3}`,
      label: `Item ${sid}`,
      created_at: new Date('2026-07-18T00:00:00.000Z'),
      updated_at: new Date('2026-07-18T00:00:00.000Z'),
    });
  }
}

describe('ScoutEntitiesService.getEntities', () => {
  it('404s for an unknown intent (no ScoutImport evidence)', async () => {
    const fake = new FakePrisma();
    const { service } = await makeService(fake);
    await expect(
      service.getEntities(COACH, 'nope', FAM, undefined, undefined),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("404s for another tenant's intent — no existence oracle", async () => {
    const fake = new FakePrisma();
    seed(fake, { coach: OTHER, intent: INTENT, reconstructed: 3 });
    const { service } = await makeService(fake);
    await expect(
      service.getEntities(COACH, INTENT, FAM, undefined, undefined),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects an unsupported family at the service boundary (fail closed)', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: 1 });
    const { service } = await makeService(fake);
    // The person family is served by the roster read, never this endpoint.
    await expect(
      service.getEntities(COACH, INTENT, RECONSTRUCT_FAMILY.clients, undefined, undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
    // An entirely unregistered family is likewise a 400.
    await expect(
      service.getEntities(COACH, INTENT, 'billing', undefined, undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns reconstructed entities in deterministic source_id order', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: 3 });
    const { service } = await makeService(fake);
    const res = await service.getEntities(COACH, INTENT, FAM, undefined, undefined);
    expect(res.entities).toHaveLength(3);
    expect(res.entities.map((e) => e.source_id)).toEqual([
      'truecoach_s000',
      'truecoach_s001',
      'truecoach_s002',
    ]);
    expect(res.family).toBe(FAM);
    expect(res.intent_id).toBe(INTENT);
  });

  it('reports page_count as the size of THIS page — never a full-collection total', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: 5 });
    const { service } = await makeService(fake);
    const page1 = await service.getEntities(COACH, INTENT, FAM, undefined, 2);
    expect(page1.entities).toHaveLength(2);
    expect(page1.page_count).toBe(2);
    // page_count is the visible page, NOT the 5 reconstructed rows.
    expect(page1.page_count).not.toBe(5);
  });

  it('returns an empty page for a settled-but-unreconstructed intent+family', async () => {
    const fake = new FakePrisma();
    fake.imports.push({
      coach_id: COACH,
      intent_id: INTENT,
      id: 'imp-1',
      terminal_status: 'succeeded',
    });
    const { service } = await makeService(fake);
    const res = await service.getEntities(COACH, INTENT, FAM, undefined, undefined);
    expect(res.entities).toEqual([]);
    expect(res.page_count).toBe(0);
    expect(res.next_cursor).toBeNull();
  });

  it('drops a cascade-erased entity from the page (erasure by absence, no Deleted state)', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: 3 });
    // Cascade-erase the middle entity: the ledger row remains, the canonical row
    // is gone. It must simply not appear — there is no Deleted flag to leak.
    fake.entities = fake.entities.filter((e) => e.source_id !== 'truecoach_s001');
    const { service } = await makeService(fake);
    const res = await service.getEntities(COACH, INTENT, FAM, undefined, undefined);
    expect(res.entities.map((e) => e.source_id)).toEqual(['truecoach_s000', 'truecoach_s002']);
    expect(res.page_count).toBe(2);
  });

  it('paginates deterministically across pages with a context-bound opaque cursor', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: 5 });
    const { service } = await makeService(fake);

    const page1 = await service.getEntities(COACH, INTENT, FAM, undefined, 2);
    expect(page1.entities.map((e) => e.source_id)).toEqual(['truecoach_s000', 'truecoach_s001']);
    expect(page1.next_cursor).toBeTruthy();
    // Cursor is opaque (base64url of a bound payload), not the raw source_id.
    expect(page1.next_cursor).not.toBe('s001');
    // Q1: the exact scoped v2 token of the last LEDGER row; first page ordered
    // by (source_id, source_platform) like every later page.
    expect(page1.next_cursor).toBe(expectedV2(COACH, INTENT, FAM, 's001', 'truecoach'));
    expect(fake.ledgerReads[0].orderBy).toEqual([{ source_id: 'asc' }, { source_platform: 'asc' }]);

    const page2 = await service.getEntities(COACH, INTENT, FAM, page1.next_cursor ?? undefined, 2);
    expect(page2.entities.map((e) => e.source_id)).toEqual(['truecoach_s002', 'truecoach_s003']);

    const page3 = await service.getEntities(COACH, INTENT, FAM, page2.next_cursor ?? undefined, 2);
    expect(page3.entities.map((e) => e.source_id)).toEqual(['truecoach_s004']);
    expect(page3.next_cursor).toBeNull();
  });

  it('does not double-return or skip rows across the full page walk', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: 7 });
    const { service } = await makeService(fake);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 100; guard++) {
      const page = await service.getEntities(COACH, INTENT, FAM, cursor, 3);
      seen.push(...page.entities.map((e) => e.source_id));
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  describe('Q1 cursor emission and legacy-boundary resolution', () => {
    it('emits scoped v2 on every non-final page, each accepted back by the decoder', async () => {
      const fake = new FakePrisma();
      seed(fake, { reconstructed: 5 });
      const { service } = await makeService(fake);
      let cursor: string | undefined;
      const emitted: string[] = [];
      for (let guard = 0; guard < 10; guard++) {
        const page = await service.getEntities(COACH, INTENT, FAM, cursor, 2);
        if (!page.next_cursor) break;
        emitted.push(page.next_cursor);
        expect(decodeScoutCursor(page.next_cursor, COACH, INTENT, FAM)).toEqual({
          s: page.entities[page.entities.length - 1].source_id.replace('truecoach_', ''),
          p: 'truecoach',
        });
        cursor = page.next_cursor;
      }
      expect(emitted).toEqual([
        expectedV2(COACH, INTENT, FAM, 's001', 'truecoach'),
        expectedV2(COACH, INTENT, FAM, 's003', 'truecoach'),
      ]);
    });

    it('resolves a Q0-emitted legacy entities token to the same next page as its v2 twin', async () => {
      const fake = new FakePrisma();
      seed(fake, { reconstructed: 5 });
      const { service } = await makeService(fake);
      const page1 = await service.getEntities(COACH, INTENT, FAM, undefined, 2);
      const viaV2 = await service.getEntities(
        COACH,
        INTENT,
        FAM,
        page1.next_cursor ?? undefined,
        2,
      );
      const viaLegacy = await service.getEntities(
        COACH,
        INTENT,
        FAM,
        legacyEntities(COACH, INTENT, FAM, 's001'),
        2,
      );
      expect(viaLegacy).toEqual(viaV2);
      expect(viaLegacy.entities.map((e) => e.source_id)).toEqual([
        'truecoach_s002',
        'truecoach_s003',
      ]);
      const reads = fake.ledgerReads.slice(-2);
      expect(reads[0]).toEqual({
        where: {
          coach_id: COACH,
          intent_id: INTENT,
          entity_type: FAM,
          status: 'reconstructed',
          source_id: 's001',
        },
        select: { source_platform: true },
        take: 2,
      });
      expect(reads[1].where.OR).toEqual([
        { source_id: { gt: 's001' } },
        { source_id: 's001', source_platform: { gt: 'truecoach' } },
      ]);
      expect(fake.readsOutsideTx).toBe(0);
    });

    it('400s an unresolvable legacy token (absent source) with no page read', async () => {
      const fake = new FakePrisma();
      seed(fake, { reconstructed: 3 });
      const { service } = await makeService(fake);
      const before = fake.ledgerReads.length;
      const err = await service
        .getEntities(COACH, INTENT, FAM, legacyEntities(COACH, INTENT, FAM, 'zzz-absent'), 2)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).message).toBe('malformed cursor');
      expect(fake.ledgerReads.length - before).toBe(1);
      expect(fake.ledgerReads[before].take).toBe(2);
    });

    it('resolves within the token family only: a row of another family is not a boundary', async () => {
      const fake = new FakePrisma();
      seed(fake, { reconstructed: 3 });
      seed(fake, { family: RECONSTRUCT_FAMILY.client_history, reconstructed: 0 });
      const { service } = await makeService(fake);
      // s001 is reconstructed for `workouts` only; a client_history legacy
      // token naming it is scope-bound to client_history and finds nothing.
      await expect(
        service.getEntities(
          COACH,
          INTENT,
          RECONSTRUCT_FAMILY.client_history,
          legacyEntities(COACH, INTENT, RECONSTRUCT_FAMILY.client_history, 's001'),
          2,
        ),
      ).rejects.toThrow('malformed cursor');
    });

    it('enumerates identity ties exactly once and refuses a tied legacy boundary', async () => {
      const fake = new FakePrisma();
      seed(fake, { reconstructed: 2 });
      // Future-schema fixture: one source_id reconstructed from three platforms.
      for (const p of ['c-plat', 'a-plat', 'b-plat']) {
        const id = `e-${p}`;
        fake.ledgerRows.push({
          coach_id: COACH,
          intent_id: INTENT,
          entity_type: FAM,
          source_id: 's000',
          source_platform: p,
          status: 'reconstructed',
          target_id: id,
        });
        fake.entities.push({
          id,
          coach_id: COACH,
          source_platform: p,
          entity_type: FAM,
          source_id: `${p}_s000`,
          client_source_id: null,
          label: null,
          created_at: new Date(0),
          updated_at: new Date(0),
        });
      }
      const { service } = await makeService(fake);
      const seen: string[] = [];
      const tokens: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 20; guard++) {
        const page = await service.getEntities(COACH, INTENT, FAM, cursor, 1);
        seen.push(...page.entities.map((e) => e.source_id));
        if (!page.next_cursor) break;
        tokens.push(page.next_cursor);
        cursor = page.next_cursor;
      }
      expect(seen).toEqual([
        'a-plat_s000',
        'b-plat_s000',
        'c-plat_s000',
        'truecoach_s000',
        'truecoach_s001',
      ]);
      expect(tokens).toEqual([
        expectedV2(COACH, INTENT, FAM, 's000', 'a-plat'),
        expectedV2(COACH, INTENT, FAM, 's000', 'b-plat'),
        expectedV2(COACH, INTENT, FAM, 's000', 'c-plat'),
        expectedV2(COACH, INTENT, FAM, 's000', 'truecoach'),
      ]);
      await expect(
        service.getEntities(COACH, INTENT, FAM, legacyEntities(COACH, INTENT, FAM, 's000'), 1),
      ).rejects.toThrow('malformed cursor');
    });
  });

  it('rejects a malformed cursor (fail closed, never a silent full scan)', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: 2 });
    const { service } = await makeService(fake);
    await expect(
      service.getEntities(COACH, INTENT, FAM, 'not-a-valid-cursor!!!', undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a cursor minted for a DIFFERENT intent (binding is checked)', async () => {
    const fake = new FakePrisma();
    seed(fake, { intent: INTENT, reconstructed: 3 });
    seed(fake, { intent: 'intent-2', reconstructed: 3 });
    const { service } = await makeService(fake);
    const page1 = await service.getEntities(COACH, INTENT, FAM, undefined, 2);
    const cursor = page1.next_cursor ?? undefined;
    // Replaying INTENT's cursor against intent-2 must fail closed, not leak a page.
    await expect(service.getEntities(COACH, 'intent-2', FAM, cursor, 2)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a cursor minted for a DIFFERENT family (binding is checked)', async () => {
    const fake = new FakePrisma();
    seed(fake, { family: RECONSTRUCT_FAMILY.workouts, reconstructed: 3 });
    seed(fake, { family: RECONSTRUCT_FAMILY.client_history, reconstructed: 3 });
    const { service } = await makeService(fake);
    const page1 = await service.getEntities(
      COACH,
      INTENT,
      RECONSTRUCT_FAMILY.workouts,
      undefined,
      2,
    );
    const cursor = page1.next_cursor ?? undefined;
    await expect(
      service.getEntities(COACH, INTENT, RECONSTRUCT_FAMILY.client_history, cursor, 2),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a cursor minted for a DIFFERENT coach (binding is checked)', async () => {
    const fake = new FakePrisma();
    seed(fake, { coach: COACH, reconstructed: 3 });
    seed(fake, { coach: OTHER, reconstructed: 3 });
    const { service } = await makeService(fake);
    const page1 = await service.getEntities(COACH, INTENT, FAM, undefined, 2);
    const cursor = page1.next_cursor ?? undefined;
    // OTHER replaying COACH's cursor: fail closed (the settled gate would also
    // 404, but the binding check trips first and uniformly).
    await expect(service.getEntities(OTHER, INTENT, FAM, cursor, 2)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects an out-of-range limit at the service boundary', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: 2 });
    const { service } = await makeService(fake);
    await expect(
      service.getEntities(COACH, INTENT, FAM, undefined, ENTITIES_MAX_PAGE_SIZE + 1),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.getEntities(COACH, INTENT, FAM, undefined, 0)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('never leaks another tenant entity even if a ledger target_id points cross-tenant', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: 1 });
    fake.entities.push({
      id: 'e-foreign',
      coach_id: OTHER,
      source_platform: 'truecoach',
      entity_type: FAM,
      source_id: 'truecoach_foreign',
      client_source_id: null,
      label: 'Foreign',
      created_at: new Date(),
      updated_at: new Date(),
    });
    fake.ledgerRows.push({
      coach_id: COACH,
      intent_id: INTENT,
      entity_type: FAM,
      source_id: 's999',
      source_platform: 'truecoach',
      status: 'reconstructed',
      target_id: 'e-foreign',
    });
    const { service } = await makeService(fake);
    const res = await service.getEntities(COACH, INTENT, FAM, undefined, undefined);
    expect(res.entities.some((e) => e.source_id === 'truecoach_foreign')).toBe(false);
  });

  it('never leaks a different family even if a ledger target_id points cross-family', async () => {
    const fake = new FakePrisma();
    seed(fake, { family: RECONSTRUCT_FAMILY.workouts, reconstructed: 1 });
    // A client_history entity, wrongly referenced by a workouts ledger row.
    fake.entities.push({
      id: 'e-crossfam',
      coach_id: COACH,
      source_platform: 'truecoach',
      entity_type: RECONSTRUCT_FAMILY.client_history,
      source_id: 'truecoach_crossfam',
      client_source_id: null,
      label: 'Cross-family',
      created_at: new Date(),
      updated_at: new Date(),
    });
    fake.ledgerRows.push({
      coach_id: COACH,
      intent_id: INTENT,
      entity_type: RECONSTRUCT_FAMILY.workouts,
      source_id: 's999',
      source_platform: 'truecoach',
      status: 'reconstructed',
      target_id: 'e-crossfam',
    });
    const { service } = await makeService(fake);
    const res = await service.getEntities(
      COACH,
      INTENT,
      RECONSTRUCT_FAMILY.workouts,
      undefined,
      undefined,
    );
    // The entity_type-scoped read drops the mismatched-family row.
    expect(res.entities.some((e) => e.source_id === 'truecoach_crossfam')).toBe(false);
  });

  it('only returns reconstructed rows — skipped/failed ledger rows never surface', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: 2 });
    // A skipped and a failed ledger row (no canonical entity) for the same intent.
    fake.ledgerRows.push(
      {
        coach_id: COACH,
        intent_id: INTENT,
        entity_type: FAM,
        source_id: 'z-skip',
        source_platform: 'truecoach',
        status: 'skipped',
        target_id: null,
      },
      {
        coach_id: COACH,
        intent_id: INTENT,
        entity_type: FAM,
        source_id: 'z-fail',
        source_platform: 'truecoach',
        status: 'failed',
        target_id: null,
      },
    );
    const { service } = await makeService(fake);
    const res = await service.getEntities(COACH, INTENT, FAM, undefined, undefined);
    expect(res.entities.map((e) => e.source_id)).toEqual(['truecoach_s000', 'truecoach_s001']);
  });

  it('returns no email or billing fields on an entity row', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: 1 });
    const { service } = await makeService(fake);
    const res = await service.getEntities(COACH, INTENT, FAM, undefined, undefined);
    const row = res.entities[0];
    expect(Object.keys(row).sort()).toEqual(
      [
        'client_source_id',
        'created_at',
        'entity_type',
        'id',
        'label',
        'source_id',
        'source_platform',
        'updated_at',
      ].sort(),
    );
    expect(row).not.toHaveProperty('email');
    expect(row).not.toHaveProperty('coach_id');
    expect(row).not.toHaveProperty('price');
  });

  it('is site-agnostic: projects a non-TrueCoach source platform identically', async () => {
    const fake = new FakePrisma();
    // A structurally-different second adapter shape — canonical rows are read
    // agnostic of which platform produced them (no adapter-specific read core).
    seed(fake, { reconstructed: 2, sourcePlatform: 'trainerize' });
    const { service } = await makeService(fake);
    const res = await service.getEntities(COACH, INTENT, FAM, undefined, undefined);
    expect(res.entities).toHaveLength(2);
    expect(res.entities.every((e) => e.source_platform === 'trainerize')).toBe(true);
    expect(res.entities.map((e) => e.source_id)).toEqual(['trainerize_s000', 'trainerize_s001']);
  });

  it('emits a PII-safe analytics read signal (counts only, no labels)', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: 2 });
    const { service, capture } = await makeService(fake);
    await service.getEntities(COACH, INTENT, FAM, undefined, undefined);
    expect(capture).toHaveBeenCalledWith(
      COACH,
      Events.SCOUT_RECONSTRUCT_ENTITIES_READ,
      expect.objectContaining({
        intent_id: INTENT,
        entity_type: FAM,
        returned: 2,
        has_more: false,
      }),
    );
    const props = capture.mock.calls[0][2] as Record<string, unknown>;
    expect(JSON.stringify(props)).not.toContain('Item ');
  });

  it('holds pagination at 100x the default page size', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: ENTITIES_DEFAULT_PAGE_SIZE * 100 });
    const { service } = await makeService(fake);
    const res = await service.getEntities(COACH, INTENT, FAM, undefined, ENTITIES_MAX_PAGE_SIZE);
    expect(res.entities).toHaveLength(ENTITIES_MAX_PAGE_SIZE);
    expect(res.page_count).toBe(ENTITIES_MAX_PAGE_SIZE);
    expect(res.next_cursor).toBeTruthy();
  });

  it('every reviewable family is a non-person family (clients excluded)', () => {
    expect(ENTITY_REVIEW_FAMILIES).not.toContain(RECONSTRUCT_FAMILY.clients);
    expect(ENTITY_REVIEW_FAMILIES).toEqual(
      expect.arrayContaining([RECONSTRUCT_FAMILY.workouts, RECONSTRUCT_FAMILY.client_history]),
    );
  });

  describe('settled-intent gate (terminal_status must be non-null)', () => {
    it('404s for an intent that exists for the coach but has NOT settled', async () => {
      const fake = new FakePrisma();
      seed(fake, { reconstructed: 3, terminalStatus: null });
      const { service } = await makeService(fake);
      await expect(
        service.getEntities(COACH, INTENT, FAM, undefined, undefined),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is indistinguishable from an unknown intent — same uniform 404, no settle oracle', async () => {
      const unsettled = new FakePrisma();
      seed(unsettled, { reconstructed: 2, terminalStatus: null });
      const unknown = new FakePrisma();
      const svcUnsettled = (await makeService(unsettled)).service;
      const svcUnknown = (await makeService(unknown)).service;

      const errUnsettled = await svcUnsettled
        .getEntities(COACH, INTENT, FAM, undefined, undefined)
        .catch((e: unknown) => e);
      const errUnknown = await svcUnknown
        .getEntities(COACH, INTENT, FAM, undefined, undefined)
        .catch((e: unknown) => e);

      expect(errUnsettled).toBeInstanceOf(NotFoundException);
      expect(errUnknown).toBeInstanceOf(NotFoundException);
      expect((errUnsettled as NotFoundException).getResponse()).toEqual(
        (errUnknown as NotFoundException).getResponse(),
      );
    });

    it('reads a settled intent (any non-null terminal_status) normally', async () => {
      const fake = new FakePrisma();
      seed(fake, { reconstructed: 2, terminalStatus: 'failed' });
      const { service } = await makeService(fake);
      const res = await service.getEntities(COACH, INTENT, FAM, undefined, undefined);
      expect(res.entities).toHaveLength(2);
    });
  });

  describe('replay / idempotency (read-only, no state mutation)', () => {
    it('returns the identical page for the same request replayed twice', async () => {
      const fake = new FakePrisma();
      seed(fake, { reconstructed: 5 });
      const { service } = await makeService(fake);
      const first = await service.getEntities(COACH, INTENT, FAM, undefined, 3);
      const second = await service.getEntities(COACH, INTENT, FAM, undefined, 3);
      // A read is idempotent: same rows, same page_count, same opaque cursor.
      expect(second).toEqual(first);
    });

    it('replaying a next_cursor is deterministic — same second page every time', async () => {
      const fake = new FakePrisma();
      seed(fake, { reconstructed: 5 });
      const { service } = await makeService(fake);
      const page1 = await service.getEntities(COACH, INTENT, FAM, undefined, 2);
      const cursor = page1.next_cursor ?? undefined;
      const replayA = await service.getEntities(COACH, INTENT, FAM, cursor, 2);
      const replayB = await service.getEntities(COACH, INTENT, FAM, cursor, 2);
      expect(replayB).toEqual(replayA);
      expect(replayA.entities.map((e) => e.source_id)).toEqual([
        'truecoach_s002',
        'truecoach_s003',
      ]);
    });

    it('mutates no seed state across repeated reads (row set is stable)', async () => {
      const fake = new FakePrisma();
      seed(fake, { reconstructed: 4 });
      const { service } = await makeService(fake);
      const before = fake.entities.length;
      await service.getEntities(COACH, INTENT, FAM, undefined, undefined);
      await service.getEntities(COACH, INTENT, FAM, undefined, undefined);
      expect(fake.entities.length).toBe(before);
    });
  });

  describe('single consistent snapshot (one RepeatableRead transaction)', () => {
    it('runs every read inside ONE RepeatableRead $transaction', async () => {
      const fake = new FakePrisma();
      seed(fake, { reconstructed: 3 });
      const { service } = await makeService(fake);
      await service.getEntities(COACH, INTENT, FAM, undefined, undefined);
      expect(fake.transactionCalls).toEqual([{ isolationLevel: 'RepeatableRead' }]);
      expect(fake.readsOutsideTx).toBe(0);
    });

    it('reads the gate inside the snapshot too (unsettled 404 still opens exactly one txn)', async () => {
      const fake = new FakePrisma();
      seed(fake, { reconstructed: 1, terminalStatus: null });
      const { service } = await makeService(fake);
      await expect(
        service.getEntities(COACH, INTENT, FAM, undefined, undefined),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fake.transactionCalls).toHaveLength(1);
      expect(fake.readsOutsideTx).toBe(0);
    });

    it('a rejected family never opens a transaction (fails before any read)', async () => {
      const fake = new FakePrisma();
      seed(fake, { reconstructed: 1 });
      const { service } = await makeService(fake);
      await expect(
        service.getEntities(COACH, INTENT, RECONSTRUCT_FAMILY.clients, undefined, undefined),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fake.transactionCalls).toHaveLength(0);
      expect(fake.readsOutsideTx).toBe(0);
    });
  });
});
