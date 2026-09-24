import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Prisma } from '@prisma/client';
import { buildFamilyRegistry } from '../../../src/scout/reconstruct/families';
import {
  type MapClientResult,
  type MapEntityResult,
  type StagedSourceRow,
} from '../../../src/scout/reconstruct/mapping-spec';
import {
  buildSourceMapperRegistry,
  type SourceMapper,
} from '../../../src/scout/reconstruct/source-mapper-registry';
import { RECONSTRUCT_FAMILY } from '../../../src/scout/scout-reconstruct.dto';

/**
 * S8-A equivalence — the data-only interpreter reproduces the RETIRED per-source
 * TypeScript mappers exactly (deep-equal mapped values AND byte-identical skip
 * reasons), both at the mapper seam and through the family layer the engine
 * calls. Because `persist` is unchanged, equal `map` output means equal
 * persisted values.
 *
 * The oracle below is the retired mapper code frozen from 61b93cff
 * (`src/scout/mappers/{truecoach-clients,truecoach-entity,conformance-alpha}.mapper.ts`):
 * each file's body is copied verbatim into its own function scope with only the
 * `import` lines and `export` keywords removed, so helper names cannot collide.
 * The oracle family layer is the 61b93cff `families.ts` dispatch (platform
 * lookup → `unsupported_platform:<token>`, else the source's mapper).
 */

type StagedClientRow = StagedSourceRow;
type StagedEntityRow = StagedSourceRow;

const legacyTrueCoachClients = (() => {
  /**
   * A staged client entity mapped to the fields needed to reconstruct an
   * invite-pending roster Person. Identity is the source platform id
   * (`sourcePersonId`), never email — D2 forbids email as a canonical or linking
   * key, so this mapper never reads it.
   */
  interface MappedClient {
    readonly sourcePersonId: string;
    readonly sourcePlatform: string;
    readonly displayName: string | null;
  }

  /** Total-function result: either a mapped client or a skip with a reason. */
  type MapClientResult =
    | { readonly ok: true; readonly client: MappedClient }
    | { readonly ok: false; readonly reason: string };

  /** The staged row shape this mapper consumes (a persisted ScoutIngestEntity). */
  interface StagedClientRow {
    readonly source_id: string;
    readonly source_platform: string;
    readonly payload: Prisma.JsonValue;
  }

  /**
   * Pure, deterministic, total mapper for TrueCoach `clients` entities. Given a
   * staged row it returns either a reconstructable client or an explicit skip
   * reason — it never throws, so the caller's accounting is exhaustive. Only the
   * opaque platform id is used as the dedup key; the display name is best-effort
   * and optional; email is deliberately ignored.
   */
  function mapTrueCoachClient(row: StagedClientRow): MapClientResult {
    if (row.source_platform !== 'truecoach') {
      return { ok: false, reason: `unsupported_platform:${row.source_platform}` };
    }
    const sourcePersonId = row.source_id.trim();
    if (sourcePersonId.length === 0) {
      return { ok: false, reason: 'missing_source_id' };
    }
    return {
      ok: true,
      client: {
        sourcePersonId,
        sourcePlatform: row.source_platform,
        displayName: extractDisplayName(row.payload),
      },
    };
  }

  /** Read a non-empty `name` string from the opaque payload, else null. */
  function extractDisplayName(payload: Prisma.JsonValue): string | null {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }
    const name = (payload as Record<string, Prisma.JsonValue>)['name'];
    if (typeof name !== 'string') return null;
    const trimmed = name.trim();
    return trimmed.length === 0 ? null : trimmed;
  }

  return { mapTrueCoachClient };
})();

