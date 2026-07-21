import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Prisma } from '@prisma/client';
import { AnalyticsService } from '../../../src/analytics/analytics.service';
import { PrismaService } from '../../../src/prisma.service';
import { ScoutReconstructService } from '../../../src/scout/scout-reconstruct.service';
import { RECONSTRUCT_FAMILY } from '../../../src/scout/scout-reconstruct.dto';
import { type StagedRow } from '../../../src/scout/reconstruct/families';

/**
 * V5 PR-3 — two-adapter cross-repo e2e (tests-only, 0 prod LOC).
 *
 * This is the backend half of the multi-adapter neutrality proof. It consumes
 * the EXACT bytes the extension emits for the synthetic second adapter and drives
 * them through the UNMODIFIED backend reconstruct engine (ScoutReconstructService
 * + buildFamilyRegistry), asserting the engine reproduces an honest accounting
 * for a source shape it has never seen — with ZERO change to any engine/DTO/
 * OpenAPI/migration/RLS/flag file. The empty core git diff for this PR (only a
 * fixture + this spec) is the other half of "adapter #2 core diff == 0".
 *
 * Fixture provenance (do not paraphrase these SHAs — they are the audit trail):
 *   source repo   : BradleyGleavePortfolio/tgp-importer-extension (PR-2b, #8)
 *   merged main   : 95be0222df3d47d787566743c8781005d8fbec69
 *   source path   : test/fixtures/conformance/conformance-alpha.json
 *   source blob   : c3b8af8eacf944f3db43b0c45c49a9b6a7197392 (git blob sha1)
 * The file at test/fixtures/conformance/conformance-alpha.json.raw is a byte-for-
 * byte copy; `git hash-object` on it reproduces the source blob sha1 above. The
 * `.json.raw` suffix keeps the pinned bytes opaque to Prettier (its pre-commit
 * glob only matches `.json`), so byte-identity is preserved without a root-config
 * ignore entry. The bytes are pinned below with sha256 so any silent drift fails
 * loudly at CI time.
 *
 * `expect_records` is the extension's INDEPENDENTLY hand-authored staging golden
 * (what its site-agnostic crawl core emits to /api/scout/ingest). Here it is the
 * pinned cross-repo contract boundary: the exact staged rows the backend receives.
 *
 * Honest scope boundaries (NOT bugs — recorded so review sees them):
 *  1. The extension emits crawl families `coaches/members/routines/activity-log`;
 *     the backend reconstruct engine is keyed on `clients/workouts/client_history`.
 *     The test-side family assignment below (members→clients, routines→workouts,
 *     activity-log→client_history) matches the dispatch the merged backend spec
 *     already ratifies (conformance-alpha.mapper.spec.ts). `coaches` are the
 *     SOURCE platform's coaches (fan-out seed), not a backend imported family, so
 *     they are excluded. A canonical extension-family⇄backend-family contract is
 *     a PR-4 reconciliation, not asserted here.
 *  2. The extension TOLERATES poison rows (missing native id / non-object element)
 *     by assigning deterministic synthetic ids and passing the payload through —
 *     its terminal status is an honest "complete", not "failed". The backend seam
 *     then faithfully reconstructs those rows as degraded (null-field) records
 *     rather than failing them: a non-empty source_id maps `ok`. This spec asserts
 *     that TRUTH (poison tolerated end-to-end), and defers exhaustive skip/failed
 *     accounting to scout-reconstruct.service.spec.ts (see the fail-closed block).
 *  3. The conformance routines/activity-log payloads are FLAT (`title` at top
 *     level); the entity mapper reads `attributes.title`, so labels degrade to
 *     null without throwing. That degrade is the source-neutral, total behaviour
 *     the seam guarantees — asserted directly below.
 *
 * Cross-cutting guarantees are proven ONCE elsewhere and intentionally NOT
 * duplicated here: contract byte-freeze 1.4.0 (test/contracts/importer-contract.spec.ts),
 * live RLS + erasure + no-existence-oracle (test/scout/entities/scout-entities.rls.live.spec.ts),
 * idempotency key (test/scout/scout-ingest.idempotency.spec.ts).
 */

const FIXTURE_PATH = join(
  __dirname,
  '..',
  '..',
  'fixtures',
  'conformance',
  'conformance-alpha.json.raw',
);
const EXPECTED_SHA256 = '144c3c9f56cad1ae9cc875fe0c42862fef0d28603272693da7d20770d174cf4c';
const EXPECTED_BYTE_LENGTH = 4280;
const SOURCE_PLATFORM = 'conformance_alpha';

