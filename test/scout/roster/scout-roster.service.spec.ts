import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PersonState } from '@prisma/client';
import { AnalyticsService } from '../../../src/analytics/analytics.service';
import { Events } from '../../../src/analytics/events';
import { PrismaService } from '../../../src/prisma.service';
import { ScoutRosterService } from '../../../src/scout/scout-roster.service';
import {
  ROSTER_BRIDGE_PENDING,
  ROSTER_DEFAULT_PAGE_SIZE,
  ROSTER_MAX_PAGE_SIZE,
  ROSTER_TARGET_KIND,
} from '../../../src/scout/scout-roster.dto';
import { RECONSTRUCT_ENTITY_TYPE } from '../../../src/scout/scout-reconstruct.dto';
import { decodeScoutCursor } from '../../../src/scout/scout-cursor';
import { buildSourceMapperRegistry } from '../../../src/scout/reconstruct/source-mapper-registry';

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
  source_platform: string;
}
interface LedgerRow {
  coach_id: string;
  intent_id: string;
  entity_type: string;
  source_id: string;
  source_platform: string;
  status: string;
  target_id: string | null;
  /** S8-F: the ledger's nullable kind. Omitted (legacy) reads back as NULL. */
  target_kind?: string | null;
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
  entity_type?: string | { gt?: string };
  status?: string;
  source_id?: string | { gt?: string };
  source_platform?: string | { gt?: string };
  OR?: Where[];
  AND?: Where[];
  id?: { in?: string[] };
  state?: { not?: PersonState };
}
/** A `groupBy` aggregate row, keyed by the requested `by` columns. */
type GroupRow = { [column: string]: unknown; _count: { _all: number } };

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
  /** Every ledger findMany, in order, so tests can prove what was (not) read. */
  ledgerReads: Array<{ where: Where; take?: number; orderBy?: unknown; select?: unknown }> = [];
  /** Every aggregate (groupBy / count), in order, so boundedness is proven by behaviour. */
  groupReads: Array<{ table: string; by?: string[]; where: Where }> = [];

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
      this.groupReads.push({ table: 'ingest', where: args.where });
      return this.ingest.filter((r) => matchBase(r, args.where)).length;
    },
    groupBy: async (args: { by: string[]; where: Where }) => {
      this.noteRead();
      this.groupReads.push({ table: 'ingest', by: args.by, where: args.where });
      return groupRows(
        this.ingest.filter((r) => matchBase(r, args.where)),
        args.by,
      );
    },
  };

  scoutReconstructionLedger = {
    groupBy: async (args: { by: string[]; where: Where }) => {
      this.noteRead();
      this.groupReads.push({ table: 'ledger', by: args.by, where: args.where });
      return groupRows(
        this.ledgerRows.filter((r) => matchLedger(r, args.where)),
        args.by,
      );
    },
    findMany: async (args: {
      where: Where;
      take?: number;
      orderBy?: unknown;
      select?: unknown;
    }) => {
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
        entity_type: r.entity_type,
        target_id: r.target_id,
        target_kind: r.target_kind ?? null,
      }));
    },
  };

  /** Every Person findMany, so tests can prove which target ids were (not) looked up. */
  personReads: Array<{ ids: string[] }> = [];

  person = {
    findMany: async (args: { where: Where }) => {
      this.noteRead();
      const ids = new Set(args.where.id?.in ?? []);
      this.personReads.push({ ids: [...ids] });
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

/** Real distinct-group semantics: one row per distinct `by` tuple with its `_count._all`. */
function groupRows(rows: readonly object[], by: string[]): GroupRow[] {
  const groups = new Map<string, GroupRow>();
  for (const r of rows) {
    const cols = r as Record<string, unknown>;
    const key = by.map((k) => String(cols[k])).join('\u0000');
    const g = groups.get(key);
    if (g) g._count._all += 1;
    else {
      const row: GroupRow = { _count: { _all: 1 } };
      for (const k of by) row[k] = String(cols[k]);
      groups.set(key, row);
    }
  }
  return [...groups.values()];
}

/** Generic predicate matcher for the columns the reader filters on (equality, gt, AND/OR). */
function matchBase(
  r: { coach_id: string; intent_id: string; entity_type: string; source_platform: string },
  w: Where,
): boolean {
  if (w.coach_id !== undefined && r.coach_id !== w.coach_id) return false;
  if (w.intent_id !== undefined && r.intent_id !== w.intent_id) return false;
  if (typeof w.entity_type === 'string' && r.entity_type !== w.entity_type) return false;
  if (
    typeof w.entity_type === 'object' &&
    w.entity_type.gt !== undefined &&
    !(r.entity_type > w.entity_type.gt)
  )
    return false;
  if (typeof w.source_platform === 'string' && r.source_platform !== w.source_platform)
    return false;
  if (
    typeof w.source_platform === 'object' &&
    w.source_platform.gt !== undefined &&
    !(r.source_platform > w.source_platform.gt)
  )
    return false;
  if (w.OR !== undefined && !w.OR.some((o) => matchBase(r, o))) return false;
  if (w.AND !== undefined && !w.AND.every((a) => matchBase(r, a))) return false;
  return true;
}

function matchLedger(r: LedgerRow, w: Where): boolean {
  if (w.coach_id !== undefined && r.coach_id !== w.coach_id) return false;
  if (w.intent_id !== undefined && r.intent_id !== w.intent_id) return false;
  if (typeof w.entity_type === 'string' && r.entity_type !== w.entity_type) return false;
  if (
    typeof w.entity_type === 'object' &&
    w.entity_type.gt !== undefined &&
    !(r.entity_type > w.entity_type.gt)
  )
    return false;
  if (w.status !== undefined && r.status !== w.status) return false;
  if (typeof w.source_id === 'string' && r.source_id !== w.source_id) return false;
  if (
    typeof w.source_id === 'object' &&
    w.source_id.gt !== undefined &&
    !(r.source_id > w.source_id.gt)
  )
    return false;
  if (typeof w.source_platform === 'string' && r.source_platform !== w.source_platform)
    return false;
  if (
    typeof w.source_platform === 'object' &&
    w.source_platform.gt !== undefined &&
    !(r.source_platform > w.source_platform.gt)
  )
    return false;
  if (w.OR !== undefined && !w.OR.some((o) => matchLedger(r, o))) return false;
  if (w.AND !== undefined && !w.AND.every((a) => matchLedger(r, a))) return false;
  return true;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** The ledger's unique key order: (source_id, source_platform, entity_type). */
const byIdentity = (a: LedgerRow, b: LedgerRow): number =>
  cmp(a.source_id, b.source_id) ||
  cmp(a.source_platform, b.source_platform) ||
  cmp(a.entity_type, b.entity_type);

const b64 = (v: string): string => Buffer.from(v, 'utf8').toString('base64url');
/** The scoped v2 (pair-only) token Q1 emitted before S11-E r2; still accepted as input. */
function expectedV2(coach: string, intent: string, s: string, p: string): string {
  const o = 'source_id:asc,source_platform:asc';
  return `v2.${b64(JSON.stringify({ v: 2, c: coach, i: intent, f: ET, o, s, p }))}`;
}
/** The exact scoped v3 (row) token the reader must emit for a roster boundary. */
function expectedV3(coach: string, intent: string, s: string, p: string, t: string): string {
  const o = 'source_id:asc,source_platform:asc,entity_type:asc';
  return `v3.${b64(JSON.stringify({ v: 3, c: coach, i: intent, f: ET, o, s, p, t }))}`;
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

/**
 * Seed one settled intent with N reconstructed persons + optional skipped/failed.
 * Default source: the legacy convention (`truecoach`, token == family `clients`).
 * S11-E: `platform` / `token` seed a token-mapped source instead (the staged and
 * ledger rows carry that token, exactly as the engine writes them); `prefix`
 * keeps source ids distinct across platforms within one intent.
 */
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
    platform?: string;
    token?: string;
    prefix?: string;
  },
): void {
  const coach = opts.coach ?? COACH;
  const intent = opts.intent ?? INTENT;
  const platform = opts.platform ?? 'truecoach';
  const token = opts.token ?? ET;
  const prefix = opts.prefix ?? 's';
  if (!fake.imports.some((i) => i.coach_id === coach && i.intent_id === intent)) {
    fake.imports.push({
      coach_id: coach,
      intent_id: intent,
      id: `imp-${coach}-${intent}`,
      // Settled by default; a test may pass terminalStatus: null for an unsettled intent.
      terminal_status: opts.terminalStatus === undefined ? 'succeeded' : opts.terminalStatus,
    });
  }

  const recN = opts.reconstructed ?? 0;
  const skipN = opts.skipped ?? 0;
  const failN = opts.failed ?? 0;
  let idx = 0;
  const push = (status: string, withPerson: boolean): void => {
    // Zero-padded source_id so lexical asc order is human-obvious (s000, s001...).
    const sid = `${prefix}${String(idx).padStart(3, '0')}`;
    idx += 1;
    // The token joins the Person id only when it is not the family literal, so every
    // pre-existing fixture id is unchanged and two tokens of one platform can share a sid.
    const targetId = withPerson
      ? `p-${coach}-${platform}-${token === ET ? '' : `${token}-`}${sid}`
      : null;
    fake.ingest.push({
      coach_id: coach,
      intent_id: intent,
      entity_type: token,
      source_id: sid,
      source_platform: platform,
    });
    fake.ledgerRows.push({
      coach_id: coach,
      intent_id: intent,
      entity_type: token,
      source_id: sid,
      source_platform: platform,
      status,
      target_id: targetId,
    });
    if (withPerson && targetId) {
      fake.persons.push({
        id: targetId,
        coach_id: coach,
        source_platform: platform,
        source_person_id: `${platform === 'truecoach' ? 'tc' : platform}_${sid}`,
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
      entity_type: token,
      source_id: `${prefix}extra${i}`,
      source_platform: platform,
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
    expect(res.accounting).toEqual({
      staged: 5,
      reconstructed: 3,
      skipped: 1,
      failed: 1,
      unclassified: 0,
    });
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
    expect(res.accounting).toEqual({
      staged: 0,
      reconstructed: 0,
      skipped: 0,
      failed: 0,
      unclassified: 0,
    });
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
    // Q1: every non-final page emits the exact scoped v2 token of its last
    // LEDGER row (source_id, source_platform); the first page is ordered the
    // same way as every later page.
    expect(page1.page.next_cursor).toBe(expectedV3(COACH, INTENT, 's001', 'truecoach', ET));
    expect(fake.ledgerReads[0].orderBy).toEqual([
      { source_id: 'asc' },
      { source_platform: 'asc' },
      { entity_type: 'asc' },
    ]);

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

  describe('Q1 cursor emission and legacy-boundary resolution', () => {
    const legacyRoster = (s: string): string => b64(s);

    it('emits scoped v2 on every non-final page and the decoder accepts each one back', async () => {
      const fake = new FakePrisma();
      seed(fake, { reconstructed: 5 });
      const { service } = makeService(fake);
      let cursor: string | undefined;
      const emitted: string[] = [];
      for (let guard = 0; guard < 10; guard++) {
        const page = await service.getRoster(COACH, INTENT, cursor, 2);
        if (!page.page.has_more) {
          expect(page.page.next_cursor).toBeNull();
          break;
        }
        const token = page.page.next_cursor ?? '';
        emitted.push(token);
        expect(token.startsWith('v3.')).toBe(true);
        expect(decodeScoutCursor(token, COACH, INTENT, ET)).toEqual({
          s: page.persons[page.persons.length - 1].source_person_id.replace('tc_', ''),
          p: 'truecoach',
          t: ET,
        });
        cursor = token;
      }
      expect(emitted).toEqual([
        expectedV3(COACH, INTENT, 's001', 'truecoach', ET),
        expectedV3(COACH, INTENT, 's003', 'truecoach', ET),
      ]);
    });

    it('resolves a Q0-emitted legacy roster token to the same next page as its v2 twin', async () => {
      const fake = new FakePrisma();
      seed(fake, { reconstructed: 5 });
      const { service } = makeService(fake);
      const page1 = await service.getRoster(COACH, INTENT, undefined, 2);
      const viaV2 = await service.getRoster(COACH, INTENT, page1.page.next_cursor ?? undefined, 2);
      const viaLegacy = await service.getRoster(COACH, INTENT, legacyRoster('s001'), 2);
      expect(viaLegacy).toEqual(viaV2);
      expect(viaLegacy.persons.map((p) => p.source_person_id)).toEqual(['tc_s002', 'tc_s003']);
      // Resolution happened inside the one RepeatableRead snapshot, after the
      // gate, as a bounded (take 2) equality lookup — then the page read.
      expect(fake.transactionCalls).toHaveLength(3);
      const reads = fake.ledgerReads.slice(-2);
      // S11-E: the family is the registry-resolved (platform, token) pair predicate,
      // not an `entity_type` literal; the cursor continuation is AND-ed onto it.
      expect(reads[0]).toEqual({
        where: {
          coach_id: COACH,
          intent_id: INTENT,
          OR: [{ source_platform: 'truecoach', entity_type: ET }],
          status: 'reconstructed',
          source_id: 's001',
        },
        select: { source_platform: true, entity_type: true },
        take: 2,
      });
      expect(reads[1].where.AND).toEqual([
        {
          OR: [
            { source_id: { gt: 's001' } },
            { source_id: 's001', source_platform: { gt: 'truecoach' } },
            { source_id: 's001', source_platform: 'truecoach', entity_type: { gt: ET } },
          ],
        },
      ]);
      expect(fake.readsOutsideTx).toBe(0);
    });

    it('400s an unresolvable legacy token (absent source) before any count or page read', async () => {
      const fake = new FakePrisma();
      seed(fake, { reconstructed: 3 });
      const { service } = makeService(fake);
      const before = fake.ledgerReads.length;
      const err = await service
        .getRoster(COACH, INTENT, legacyRoster('zzz-never-reconstructed'), 2)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).message).toBe('malformed cursor');
      // Exactly one ledger read: the resolution lookup. No page was read.
      expect(fake.ledgerReads.length - before).toBe(1);
      expect(fake.ledgerReads[before].take).toBe(2);
      expect(JSON.stringify(err)).not.toContain('zzz-never');
    });

    it('never widens a roster legacy token past the requested (coach, intent, clients) scope', async () => {
      const fake = new FakePrisma();
      seed(fake, { reconstructed: 3 });
      seed(fake, { intent: 'intent-2', reconstructed: 0 });
      // The boundary exists as a reconstructed row of intent-1 (and of another
      // coach), but not of intent-2: the intent-2 read must not find it.
      fake.ledgerRows.push({
        coach_id: OTHER,
        intent_id: 'intent-2',
        entity_type: ET,
        source_id: 's001',
        source_platform: 'truecoach',
        status: 'reconstructed',
        target_id: null,
      });
      const { service } = makeService(fake);
      await expect(service.getRoster(COACH, 'intent-2', legacyRoster('s001'), 2)).rejects.toThrow(
        'malformed cursor',
      );
      // A skipped/failed row of the same source is not a boundary either.
      fake.ledgerRows.push({
        coach_id: COACH,
        intent_id: 'intent-2',
        entity_type: ET,
        source_id: 's001',
        source_platform: 'truecoach',
        status: 'skipped',
        target_id: null,
      });
      await expect(service.getRoster(COACH, 'intent-2', legacyRoster('s001'), 2)).rejects.toThrow(
        'malformed cursor',
      );
    });

    it('enumerates identity ties exactly once via (source_id, source_platform) and refuses a tied legacy boundary', async () => {
      const fake = new FakePrisma();
      seed(fake, { reconstructed: 2 });
      // The same source_id reconstructed from three REGISTERED platforms (the two
      // conformance specs declare `clients`, so the legacy token == family
      // convention classifies them; an unregistered platform would be excluded
      // by the S11-E scope, see the registry-scoped suite below).
      for (const p of ['conformance_beta', 'conformance_alpha']) {
        fake.ingest.push({
          coach_id: COACH,
          intent_id: INTENT,
          entity_type: ET,
          source_id: 's000',
          source_platform: p,
        });
        fake.ledgerRows.push({
          coach_id: COACH,
          intent_id: INTENT,
          entity_type: ET,
          source_id: 's000',
          source_platform: p,
          status: 'reconstructed',
          target_id: `p-${p}`,
        });
        fake.persons.push({
          id: `p-${p}`,
          coach_id: COACH,
          source_platform: p,
          source_person_id: `${p}_s000`,
          display_name: null,
          state: PersonState.InvitePending,
          created_at: new Date(0),
          updated_at: new Date(0),
        });
      }
      const { service } = makeService(fake);
      const seen: string[] = [];
      const tokens: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 20; guard++) {
        const page = await service.getRoster(COACH, INTENT, cursor, 1);
        seen.push(...page.persons.map((p) => p.source_person_id));
        if (!page.page.has_more) break;
        tokens.push(page.page.next_cursor ?? '');
        cursor = page.page.next_cursor ?? undefined;
      }
      expect(seen).toEqual([
        'conformance_alpha_s000',
        'conformance_beta_s000',
        'tc_s000',
        'tc_s001',
      ]);
      expect(tokens).toEqual([
        expectedV3(COACH, INTENT, 's000', 'conformance_alpha', ET),
        expectedV3(COACH, INTENT, 's000', 'conformance_beta', ET),
        expectedV3(COACH, INTENT, 's000', 'truecoach', ET),
      ]);
      // A legacy token naming the tied source cannot pick a platform: 400 restart.
      await expect(service.getRoster(COACH, INTENT, legacyRoster('s000'), 1)).rejects.toThrow(
        'malformed cursor',
      );
    });

    it('a row whose platform no spec registers is never paged or anchored (counted unclassified)', async () => {
      const fake = new FakePrisma();
      seed(fake, { reconstructed: 3 });
      // Pre-S11-E this row reached the page and the encoder refused its boundary
      // (500 `cursor boundary not encodable`). Now the registry excludes the pair
      // before any page read: the staged row is counted `unclassified`, the ledger
      // row is neither served nor a cursor anchor, and the page is served.
      fake.ingest[1].source_platform = 'Not-Canonical';
      fake.ledgerRows[1].source_platform = 'Not-Canonical';
      const { service } = makeService(fake);
      const page1 = await service.getRoster(COACH, INTENT, undefined, 1);
      expect(page1.persons.map((p) => p.source_person_id)).toEqual(['tc_s000']);
      expect(page1.page.next_cursor).toBe(expectedV3(COACH, INTENT, 's000', 'truecoach', ET));
      expect(page1.accounting).toEqual({
        staged: 2,
        reconstructed: 2,
        skipped: 0,
        failed: 0,
        unclassified: 1,
      });
      const page2 = await service.getRoster(COACH, INTENT, page1.page.next_cursor ?? undefined, 1);
      expect(page2.persons.map((p) => p.source_person_id)).toEqual(['tc_s002']);
      expect(page2.page.has_more).toBe(false);
    });
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
      source_platform: 'truecoach',
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

/**
 * S8-F — roster qualifier and kind fence (readiness F10). The roster stays the
 * interim accepted Person bridge: every response says so at the top level
 * (`roster_bridge_pending: true`, empty pages included), and only NULL-kind
 * (legacy) or `person`-kind ledger rows are ever joined to Person. A typed
 * non-person row is dropped while the ledger-anchored cursor still advances.
 */
describe('ScoutRosterService S8-F interim bridge qualifier', () => {
  it('exposes roster_bridge_pending: true on a populated page', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: 2 });
    const { service } = makeService(fake);
    const res = await service.getRoster(COACH, INTENT, undefined, undefined);
    expect(res.roster_bridge_pending).toBe(true);
    expect(ROSTER_BRIDGE_PENDING).toBe(true);
    expect(Object.keys(res).sort()).toEqual(
      ['accounting', 'intent_id', 'page', 'persons', 'roster_bridge_pending'].sort(),
    );
  });

  it('exposes roster_bridge_pending: true on an EMPTY page too (settled, nothing reconstructed)', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: 0, skipped: 1 });
    const { service } = makeService(fake);
    const res = await service.getRoster(COACH, INTENT, undefined, undefined);
    expect(res.persons).toEqual([]);
    expect(res.roster_bridge_pending).toBe(true);
  });

  it('is response-level only: no per-row flag is added to a roster row', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: 1 });
    const { service } = makeService(fake);
    const res = await service.getRoster(COACH, INTENT, undefined, undefined);
    expect(res.persons[0]).not.toHaveProperty('roster_bridge_pending');
    expect(res.persons[0]).not.toHaveProperty('target_kind');
    expect(res.persons[0]).not.toHaveProperty('native_id');
  });

  it('F10: an explicit person kind materializes exactly like a legacy NULL kind', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: 2 });
    fake.ledgerRows[1].target_kind = ROSTER_TARGET_KIND;
    const { service } = makeService(fake);
    const res = await service.getRoster(COACH, INTENT, undefined, undefined);
    expect(res.persons.map((p) => p.source_person_id)).toEqual(['tc_s000', 'tc_s001']);
  });

  it('F10: a non-person kind is never joined to Person, even when the id matches a Person row', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: 1 });
    // A typed native row whose target_id happens to equal an existing Person id
    // of this coach: it must not be looked up, let alone served as a Person.
    const decoy = fake.persons[0].id;
    for (const kind of ['workout_plan', 'workout_program', 'scout_entity', 'meal_plan']) {
      fake.ledgerRows.push({
        coach_id: COACH,
        intent_id: INTENT,
        entity_type: ET,
        source_id: `z-${kind}`,
        source_platform: 'truecoach',
        status: 'reconstructed',
        target_id: decoy,
        target_kind: kind,
      });
    }
    const { service } = makeService(fake);
    const res = await service.getRoster(COACH, INTENT, undefined, undefined);
    expect(res.persons.map((p) => p.source_person_id)).toEqual(['tc_s000']);
    // The Person lookup carried only the legacy row's id — once.
    expect(fake.personReads).toEqual([{ ids: [decoy] }]);
    // Accounting is ledger truth and still counts the typed rows as reconstructed.
    expect(res.accounting.reconstructed).toBe(5);
  });

  it('F10: a page made only of non-person kinds is empty, and the cursor still advances', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: 1 }); // s000 (legacy person)
    for (const sid of ['a-typed', 'b-typed']) {
      fake.ledgerRows.push({
        coach_id: COACH,
        intent_id: INTENT,
        entity_type: ET,
        source_id: sid,
        source_platform: 'truecoach',
        status: 'reconstructed',
        target_id: `plan-${sid}`,
        target_kind: 'workout_plan',
      });
    }
    const { service } = makeService(fake);
    const page1 = await service.getRoster(COACH, INTENT, undefined, 2);
    expect(page1.persons).toEqual([]);
    expect(page1.page.has_more).toBe(true);
    expect(page1.roster_bridge_pending).toBe(true);
    expect(decodeScoutCursor(page1.page.next_cursor as string, COACH, INTENT, ET)).toEqual({
      s: 'b-typed',
      p: 'truecoach',
      t: ET,
    });
    // No Person read happened at all for the typed-only page.
    expect(fake.personReads).toEqual([]);
    const page2 = await service.getRoster(COACH, INTENT, page1.page.next_cursor ?? undefined, 2);
    expect(page2.persons.map((p) => p.source_person_id)).toEqual(['tc_s000']);
    expect(page2.page.has_more).toBe(false);
    expect(page2.roster_bridge_pending).toBe(true);
  });
});