const legacyTrueCoachEntity = (() => {
  /**
   * A staged non-person entity (a `workouts` or `client_history` row) mapped to the
   * PII-minimal fields needed to reconstruct a canonical `ScoutReconstructedEntity`.
   * Identity is the source platform's opaque record id — carried by the engine as
   * the tenant-scoped external_ref key, never email and never a billing key.
   * `clientSourceId` is a soft provenance link to the owning client's source id
   * (the Person external_ref), and `label` is a best-effort display title — D2
   * forbids email/billing as canonical or linking keys, so this mapper never reads
   * them.
   */
  interface MappedEntity {
    readonly sourcePlatform: string;
    readonly clientSourceId: string | null;
    readonly label: string | null;
  }

  /** Total-function result: either a mapped entity or a skip with a reason. */
  type MapEntityResult =
    | { readonly ok: true; readonly entity: MappedEntity }
    | { readonly ok: false; readonly reason: string };

  /** The staged row shape this mapper consumes (a persisted ScoutIngestEntity). */
  interface StagedEntityRow {
    readonly source_id: string;
    readonly source_platform: string;
    readonly payload: Prisma.JsonValue;
  }

  /**
   * Pure, deterministic, total mapper for TrueCoach non-person families
   * (`workouts`, `client_history`). Given a staged row it returns either a
   * reconstructable canonical entity or an explicit skip reason — it never throws,
   * so the caller's accounting is exhaustive. Only opaque platform ids and a
   * best-effort display label are used; email and any billing/price field are
   * deliberately ignored (they are never read from the payload).
   */
  function mapTrueCoachEntity(row: StagedEntityRow): MapEntityResult {
    if (row.source_platform !== 'truecoach') {
      return { ok: false, reason: `unsupported_platform:${row.source_platform}` };
    }
    if (row.source_id.trim().length === 0) {
      return { ok: false, reason: 'missing_source_id' };
    }
    return {
      ok: true,
      entity: {
        sourcePlatform: row.source_platform,
        clientSourceId: extractClientSourceId(row.payload),
        label: extractLabel(row.payload),
      },
    };
  }

  /** Narrow the opaque payload to an indexable object, else null. */
  function asObject(payload: Prisma.JsonValue): Record<string, Prisma.JsonValue> | null {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
    return payload as Record<string, Prisma.JsonValue>;
  }

  /**
   * Read the owning client's opaque source id from `client_id` / `clientId`,
   * coercing a numeric id to its string form. Never email. Returns null when
   * absent or not a scalar id.
   */
  function extractClientSourceId(payload: Prisma.JsonValue): string | null {
    const obj = asObject(payload);
    if (obj === null) return null;
    const raw = obj['client_id'] ?? obj['clientId'];
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      return trimmed.length === 0 ? null : trimmed;
    }
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
    return null;
  }

  /** Read a non-empty display title from `title` / `name`, else null. */
  function extractLabel(payload: Prisma.JsonValue): string | null {
    const obj = asObject(payload);
    if (obj === null) return null;
    const raw = obj['title'] ?? obj['name'];
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return trimmed.length === 0 ? null : trimmed;
  }

  return { mapTrueCoachEntity };
})();