// The importer never captures billing/payment instruments (D2 boundary). Mirror
// of the D1 golden-fixture guard (test/truecoach-golden-fixture.spec.ts).
const FORBIDDEN_BILLING_TOKENS = [
  'card',
  'cardnumber',
  'cvv',
  'cvc',
  'iban',
  'routing',
  'account_number',
  'payment_method',
  'paymentmethod',
  'payment_profile',
  'vault',
  'stripe',
  'subscription',
  'billing',
  'sk_live',
  'pk_live',
  'credit_card',
];

interface ExpectRecord {
  readonly sourceId: string;
  readonly payload: Prisma.JsonValue;
}
interface Fixture {
  readonly expect_records: Record<string, ExpectRecord[]>;
}

const rawBytes = readFileSync(FIXTURE_PATH);
const rawText = rawBytes.toString('utf8');
const fixture = JSON.parse(rawText) as Fixture;

/** Project an extension crawl family's golden records into backend staged rows. */
function stagedRows(family: string): StagedRow[] {
  return fixture.expect_records[family].map((record) => ({
    source_id: record.sourceId,
    source_platform: SOURCE_PLATFORM,
    payload: record.payload,
  }));
}

// ---------------------------------------------------------------------------
// In-memory Prisma fake driving the REAL ScoutReconstructService. Same shape and
// double-cast-free wrapping as scout-reconstruct.service.spec.ts, extended with
// the generic-entity upsert so the non-person families can reconstruct too. All
// where-clauses (count / findMany / groupBy) are honoured so multiple families
// and tenants can share one fake without cross-talk.
// ---------------------------------------------------------------------------

interface StagedRecord {
  readonly coach_id: string;
  readonly intent_id: string;
  readonly entity_type: string;
  readonly source_id: string;
  readonly source_platform: string;
  readonly payload: Prisma.JsonValue;
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
interface Scope {
  coach_id: string;
  intent_id: string;
  entity_type: string;
}

class FakePrisma {
  terminalStatus: string | null = 'success';
  readonly staged: StagedRecord[] = [];
  /** source_person_ids whose person.upsert throws once (poison-isolation proof). */
  readonly poison = new Set<string>();
  readonly persons = new Map<string, { id: string; display_name: string | null }>();
  readonly entities = new Map<string, { id: string; label: string | null }>();
  readonly ledger = new Map<string, LedgerRow>();

  private inScope(
    row: { coach_id: string; intent_id: string; entity_type: string },
    w: Scope,
  ): boolean {
    return (
      row.coach_id === w.coach_id &&
      row.intent_id === w.intent_id &&
      row.entity_type === w.entity_type
    );
  }

  scoutImport = {
    findUnique: async (_args: unknown) => ({ terminal_status: this.terminalStatus }),
  };