/**
 * S11-E — registry-scoped family selection. Staged and ledger rows carry the
 * source's own step token (the engine plans and ledgers per staged
 * (source_platform, entity_type) group); the reader must select by the pairs that
 * classify to the roster family through the SAME registry, keep the legacy
 * token == family convention working, exclude other families from every count,
 * count what no spec can classify (never a silent zero), and stay bounded.
 */
describe('ScoutRosterService S11-E registry-scoped family selection', () => {
  /**
   * A repository-registered source whose ROSTER token differs from the family
   * name, resolved FROM the registry (no slug or token typed here): the first
   * spec, in registry order, with a step -> `clients` whose token is not `clients`.
   */
  const mapped = (() => {
    for (const mapper of buildSourceMapperRegistry().values()) {
      const token = Object.keys(mapper.spec.steps).find(
        (step) => mapper.spec.steps[step] === ET && step !== ET,
      );
      if (token !== undefined) return { platform: mapper.sourcePlatform, token };
    }
    throw new Error('no repository spec maps a non-literal roster token');
  })();
  /** A registered source whose spec maps a step to a NON-roster family. */
  const otherFamily = (() => {
    for (const mapper of buildSourceMapperRegistry().values()) {
      const token = Object.keys(mapper.spec.steps).find((step) => mapper.spec.steps[step] !== ET);
      if (token !== undefined) return { platform: mapper.sourcePlatform, token };
    }
    throw new Error('no repository spec maps a non-roster step');
  })();
  const pid = (platform: string, sid: string) => `${platform}_${sid}`;

  it('reads a token-mapped source as the roster: staged, ledger counts, persons and cursor all resolve through the registry', async () => {
    const fake = new FakePrisma();
    seed(fake, {
      reconstructed: 3,
      skipped: 1,
      failed: 1,
      platform: mapped.platform,
      token: mapped.token,
      prefix: 'm',
    });
    const { service } = makeService(fake);
    const page1 = await service.getRoster(COACH, INTENT, undefined, 2);
    expect(page1.accounting).toEqual({
      staged: 5,
      reconstructed: 3,
      skipped: 1,
      failed: 1,
      unclassified: 0,
    });
    expect(page1.accounting.staged).toBe(
      page1.accounting.reconstructed + page1.accounting.skipped + page1.accounting.failed,
    );
    expect(page1.persons.map((p) => p.source_person_id)).toEqual([
      pid(mapped.platform, 'm000'),
      pid(mapped.platform, 'm001'),
    ]);
    expect(page1.page.next_cursor).toBe(
      expectedV3(COACH, INTENT, 'm001', mapped.platform, mapped.token),
    );
    const page2 = await service.getRoster(COACH, INTENT, page1.page.next_cursor ?? undefined, 2);
    expect(page2.persons.map((p) => p.source_person_id)).toEqual([pid(mapped.platform, 'm002')]);
    expect(page2.page.has_more).toBe(false);
    // No ledger read filtered on the family literal: the predicate is the pair.
    for (const read of fake.ledgerReads) {
      expect(read.where.entity_type).toBeUndefined();
      expect(read.where.OR).toEqual([
        { source_platform: mapped.platform, entity_type: mapped.token },
      ]);
    }
  });

  it('merges a legacy (token == family) source and a token-mapped source in one deterministic order across pages', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: 2 }); // truecoach s000, s001 (legacy convention)
    seed(fake, { reconstructed: 2, platform: mapped.platform, token: mapped.token, prefix: 'a' });
    const { service } = makeService(fake);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await service.getRoster(COACH, INTENT, cursor, 3);
      expect(page.accounting).toEqual({
        staged: 4,
        reconstructed: 4,
        skipped: 0,
        failed: 0,
        unclassified: 0,
      });
      seen.push(...page.persons.map((p) => p.source_person_id));
      if (!page.page.has_more) break;
      cursor = page.page.next_cursor ?? undefined;
    }
    // (source_id, source_platform) asc: a000 < a001 < s000 < s001.
    expect(seen).toEqual([
      pid(mapped.platform, 'a000'),
      pid(mapped.platform, 'a001'),
      'tc_s000',
      'tc_s001',
    ]);
    // The predicate carries BOTH pairs, sorted by (platform, token).
    const pairs = fake.ledgerReads[0].where.OR;
    expect(pairs).toEqual(
      [
        { source_platform: mapped.platform, entity_type: mapped.token },
        { source_platform: 'truecoach', entity_type: ET },
      ].sort((a, b) => (a.source_platform < b.source_platform ? -1 : 1)),
    );
  });

  it("excludes another family's staged and ledger rows from every roster count", async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: 2 });
    seed(fake, {
      reconstructed: 3,
      skipped: 2,
      platform: otherFamily.platform,
      token: otherFamily.token,
      prefix: 'w',
    });
    const { service } = makeService(fake);
    const res = await service.getRoster(COACH, INTENT, undefined, undefined);
    expect(res.accounting).toEqual({
      staged: 2,
      reconstructed: 2,
      skipped: 0,
      failed: 0,
      unclassified: 0,
    });
    expect(res.persons.map((p) => p.source_person_id)).toEqual(['tc_s000', 'tc_s001']);
  });

  it('counts staged rows no spec can classify as `unclassified` and never serves them, even with a reconstructed ledger row and a Person', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: 1 });
    // Unregistered platform (legacy token) and a registered platform with an
    // unmapped token: neither classifies to ANY family.
    seed(fake, { reconstructed: 2, platform: 'unregistered-platform', prefix: 'u' });
    seed(fake, { reconstructed: 1, token: 'not-a-step', prefix: 'x' });
    const { service } = makeService(fake);
    const res = await service.getRoster(COACH, INTENT, undefined, undefined);
    expect(res.accounting).toEqual({
      staged: 1,
      reconstructed: 1,
      skipped: 0,
      failed: 0,
      unclassified: 3,
    });
    expect(res.persons.map((p) => p.source_person_id)).toEqual(['tc_s000']);
    // The unclassifiable Persons were never even looked up.
    expect(fake.personReads).toEqual([{ ids: [`p-${COACH}-truecoach-s000`] }]);
  });

  describe('empty scope (nothing of the family staged or ledgered)', () => {
    it('serves the truthful empty page without a ledger page read; unclassified is reported', async () => {
      const fake = new FakePrisma();
      seed(fake, { reconstructed: 2, platform: 'unregistered-platform', prefix: 'u' });
      const { service } = makeService(fake);
      const res = await service.getRoster(COACH, INTENT, undefined, undefined);
      expect(res.persons).toEqual([]);
      expect(res.accounting).toEqual({
        staged: 0,
        reconstructed: 0,
        skipped: 0,
        failed: 0,
        unclassified: 2,
      });
      expect(res.page).toEqual({
        limit: ROSTER_DEFAULT_PAGE_SIZE,
        next_cursor: null,
        has_more: false,
      });
      expect(res.roster_bridge_pending).toBe(true);
      expect(fake.ledgerReads).toEqual([]);
      expect(fake.transactionCalls).toEqual([{ isolationLevel: 'RepeatableRead' }]);
    });

    it('400s a legacy token (no boundary can exist) and serves a v2 token as the empty page', async () => {
      const fake = new FakePrisma();
      fake.imports.push({ coach_id: COACH, intent_id: INTENT, id: 'imp', terminal_status: 'ok' });
      const { service } = makeService(fake);
      await expect(service.getRoster(COACH, INTENT, b64('s001'), 2)).rejects.toThrow(
        'malformed cursor',
      );
      const v2 = await service.getRoster(
        COACH,
        INTENT,
        expectedV2(COACH, INTENT, 's001', 'truecoach'),
        2,
      );
      expect(v2.persons).toEqual([]);
      expect(v2.page.has_more).toBe(false);
      expect(fake.ledgerReads).toEqual([]);
    });
  });

  it('stays bounded: exactly two tenant-scoped aggregates and one limit+1 page read, regardless of row count', async () => {
    const fake = new FakePrisma();
    seed(fake, { reconstructed: 400, skipped: 87 });
    seed(fake, { reconstructed: 200, platform: mapped.platform, token: mapped.token, prefix: 'm' });
    const { service } = makeService(fake);
    const res = await service.getRoster(COACH, INTENT, undefined, 50);
    expect(res.accounting).toEqual({
      staged: 687,
      reconstructed: 600,
      skipped: 87,
      failed: 0,
      unclassified: 0,
    });
    expect(fake.groupReads).toEqual([
      {
        table: 'ingest',
        by: ['source_platform', 'entity_type'],
        where: { coach_id: COACH, intent_id: INTENT },
      },
      {
        table: 'ledger',
        by: ['status', 'source_platform', 'entity_type'],
        where: { coach_id: COACH, intent_id: INTENT },
      },
    ]);
    expect(fake.ledgerReads).toHaveLength(1);
    expect(fake.ledgerReads[0].take).toBe(51);
    expect(fake.personReads).toHaveLength(1);
    expect(fake.readsOutsideTx).toBe(0);
  });
});