const legacyConformanceAlpha = (() => {
  /**
   * Adapter #2 — `conformance_alpha`. A synthetic, NON-PRODUCTION source that
   * proves the frozen `SourceMapper` seam is source-neutral: a second source is one
   * mapper pair + one registry line, with no engine/DTO/contract/schema change. No
   * public connector or coach-selectable flow creates `conformance_alpha` sessions
   * today, so it is not reached in normal operation; its registration exercises the
   * same production-neutral dispatch path for deterministic conformance/E2E and is
   * not itself an authorization boundary (tenant/RLS scoping and the existing
   * default-off scout flags remain the boundaries). It differs STRUCTURALLY from
   * TrueCoach so tests cannot pass by coincidence — person name is nested at
   * `profile.name` and non-person fields
   * live under `attributes.*` with a `member_id` soft link (TrueCoach uses flat
   * `name`/`client_id`); the opaque `source_id` still carries the record id. Both
   * mappers are pure and total: a malformed or foreign row yields an explicit skip
   * reason (byte-identical to TrueCoach) rather than a throw.
   */
  const SOURCE_PLATFORM = 'conformance_alpha';

  /** Map a `members` record to the canonical roster client (person family). */
  function mapConformanceAlphaClient(row: StagedClientRow): MapClientResult {
    if (row.source_platform !== SOURCE_PLATFORM) {
      return { ok: false, reason: `unsupported_platform:${row.source_platform}` };
    }
    const sourcePersonId = row.source_id.trim();
    if (sourcePersonId.length === 0) {
      return { ok: false, reason: 'missing_source_id' };
    }
    return {
      ok: true,
      client: {
        sourcePersonId,
        sourcePlatform: row.source_platform,
        displayName: nestedString(row.payload, 'profile', 'name'),
      },
    };
  }

  /** Map a `routines` / `activity-log` record to the canonical generic entity. */
  function mapConformanceAlphaEntity(row: StagedEntityRow): MapEntityResult {
    if (row.source_platform !== SOURCE_PLATFORM) {
      return { ok: false, reason: `unsupported_platform:${row.source_platform}` };
    }
    if (row.source_id.trim().length === 0) {
      return { ok: false, reason: 'missing_source_id' };
    }
    return {
      ok: true,
      entity: {
        sourcePlatform: row.source_platform,
        clientSourceId: nestedString(row.payload, 'attributes', 'member_id'),
        label: nestedString(row.payload, 'attributes', 'title'),
      },
    };
  }

  /** Narrow an opaque JSON value to an indexable object, else null. */
  function asObject(value: Prisma.JsonValue | undefined): Record<string, Prisma.JsonValue> | null {
    if (
      value === null ||
      value === undefined ||
      typeof value !== 'object' ||
      Array.isArray(value)
    ) {
      return null;
    }
    return value as Record<string, Prisma.JsonValue>;
  }

  /**
   * Read a non-empty scalar from `payload[outer][inner]`, coercing a finite number
   * to its string form. Any missing level, wrong type, or empty string → null, so
   * an omitted optional field degrades to a soft null instead of throwing.
   */
  function nestedString(payload: Prisma.JsonValue, outer: string, inner: string): string | null {
    const nested = asObject(asObject(payload)?.[outer]);
    if (nested === null) return null;
    const raw = nested[inner];
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      return trimmed.length === 0 ? null : trimmed;
    }
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
    return null;
  }

  return { mapConformanceAlphaClient, mapConformanceAlphaEntity };
})();

interface LegacySource {
  mapClient(row: StagedClientRow): MapClientResult;
  mapEntity(row: StagedEntityRow): MapEntityResult;
}

const LEGACY_SOURCES: ReadonlyMap<string, LegacySource> = new Map<string, LegacySource>([
  [
    'truecoach',
    {
      mapClient: legacyTrueCoachClients.mapTrueCoachClient,
      mapEntity: legacyTrueCoachEntity.mapTrueCoachEntity,
    },
  ],
  [
    'conformance_alpha',
    {
      mapClient: legacyConformanceAlpha.mapConformanceAlphaClient,
      mapEntity: legacyConformanceAlpha.mapConformanceAlphaEntity,
    },
  ],
]);

/** The 61b93cff family-layer `map()` (families.ts), reproduced as the oracle. */
function legacyFamilyMap(family: string, row: StagedSourceRow): unknown {
  const mapper = LEGACY_SOURCES.get(row.source_platform);
  if (mapper === undefined) {
    return { ok: false, reason: `unsupported_platform:${row.source_platform}` };
  }
  if (family === RECONSTRUCT_FAMILY.clients) {
    const result = mapper.mapClient(row);
    return result.ok ? { ok: true, mapped: result.client } : result;
  }
  const result = mapper.mapEntity(row);
  return result.ok ? { ok: true, mapped: result.entity } : result;
}

// ---------------------------------------------------------------------------
// Corpus: every recorded fixture payload plus adversarial and seeded-random
// payloads, crossed with padded/blank/foreign identities and platforms.
// ---------------------------------------------------------------------------

