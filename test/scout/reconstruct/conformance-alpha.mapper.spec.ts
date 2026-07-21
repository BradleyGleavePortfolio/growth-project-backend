import { Prisma } from '@prisma/client';
import {
  mapConformanceAlphaClient,
  mapConformanceAlphaEntity,
} from '../../../src/scout/mappers/conformance-alpha.mapper';
import { mapTrueCoachClient } from '../../../src/scout/mappers/truecoach-clients.mapper';
import {
  buildSourceMapperRegistry,
  type SourceMapper,
} from '../../../src/scout/reconstruct/source-mapper-registry';
import { buildFamilyRegistry, type StagedRow } from '../../../src/scout/reconstruct/families';
import { RECONSTRUCT_FAMILY } from '../../../src/scout/scout-reconstruct.dto';

/**
 * PR-2a — the deterministic, non-production `conformance_alpha` adapter proving
 * the frozen `SourceMapper` seam is source-neutral. Tests assert on concrete
 * mapped canonical fields and exact skip reasons (never the registry re-fed to
 * itself, so nothing is tautological) and exercise the SAME dispatch path the
 * engine uses (via the family layer) with ZERO core change beyond one registry
 * line. Fixtures differ in SHAPE from TrueCoach: prefixed ids, nested
 * `profile`/`attributes`, cursor-paginated `/v2` pages, omitted optional fields,
 * and deterministic poison rows.
 */

/** A single cursor page of the conformance source's `/v2/...` list endpoints. */
interface Page {
  readonly result: { readonly records: ReadonlyArray<Record<string, Prisma.JsonValue>> };
  readonly next_cursor: string | null;
}

/** `/v2/coaches/{coach_id}/members?after=` — a person family over two cursor pages. */
const MEMBER_PAGES: Record<string, Page> = {
  '': {
    result: {
      records: [
        { id: 'm-1', profile: { name: '  Dana Ray  ', email: 'drop@me.example' } },
        { id: 'm-2' },
      ],
    },
    next_cursor: 'c-members-2',
  },
  'c-members-2': {
    result: {
      records: [
        { id: 'm-3', profile: { name: 'Lee Ito' } },
        { id: '   ', profile: { name: 'Poison Member' } },
      ],
    },
    next_cursor: null,
  },
};

/** `/v2/coaches/{coach_id}/routines?after=` — `rt_2` omits member_id, `rt_3` omits attributes. */
const ROUTINE_PAGES: Record<string, Page> = {
  '': {
    result: {
      records: [
        { id: 'rt_1', attributes: { title: 'Upper Body A', member_id: 'm-1', price: 49.99 } },
        { id: 'rt_2', attributes: { title: 'Rest Day' } },
        { id: 'rt_3' },
      ],
    },
    next_cursor: null,
  },
};

/** `/v2/coaches/{coach_id}/activity-log?after=` — `al_2` carries a numeric member_id (coerced). */
const ACTIVITY_PAGES: Record<string, Page> = {
  '': {
    result: {
      records: [
        { id: 'al_1', attributes: { title: 'Logged in', member_id: 'm-1' } },
        { id: 'al_2', attributes: { title: 'Completed rt_1', member_id: 7 } },
      ],
    },
    next_cursor: null,
  },
};

/**
 * Walk every cursor page in order and project each record into the seam's staged
 * row shape (itemsPath `result.records`, id `record.id`) — the paginated topology
 * a future ingest adapter would drive, flattened deterministically here.
 */
function stagedRows(pages: Record<string, Page>): StagedRow[] {
  const rows: StagedRow[] = [];
  let cursor: string | null = '';
  while (cursor !== null) {
    const page: Page | undefined = pages[cursor];
    if (page === undefined) break;
    for (const record of page.result.records) {
      const { id, ...payload } = record;
      rows.push({
        source_id: typeof id === 'string' ? id : '',
        source_platform: 'conformance_alpha',
        payload,
      });
    }
    cursor = page.next_cursor;
  }
  return rows;
}

describe('conformance_alpha — registry registration', () => {
  const registry = buildSourceMapperRegistry();

  it('is reachable through the frozen seam by its source_platform', () => {
    const mapper = registry.get('conformance_alpha');
    expect(mapper).toBeDefined();
    expect((mapper as SourceMapper).sourcePlatform).toBe('conformance_alpha');
  });
});

describe('conformance_alpha — members → canonical client (nested profile)', () => {
  const rows = stagedRows(MEMBER_PAGES);

  it('walks both cursor pages in deterministic order', () => {
    expect(rows.map((r) => r.source_id)).toEqual(['m-1', 'm-2', 'm-3', '   ']);
  });

  it('maps a member id + nested profile.name to the canonical client', () => {
    expect(mapConformanceAlphaClient(rows[0])).toEqual({
      ok: true,
      client: {
        sourcePersonId: 'm-1',
        sourcePlatform: 'conformance_alpha',
        displayName: 'Dana Ray',
      },
    });
  });

  it('degrades an omitted profile to a null display name (optional field)', () => {
    expect(mapConformanceAlphaClient(rows[1])).toEqual({
      ok: true,
      client: { sourcePersonId: 'm-2', sourcePlatform: 'conformance_alpha', displayName: null },
    });
  });

  it('fails the poison blank-id row closed with missing_source_id', () => {
    expect(mapConformanceAlphaClient(rows[3])).toEqual({ ok: false, reason: 'missing_source_id' });
  });

  it('never reads email — it is absent from every mapped client', () => {
    for (const row of rows) {
      const result = mapConformanceAlphaClient(row);
      if (result.ok) expect(JSON.stringify(result.client)).not.toContain('example');
    }
  });
});

