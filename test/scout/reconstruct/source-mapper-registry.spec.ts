import { Prisma } from '@prisma/client';
import {
  buildSourceMapperRegistry,
  type SourceMapper,
} from '../../../src/scout/reconstruct/source-mapper-registry';
import { buildFamilyRegistry, type StagedRow } from '../../../src/scout/reconstruct/families';
import { RECONSTRUCT_FAMILY } from '../../../src/scout/scout-reconstruct.dto';

/**
 * PR-1 — the thin `source_platform` → mapper seam. These tests prove two things
 * WITHOUT touching the engine, DTOs, contract, or schema:
 *   1. the registry selects the correct source mapper by `source_platform`, and
 *   2. the family layer fails an unregistered platform closed with the exact
 *      `unsupported_platform:<token>` skip reason (byte-identical to the guard
 *      each mapper still carries internally).
 * Behavior is asserted on concrete mapped fields / reason strings — not on the
 * registry's own return value re-fed to itself — so the checks are not
 * tautological.
 */

function row(source_platform: string, source_id: string, payload: Prisma.JsonValue): StagedRow {
  return { source_id, source_platform, payload };
}

describe('buildSourceMapperRegistry — source_platform dispatch', () => {
  const registry = buildSourceMapperRegistry();

  it('registers truecoach plus the non-production conformance_alpha adapter', () => {
    expect([...registry.keys()]).toEqual(['truecoach', 'conformance_alpha']);
  });

  it('returns undefined for any unregistered platform (fail-closed at the seam)', () => {
    expect(registry.get('trainerize')).toBeUndefined();
    expect(registry.get('some_unregistered_source')).toBeUndefined();
    expect(registry.get('')).toBeUndefined();
  });

  it('routes clients through the TrueCoach client mapper (concrete fields)', () => {
    const mapper = registry.get('truecoach') as SourceMapper;
    const result = mapper.mapClient(row('truecoach', 'tc_9', { name: '  Dana Ray  ' }));
    expect(result).toEqual({
      ok: true,
      client: { sourcePersonId: 'tc_9', sourcePlatform: 'truecoach', displayName: 'Dana Ray' },
    });
  });

  it('routes non-person families through the TrueCoach entity mapper (concrete fields)', () => {
    const mapper = registry.get('truecoach') as SourceMapper;
    const result = mapper.mapEntity(
      row('truecoach', 'w_1', { title: 'Upper Body A', client_id: 7, price: 49.99 }),
    );
    expect(result).toEqual({
      ok: true,
      entity: { sourcePlatform: 'truecoach', clientSourceId: '7', label: 'Upper Body A' },
    });
  });

  it('preserves the mapper skip reasons verbatim through the seam', () => {
    const mapper = registry.get('truecoach') as SourceMapper;
    expect(mapper.mapClient(row('truecoach', '   ', {}))).toEqual({
      ok: false,
      reason: 'missing_source_id',
    });
  });
});

describe('family map() — registry-backed dispatch preserves behavior', () => {
  const families = buildFamilyRegistry();

  it('maps a truecoach clients row to a canonical value (no regression)', () => {
    const clients = families.get(RECONSTRUCT_FAMILY.clients)!;
    const result = clients.map(row('truecoach', 'tc_9', { name: 'Dana Ray' }));
    expect(result).toEqual({
      ok: true,
      mapped: { sourcePersonId: 'tc_9', sourcePlatform: 'truecoach', displayName: 'Dana Ray' },
    });
  });

  it('maps a truecoach workouts row to a canonical value (no regression)', () => {
    const workouts = families.get(RECONSTRUCT_FAMILY.workouts)!;
    const result = workouts.map(row('truecoach', 'w_1', { title: 'Leg Day', client_id: '7' }));
    expect(result).toEqual({
      ok: true,
      mapped: { sourcePlatform: 'truecoach', clientSourceId: '7', label: 'Leg Day' },
    });
  });

  for (const entityType of [
    RECONSTRUCT_FAMILY.clients,
    RECONSTRUCT_FAMILY.workouts,
    RECONSTRUCT_FAMILY.client_history,
  ]) {
    it(`fails an unregistered platform closed with unsupported_platform token (${entityType})`, () => {
      const family = families.get(entityType)!;
      expect(family.map(row('trainerize', 'x_1', {}))).toEqual({
        ok: false,
        reason: 'unsupported_platform:trainerize',
      });
      // The token carries the exact offending platform, not a fixed string.
      expect(family.map(row('some_other_src', 'x_2', {}))).toEqual({
        ok: false,
        reason: 'unsupported_platform:some_other_src',
      });
    });
  }

  it('propagates a mapper skip reason that is NOT the platform guard', () => {
    // A registered platform whose row still fails to map (empty source_id) must
    // surface the mapper's own reason through the seam — proving the family does
    // not short-circuit every miss as unsupported_platform.
    const clients = families.get(RECONSTRUCT_FAMILY.clients)!;
    expect(clients.map(row('truecoach', '   ', { name: 'Ghost' }))).toEqual({
      ok: false,
      reason: 'missing_source_id',
    });
  });

  it('carries an absent client link through as a null soft-link (non-person family)', () => {
    // No client_id in the payload → clientSourceId null, label from name
    // fallback. The seam must not invent a link or drop the row.
    const history = families.get(RECONSTRUCT_FAMILY.client_history)!;
    expect(history.map(row('truecoach', 'h_1', { name: 'Intake Note' }))).toEqual({
      ok: true,
      mapped: { sourcePlatform: 'truecoach', clientSourceId: null, label: 'Intake Note' },
    });
  });

  it('coerces a numeric client_id to string through the seam', () => {
    const workouts = families.get(RECONSTRUCT_FAMILY.workouts)!;
    expect(workouts.map(row('truecoach', 'w_2', { title: 'Push Day', client_id: 42 }))).toEqual({
      ok: true,
      mapped: { sourcePlatform: 'truecoach', clientSourceId: '42', label: 'Push Day' },
    });
  });

  it('degrades a non-object payload to null fields without throwing (poison-shaped)', () => {
    // An array payload is structurally wrong but must be a total-function skip of
    // the optional fields, never a throw — the engine relies on totality.
    const workouts = families.get(RECONSTRUCT_FAMILY.workouts)!;
    const arrayPayload: Prisma.JsonValue = [];
    expect(workouts.map(row('truecoach', 'w_3', arrayPayload))).toEqual({
      ok: true,
      mapped: { sourcePlatform: 'truecoach', clientSourceId: null, label: null },
    });
  });
});

describe('buildSourceMapperRegistry — instance independence', () => {
  it('returns a fresh map per call with no shared mutable singleton', () => {
    const a = buildSourceMapperRegistry();
    const b = buildSourceMapperRegistry();
    expect(a).not.toBe(b);
    expect([...a.keys()]).toEqual([...b.keys()]);
  });

  it('keys the registry by each source mapper own sourcePlatform', () => {
    const registry = buildSourceMapperRegistry();
    for (const [key, mapper] of registry.entries()) {
      expect(mapper.sourcePlatform).toBe(key);
    }
  });
});