function fixturePayloads(): Prisma.JsonValue[] {
  const truecoach = (file: string, key: string): Prisma.JsonValue[] => {
    const raw = JSON.parse(
      readFileSync(join(__dirname, `../../fixtures/truecoach/${file}`), 'utf8'),
    ) as { responseBody: { body: string } };
    return (JSON.parse(raw.responseBody.body) as Record<string, Prisma.JsonValue[]>)[key];
  };
  const conformance = JSON.parse(
    readFileSync(join(__dirname, '../../fixtures/conformance/conformance-alpha.json.raw'), 'utf8'),
  ) as { expect_records: Record<string, { payload: Prisma.JsonValue }[]> };
  return [
    ...truecoach('clients.golden.json', 'clients'),
    ...truecoach('workouts.golden.json', 'workouts'),
    ...truecoach('client-history.golden.json', 'records'),
    ...Object.values(conformance.expect_records).flatMap((records) =>
      records.map((record) => record.payload),
    ),
  ];
}

const SCALARS: unknown[] = [
  undefined,
  null,
  0,
  -0,
  7,
  7.5,
  -3,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  true,
  false,
  '',
  '   ',
  '\t\n',
  'Dana',
  '  Sam Lift ',
  '\u00a0Nbsp\u00a0',
  '42',
  [],
  ['x'],
  {},
  { name: 'nested' },
];

const FIELD_KEYS = ['name', 'title', 'client_id', 'clientId', 'id', 'email', 'price'];
const NEST_KEYS = ['profile', 'attributes'];
const NESTED_FIELD_KEYS = ['name', 'title', 'member_id', 'email'];

function adversarialPayloads(): unknown[] {
  const payloads: unknown[] = [...SCALARS];
  for (const key of FIELD_KEYS) for (const value of SCALARS) payloads.push({ [key]: value });
  for (const nest of NEST_KEYS) {
    for (const value of SCALARS) payloads.push({ [nest]: value });
    for (const key of NESTED_FIELD_KEYS) {
      for (const value of SCALARS) payloads.push({ [nest]: { [key]: value } });
    }
  }
  // `??` ordering: a present-but-unusable first path must NOT fall through.
  for (const first of SCALARS) {
    payloads.push({ client_id: first, clientId: '8' });
    payloads.push({ title: first, name: 'Fallback' });
  }
  payloads.push(JSON.parse('{"__proto__":{"name":"proto"},"constructor":1,"toString":"x"}'));
  payloads.push({ profile: { name: 'P' }, name: 'Flat', attributes: { title: 'T', member_id: 3 } });
  return payloads;
}

/** Deterministic xorshift32 so the random corpus is identical on every run. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

function randomPayloads(count: number): unknown[] {
  const next = seededRandom(0x5eed8a);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
  const keys = [...FIELD_KEYS, ...NEST_KEYS, ...NESTED_FIELD_KEYS];
  const value = (depth: number): unknown => {
    if (depth > 0 && next() < 0.35) {
      const obj: Record<string, unknown> = {};
      const n = Math.floor(next() * 4);
      for (let i = 0; i < n; i += 1) obj[pick(keys)] = value(depth - 1);
      return obj;
    }
    return pick(SCALARS);
  };
  return Array.from({ length: count }, () => {
    const obj: Record<string, unknown> = {};
    const n = Math.floor(next() * 5);
    for (let i = 0; i < n; i += 1) obj[pick(keys)] = value(2);
    return next() < 0.1 ? value(2) : obj;
  });
}

const SOURCE_IDS = ['7', '  42  ', 'opaque-99', 'm-1', '', '   ', '\t', '\u00a0'];
const PLATFORMS = ['truecoach', 'conformance_alpha', 'trainerize', 'TrueCoach', ''];
const ENTITY_FAMILIES = [RECONSTRUCT_FAMILY.workouts, RECONSTRUCT_FAMILY.client_history];
const ALL_FAMILIES = [RECONSTRUCT_FAMILY.clients, ...ENTITY_FAMILIES];

function corpus(): StagedSourceRow[] {
  const payloads = [...fixturePayloads(), ...adversarialPayloads(), ...randomPayloads(1500)];
  const rows: StagedSourceRow[] = [];
  for (const payload of payloads) {
    for (const source_id of SOURCE_IDS) {
      for (const source_platform of PLATFORMS) {
        rows.push({ source_id, source_platform, payload: payload as Prisma.JsonValue });
      }
    }
  }
  return rows;
}

/**
 * Compare two outputs over every corpus row with Node's strict deep equality
 * (own keys, `undefined` vs absent, prototypes), collecting the first few
 * mismatches so a failure names the offending rows. One `expect` per test keeps
 * the ~80k-row sweep fast.
 */