describe('conformance_alpha — routines/activity-log → canonical entity (nested attributes)', () => {
  it('maps nested attributes.title + attributes.member_id to the canonical entity', () => {
    const [routine] = stagedRows(ROUTINE_PAGES);
    expect(mapConformanceAlphaEntity(routine)).toEqual({
      ok: true,
      entity: { sourcePlatform: 'conformance_alpha', clientSourceId: 'm-1', label: 'Upper Body A' },
    });
  });

  it('carries an omitted member_id through as a null soft-link', () => {
    const rt2 = stagedRows(ROUTINE_PAGES)[1];
    expect(mapConformanceAlphaEntity(rt2)).toEqual({
      ok: true,
      entity: { sourcePlatform: 'conformance_alpha', clientSourceId: null, label: 'Rest Day' },
    });
  });

  it('degrades an omitted attributes object to null fields without throwing', () => {
    const rt3 = stagedRows(ROUTINE_PAGES)[2];
    expect(mapConformanceAlphaEntity(rt3)).toEqual({
      ok: true,
      entity: { sourcePlatform: 'conformance_alpha', clientSourceId: null, label: null },
    });
  });

  it('coerces a numeric member_id to string through the seam', () => {
    const al2 = stagedRows(ACTIVITY_PAGES)[1];
    expect(mapConformanceAlphaEntity(al2)).toEqual({
      ok: true,
      entity: { sourcePlatform: 'conformance_alpha', clientSourceId: '7', label: 'Completed rt_1' },
    });
  });

  it('never maps the price/billing noise onto the canonical entity', () => {
    const [routine] = stagedRows(ROUTINE_PAGES);
    const result = mapConformanceAlphaEntity(routine);
    expect(result.ok && JSON.stringify(result.entity)).not.toContain('49.99');
  });
});

describe('conformance_alpha — fail-closed and totality at the seam', () => {
  it('rejects a foreign platform with the exact unsupported_platform token', () => {
    const foreign: StagedRow = { source_id: 'm-1', source_platform: 'truecoach', payload: {} };
    expect(mapConformanceAlphaClient(foreign)).toEqual({
      ok: false,
      reason: 'unsupported_platform:truecoach',
    });
    expect(mapConformanceAlphaEntity(foreign)).toEqual({
      ok: false,
      reason: 'unsupported_platform:truecoach',
    });
  });

  it('degrades a non-object (array) payload to null fields, never a throw', () => {
    const arrayPayload: Prisma.JsonValue = [];
    const row: StagedRow = {
      source_id: 'm-9',
      source_platform: 'conformance_alpha',
      payload: arrayPayload,
    };
    expect(mapConformanceAlphaClient(row)).toEqual({
      ok: true,
      client: { sourcePersonId: 'm-9', sourcePlatform: 'conformance_alpha', displayName: null },
    });
  });
});

describe('conformance_alpha — structurally distinct from TrueCoach (not coincidental)', () => {
  it('reads the NESTED profile.name, so a TrueCoach-flat name yields null', () => {
    // A flat top-level `name` (TrueCoach's shape) is NOT where this adapter looks.
    const flat: StagedRow = {
      source_id: 'm-1',
      source_platform: 'conformance_alpha',
      payload: { name: 'Flat Name' },
    };
    const result = mapConformanceAlphaClient(flat);
    expect(result).toEqual({
      ok: true,
      client: { sourcePersonId: 'm-1', sourcePlatform: 'conformance_alpha', displayName: null },
    });
  });

  it('the TrueCoach mapper cannot read the conformance nested profile', () => {
    // Symmetric proof: feeding the conformance-shaped row to TrueCoach (after a
    // platform relabel) finds no flat `name`, so its display name is null too —
    // the two adapters genuinely parse different shapes.
    const nested: StagedRow = {
      source_id: 'm-1',
      source_platform: 'truecoach',
      payload: { profile: { name: 'Nested Only' } },
    };
    const result = mapTrueCoachClient(nested);
    expect(result).toEqual({
      ok: true,
      client: { sourcePersonId: 'm-1', sourcePlatform: 'truecoach', displayName: null },
    });
  });
});

describe('conformance_alpha — engine dispatch via the family layer (zero core change)', () => {
  const families = buildFamilyRegistry();

  it('routes a conformance clients row through the SAME family map()', () => {
    const clients = families.get(RECONSTRUCT_FAMILY.clients)!;
    const [member] = stagedRows(MEMBER_PAGES);
    expect(clients.map(member)).toEqual({
      ok: true,
      mapped: {
        sourcePersonId: 'm-1',
        sourcePlatform: 'conformance_alpha',
        displayName: 'Dana Ray',
      },
    });
  });

  it('routes a conformance workouts row through the SAME family map()', () => {
    const workouts = families.get(RECONSTRUCT_FAMILY.workouts)!;
    const [routine] = stagedRows(ROUTINE_PAGES);
    expect(workouts.map(routine)).toEqual({
      ok: true,
      mapped: { sourcePlatform: 'conformance_alpha', clientSourceId: 'm-1', label: 'Upper Body A' },
    });
  });

  it('still fails a genuinely unregistered platform closed at the family seam', () => {
    const clients = families.get(RECONSTRUCT_FAMILY.clients)!;
    expect(clients.map({ source_id: 'x', source_platform: 'trainerize', payload: {} })).toEqual({
      ok: false,
      reason: 'unsupported_platform:trainerize',
    });
  });
});