/**
 * S11-E r2 (review A1) — two step tokens of ONE platform that classify to the
 * roster family may share an id space, so two reconstructed ledger rows can tie
 * on (source_id, source_platform) and differ only by token. The page order and
 * the emitted cursor must therefore be the ledger's unique key
 * (source_id, source_platform, entity_type), and every older, less precise token
 * must resolve unambiguously or fail closed.
 */
describe('ScoutRosterService S11-E r2 total order across tied tokens of one platform', () => {
  /**
   * Resolved FROM the registry, never typed: a platform with two distinct tokens that
   * classify to the roster family — two mapped steps if a spec declares them, else one
   * mapped step plus the family literal the same spec declares (the legacy convention
   * `resolveFamily` honours, so the engine ledgers both under their own token).
   */
  const tied = (() => {
    for (const mapper of buildSourceMapperRegistry().values()) {
      const tokens = Object.keys(mapper.spec.steps).filter(
        (step) => mapper.spec.steps[step] === ET,
      );
      if (!tokens.includes(ET) && Object.prototype.hasOwnProperty.call(mapper.spec.families, ET))
        tokens.push(ET);
      if (tokens.length >= 2) return { platform: mapper.sourcePlatform, tokens: tokens.sort() };
    }
    throw new Error('no repository spec has two roster tokens on one platform');
  })();
  const [tokenA, tokenB] = tied.tokens;
  const personId = (token: string, sid: string) =>
    `p-${COACH}-${tied.platform}-${token === ET ? '' : `${token}-`}${sid}`;
  /** Two tokens, one platform, the SAME two source ids: four ledger rows, two ties. */
  const seedTied = (fake: FakePrisma) => {
    seed(fake, { reconstructed: 2, platform: tied.platform, token: tokenA, prefix: 'x' });
    seed(fake, { reconstructed: 2, platform: tied.platform, token: tokenB, prefix: 'x' });
  };

  it('serves every tied row exactly once, in (source_id, platform, token) order, at limit 1 across pages', async () => {
    const fake = new FakePrisma();
    seedTied(fake);
    const { service } = makeService(fake);
    const seen: string[] = [];
    const cursors: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await service.getRoster(COACH, INTENT, cursor, 1);
      expect(page.accounting).toEqual({
        staged: 4,
        reconstructed: 4,
        skipped: 0,
        failed: 0,
        unclassified: 0,
      });
      seen.push(...page.persons.map((p) => p.id));
      if (!page.page.has_more) {
        expect(page.page.next_cursor).toBeNull();
        break;
      }
      cursors.push(page.page.next_cursor ?? '');
      cursor = page.page.next_cursor ?? undefined;
    }
    expect(seen).toEqual([
      personId(tokenA, 'x000'),
      personId(tokenB, 'x000'),
      personId(tokenA, 'x001'),
      personId(tokenB, 'x001'),
    ]);
    expect(new Set(seen).size).toBe(4);
    // Every boundary names ONE row (its token included); the tie boundary continues to
    // the tied twin, not past it.
    expect(cursors).toEqual([
      expectedV3(COACH, INTENT, 'x000', tied.platform, tokenA),
      expectedV3(COACH, INTENT, 'x000', tied.platform, tokenB),
      expectedV3(COACH, INTENT, 'x001', tied.platform, tokenA),
    ]);
    const afterTie = fake.ledgerReads[1];
    expect(afterTie.where.AND).toEqual([
      {
        OR: [
          { source_id: { gt: 'x000' } },
          { source_id: 'x000', source_platform: { gt: tied.platform } },
          { source_id: 'x000', source_platform: tied.platform, entity_type: { gt: tokenA } },
        ],
      },
    ]);
    // The scoped predicate stays on every page read.
    for (const read of fake.ledgerReads) {
      expect(read.where.coach_id).toBe(COACH);
      expect(read.where.intent_id).toBe(INTENT);
      expect(read.where.status).toBe('reconstructed');
      expect(read.where.OR).toEqual(
        tied.tokens.map((t) => ({ source_platform: tied.platform, entity_type: t })),
      );
    }
    // A second full walk is identical: the order is total, not incidental.
    const again: string[] = [];
    cursor = undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await service.getRoster(COACH, INTENT, cursor, 1);
      again.push(...page.persons.map((p) => p.id));
      if (!page.page.has_more) break;
      cursor = page.page.next_cursor ?? undefined;
    }
    expect(again).toEqual(seen);
  });

  describe('a pair-only v2 token minted before r2', () => {
    it('is refused at an AMBIGUOUS boundary (two rows share the pair): 400, one lookup, no page read', async () => {
      const fake = new FakePrisma();
      seedTied(fake);
      const { service } = makeService(fake);
      const before = fake.ledgerReads.length;
      await expect(
        service.getRoster(COACH, INTENT, expectedV2(COACH, INTENT, 'x000', tied.platform), 1),
      ).rejects.toThrow('malformed cursor');
      expect(fake.ledgerReads.length - before).toBe(1);
      expect(fake.ledgerReads[before]).toEqual({
        where: {
          coach_id: COACH,
          intent_id: INTENT,
          OR: tied.tokens.map((t) => ({ source_platform: tied.platform, entity_type: t })),
          status: 'reconstructed',
          source_id: 'x000',
          source_platform: tied.platform,
        },
        select: { entity_type: true },
        take: 2,
      });
      expect(fake.personReads).toEqual([]);
    });

    it('resolves to the one row sharing the pair and continues after that row', async () => {
      const fake = new FakePrisma();
      seed(fake, { reconstructed: 3 });
      const { service } = makeService(fake);
      const res = await service.getRoster(
        COACH,
        INTENT,
        expectedV2(COACH, INTENT, 's000', 'truecoach'),
        5,
      );
      expect(res.persons.map((p) => p.source_person_id)).toEqual(['tc_s001', 'tc_s002']);
      const [lookup, page] = fake.ledgerReads;
      expect(lookup.select).toEqual({ entity_type: true });
      expect(lookup.take).toBe(2);
      expect(page.where.AND).toEqual([
        {
          OR: [
            { source_id: { gt: 's000' } },
            { source_id: 's000', source_platform: { gt: 'truecoach' } },
            { source_id: 's000', source_platform: 'truecoach', entity_type: { gt: ET } },
          ],
        },
      ]);
    });

    it('continues after a pair no row shares (no tie can exist), exactly as it did before r2', async () => {
      const fake = new FakePrisma();
      seed(fake, { reconstructed: 3 });
      const { service } = makeService(fake);
      const res = await service.getRoster(
        COACH,
        INTENT,
        expectedV2(COACH, INTENT, 's000a', 'truecoach'),
        5,
      );
      expect(res.persons.map((p) => p.source_person_id)).toEqual(['tc_s001', 'tc_s002']);
      const page = fake.ledgerReads[1];
      expect(page.where.AND).toEqual([
        {
          OR: [
            { source_id: { gt: 's000a' } },
            { source_id: 's000a', source_platform: { gt: 'truecoach' } },
          ],
        },
      ]);
    });
  });

  it('a legacy (source-only) token at a tied source id is refused before any page read', async () => {
    const fake = new FakePrisma();
    seedTied(fake);
    const { service } = makeService(fake);
    await expect(service.getRoster(COACH, INTENT, b64('x000'), 1)).rejects.toThrow(
      'malformed cursor',
    );
    expect(fake.ledgerReads).toHaveLength(1);
    expect(fake.ledgerReads[0].select).toEqual({ source_platform: true, entity_type: true });
  });
});