function mismatches(
  rows: readonly StagedSourceRow[],
  actual: (row: StagedSourceRow) => unknown,
  expected: (row: StagedSourceRow) => unknown,
): unknown[] {
  const found: unknown[] = [];
  for (const row of rows) {
    const a = actual(row);
    const e = expected(row);
    if (!isDeepStrictEqual(a, e) && found.length < 5) found.push({ row, actual: a, expected: e });
  }
  return found;
}

describe('S8-A interpreter ≡ retired per-source mappers (deep-equal, incl. skip reasons)', () => {
  const rows = corpus();
  const sources = buildSourceMapperRegistry();
  const families = buildFamilyRegistry();

  it('covers a large corpus including every recorded fixture payload', () => {
    expect(fixturePayloads().length).toBeGreaterThanOrEqual(20);
    expect(rows.length).toBeGreaterThan(70000);
  });

  it('registers every legacy source (and interprets each one from data)', () => {
    for (const platform of LEGACY_SOURCES.keys()) expect(sources.get(platform)).toBeDefined();
  });

  it('the strict comparator distinguishes an absent key from an undefined one', () => {
    expect(isDeepStrictEqual({ ok: false, reason: 'x' }, { ok: false, reason: 'x' })).toBe(true);
    expect(isDeepStrictEqual({ a: undefined }, {})).toBe(false);
    expect(isDeepStrictEqual({ a: null }, { a: undefined })).toBe(false);
  });

  for (const platform of ['truecoach', 'conformance_alpha']) {
    it(`${platform}: mapClient deep-equals the retired client mapper on every row`, () => {
      const legacy = LEGACY_SOURCES.get(platform) as LegacySource;
      const mapper = sources.get(platform) as SourceMapper;
      expect(
        mismatches(
          rows,
          (row) => mapper.mapClient(row),
          (row) => legacy.mapClient(row),
        ),
      ).toEqual([]);
    });

    for (const family of ENTITY_FAMILIES) {
      it(`${platform}: mapEntity(${family}) deep-equals the retired entity mapper on every row`, () => {
        const legacy = LEGACY_SOURCES.get(platform) as LegacySource;
        const mapper = sources.get(platform) as SourceMapper;
        expect(
          mismatches(
            rows,
            (row) => mapper.mapEntity(family, row),
            (row) => legacy.mapEntity(row),
          ),
        ).toEqual([]);
      });
    }
  }

  for (const family of ALL_FAMILIES) {
    it(`family layer map() for ${family} deep-equals the 61b93cff dispatch on every row`, () => {
      const reconstructor = families.get(family);
      expect(reconstructor).toBeDefined();
      expect(
        mismatches(
          rows,
          (row) => reconstructor!.map(row),
          (row) => legacyFamilyMap(family, row),
        ),
      ).toEqual([]);
      // The corpus exercises every legacy skip reason class.
      const reasons = new Set<string>();
      for (const row of rows) {
        const result = reconstructor!.map(row);
        if (!result.ok) reasons.add(result.reason);
      }
      expect([...reasons].sort()).toEqual(
        [
          'missing_source_id',
          'unsupported_platform:',
          'unsupported_platform:TrueCoach',
          'unsupported_platform:trainerize',
        ].sort(),
      );
    });
  }
});