  scoutIngestEntity = {
    count: async (args: { where: Scope }) =>
      this.staged.filter((r) => this.inScope(r, args.where)).length,
    findMany: async (args: { where: Scope; take?: number; skip?: number }) => {
      const skip = args.skip ?? 0;
      const take = args.take ?? this.staged.length;
      return this.staged
        .filter((r) => this.inScope(r, args.where))
        .sort((a, b) => a.source_id.localeCompare(b.source_id))
        .slice(skip, skip + take)
        .map((r) => ({
          source_id: r.source_id,
          source_platform: r.source_platform,
          payload: r.payload,
        }));
    },
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
      const key = `${w.coach_id}|${w.source_platform}|${w.source_person_id}`;
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
      create: { label: string | null };
      update: { label: string | null };
    }) => {
      const w = args.where.coach_id_source_platform_entity_type_source_id;
      const key = `${w.coach_id}|${w.source_platform}|${w.entity_type}|${w.source_id}`;
      const existing = this.entities.get(key);
      if (existing) {
        existing.label = args.update.label;
        return { id: existing.id };
      }
      const created = { id: `entity-${this.entities.size + 1}`, label: args.create.label };
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
      const w = args.where.coach_id_intent_id_entity_type_source_id;
      const key = `${w.coach_id}|${w.intent_id}|${w.entity_type}|${w.source_id}`;
      const existing = this.ledger.get(key);
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }
      const row = { ...args.create };
      this.ledger.set(key, row);
      return row;
    },
    groupBy: async (args: { where: Scope }) => {
      const counts = new Map<string, number>();
      for (const row of this.ledger.values()) {
        if (!this.inScope(row, args.where)) continue;
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
  const service = new ScoutReconstructService(asPrisma(prisma), makeAnalytics(jest.fn()));
  return { service, prisma };
}

/** Stage a whole extension family under a backend (coach, intent, family). */
function stage(
  prisma: FakePrisma,
  coachId: string,
  intentId: string,
  entityType: string,
  extFamily: string,
): void {
  for (const row of stagedRows(extFamily)) {
    prisma.staged.push({
      coach_id: coachId,
      intent_id: intentId,
      entity_type: entityType,
      source_id: row.source_id,
      source_platform: row.source_platform,
      payload: row.payload,
    });
  }
}

const COACH = 'coach-conformance';
const INTENT = 'intent-conformance-1';

describe('conformance_alpha fixture — provenance + byte pin (D1 pattern)', () => {
  it('matches the recorded byte length from extension PR-2b', () => {
    expect(rawBytes.byteLength).toBe(EXPECTED_BYTE_LENGTH);
  });

  it('matches the deterministic sha256 byte pin', () => {
    expect(createHash('sha256').update(rawBytes).digest('hex')).toBe(EXPECTED_SHA256);
  });

  it('carries the extension staging golden with the four crawl families', () => {
    expect(Object.keys(fixture.expect_records).sort()).toEqual([
      'activity-log',
      'coaches',
      'members',
      'routines',
    ]);
  });

  it('captures no billing/payment/card/vault instruments (D2 hard boundary)', () => {
    const haystack = rawText.toLowerCase();
    expect(FORBIDDEN_BILLING_TOKENS.filter((t) => haystack.includes(t))).toEqual([]);
  });
});

describe('conformance_alpha e2e — members reconstruct into canonical clients', () => {
  it('reconstructs every member row with an honest all-accounted tally', async () => {
    const { service } = build((p) =>
      stage(p, COACH, INTENT, RECONSTRUCT_FAMILY.clients, 'members'),
    );
    const result = await service.reconstruct(COACH, INTENT, RECONSTRUCT_FAMILY.clients);

    // 6 = 3 clean + 2 extension-tolerated poison + 1 second-coach member.
    expect(result.staged).toBe(6);
    expect(result.reconstructed).toBe(6);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    // The accounting invariant the engine guarantees.
    expect(result.reconstructed + result.skipped + result.failed).toBe(result.staged);
  });

  it('maps nested profile.name to the canonical display name (never the email)', async () => {
    const { service, prisma } = build((p) =>
      stage(p, COACH, INTENT, RECONSTRUCT_FAMILY.clients, 'members'),
    );
    await service.reconstruct(COACH, INTENT, RECONSTRUCT_FAMILY.clients);

    const names = [...prisma.persons.values()].map((p) => p.display_name);
    expect(names).toContain('Dana');
    expect(names).toContain('Sam');
    expect(names).toContain('Lee');
    expect(names).toContain('Robin');
    // The email present in the fixture bytes is never mapped onto a client.
    expect(rawText).toContain('dana@member.test');
    for (const person of prisma.persons.values()) {
      expect(JSON.stringify(person)).not.toContain('member.test');
      expect(JSON.stringify(person)).not.toContain('@');
    }
  });

  it('tolerates the extension poison rows deterministically (synthetic id → degraded, not failed)', async () => {
    const { service, prisma } = build((p) =>
      stage(p, COACH, INTENT, RECONSTRUCT_FAMILY.clients, 'members'),
    );
    await service.reconstruct(COACH, INTENT, RECONSTRUCT_FAMILY.clients);

    const names = [...prisma.persons.values()].map((p) => p.display_name);
    // The no-id object kept its passthrough profile.name; the non-object element
    // degraded to a null display name — both reconstructed, neither threw.
    expect(names.some((n) => n !== null && n.includes('Ghost'))).toBe(true);
    expect(names.filter((n) => n === null)).toHaveLength(1);
  });

  it('is an idempotent no-op on replay: identical counts, no new Person rows', async () => {
    const { service, prisma } = build((p) =>
      stage(p, COACH, INTENT, RECONSTRUCT_FAMILY.clients, 'members'),
    );
    const first = await service.reconstruct(COACH, INTENT, RECONSTRUCT_FAMILY.clients);
    const mintedAfterFirst = prisma.persons.size;
    const second = await service.reconstruct(COACH, INTENT, RECONSTRUCT_FAMILY.clients);

    expect(second).toEqual(first);
    expect(prisma.persons.size).toBe(mintedAfterFirst);
  });
});

describe('conformance_alpha e2e — routines/activity-log reconstruct into the generic entity', () => {
  it('reconstructs routines (flat title degrades to a null label without throwing)', async () => {
    const { service, prisma } = build((p) =>
      stage(p, COACH, INTENT, RECONSTRUCT_FAMILY.workouts, 'routines'),
    );
    const result = await service.reconstruct(COACH, INTENT, RECONSTRUCT_FAMILY.workouts);

    expect(result.staged).toBe(3);
    expect(result.reconstructed).toBe(3);
    expect(result.reconstructed + result.skipped + result.failed).toBe(result.staged);
    // Extension put `title` at the top level; the seam reads attributes.title, so
    // labels degrade to null — the source-neutral total behaviour, and no billing
    // noise (weeks/price) ever lands on the canonical label.
    for (const entity of prisma.entities.values()) {
      expect(entity.label).toBeNull();
    }
  });

  it('reconstructs activity-log rows with the same honest accounting', async () => {
    const { service } = build((p) =>
      stage(p, COACH, INTENT, RECONSTRUCT_FAMILY.client_history, 'activity-log'),
    );
    const result = await service.reconstruct(COACH, INTENT, RECONSTRUCT_FAMILY.client_history);

    expect(result.staged).toBe(3);
    expect(result.reconstructed).toBe(3);
    expect(result.reconstructed + result.skipped + result.failed).toBe(result.staged);
  });
});

describe('conformance_alpha e2e — tenant scoping (app-layer coach_id filter)', () => {
  it('keeps two backend coaches importing the same fixture fully isolated', async () => {
    const coachA = 'coach-a';
    const coachB = 'coach-b';
    const { service, prisma } = build((p) => {
      stage(p, coachA, INTENT, RECONSTRUCT_FAMILY.clients, 'members');
      stage(p, coachB, INTENT, RECONSTRUCT_FAMILY.clients, 'members');
    });

    const a = await service.reconstruct(coachA, INTENT, RECONSTRUCT_FAMILY.clients);
    const b = await service.reconstruct(coachB, INTENT, RECONSTRUCT_FAMILY.clients);

    expect(a.reconstructed).toBe(6);
    expect(b.reconstructed).toBe(6);
    // Distinct Person rows per coach even though the source_ids are identical.
    const coachAKeys = [...prisma.persons.keys()].filter((k) => k.startsWith(`${coachA}|`));
    const coachBKeys = [...prisma.persons.keys()].filter((k) => k.startsWith(`${coachB}|`));
    expect(coachAKeys).toHaveLength(6);
    expect(coachBKeys).toHaveLength(6);
    expect(prisma.persons.size).toBe(12);
  });
});

describe('conformance_alpha e2e — fail-closed accounting stays honest under adversarial rows', () => {
  // The fixture itself produces no skips/failures (every record has a non-empty
  // source_id). This block proves the engine's skipped/failed accounting on the
  // SAME real payloads under controlled corruption — a focused check; exhaustive
  // skip/failed/poison-isolation coverage lives in scout-reconstruct.service.spec.ts.
  it('records a foreign-platform row as skipped and a persist-throw as failed', async () => {
    const foreignIntent = 'intent-adversarial';
    const { service } = build((p) => {
      const [clean, ...rest] = stagedRows('members');
      // Genuinely unmappable: a foreign source_platform → skipped (unsupported_platform).
      p.staged.push({
        coach_id: COACH,
        intent_id: foreignIntent,
        entity_type: RECONSTRUCT_FAMILY.clients,
        source_id: clean.source_id,
        source_platform: 'trainerize',
        payload: clean.payload,
      });
      // A poison persist on a real conformance row → failed (isolated, not a 500).
      const poisoned = rest[0];
      p.poison.add(poisoned.source_id);
      p.staged.push({
        coach_id: COACH,
        intent_id: foreignIntent,
        entity_type: RECONSTRUCT_FAMILY.clients,
        source_id: poisoned.source_id,
        source_platform: SOURCE_PLATFORM,
        payload: poisoned.payload,
      });
    });

    const result = await service.reconstruct(COACH, foreignIntent, RECONSTRUCT_FAMILY.clients);
    expect(result.staged).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.reconstructed).toBe(0);
    expect(result.reconstructed + result.skipped + result.failed).toBe(result.staged);
  });
});
