import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import {
  mapTrueCoachEntity,
  type StagedEntityRow,
} from '../../../src/scout/mappers/truecoach-entity.mapper';

/**
 * Unit tests for the pure, total TrueCoach generic-entity mapper (IMPORTER-H).
 *
 * This mapper is the D2 guardrail for the NON-person families (`workouts`,
 * `client_history`): the client link is the opaque client_id/clientId and the
 * label is a best-effort title/name. Identity is the opaque source_id, which the
 * engine carries directly as the external_ref key — the mapper never re-derives
 * it. Email and every billing/price field are deliberately never read.
 * The tests drive it against the SAME real recorded payload shapes the extension
 * captures (test/fixtures/truecoach/{workouts,client-history}.golden.json), so
 * the mapping is proven against bytes Chrome actually emitted — the golden
 * fixtures embed both a client email and billing noise precisely so an
 * accidental read would fail these assertions.
 */

function goldenRows(fixture: string, key: string): readonly Prisma.JsonObject[] {
  const raw = JSON.parse(
    readFileSync(join(__dirname, `../../fixtures/truecoach/${fixture}`), 'utf8'),
  ) as { responseBody: { body: string } };
  const parsed = JSON.parse(raw.responseBody.body) as Record<string, Prisma.JsonObject[]>;
  return parsed[key];
}

const goldenWorkouts = (): readonly Prisma.JsonObject[] =>
  goldenRows('workouts.golden.json', 'workouts');
const goldenHistory = (): readonly Prisma.JsonObject[] =>
  goldenRows('client-history.golden.json', 'records');

function row(overrides: Partial<StagedEntityRow> = {}): StagedEntityRow {
  return {
    source_id: '501',
    source_platform: 'truecoach',
    payload: { title: 'Upper Body A', client_id: 7 } as Prisma.JsonValue,
    ...overrides,
  };
}

describe('mapTrueCoachEntity', () => {
  it('maps every real golden workout to a canonical entity shape', () => {
    for (const workout of goldenWorkouts()) {
      const result = mapTrueCoachEntity(row({ source_id: String(workout.id), payload: workout }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.entity.sourcePlatform).toBe('truecoach');
      }
    }
  });

  it('maps every real golden client-history record to a canonical entity shape', () => {
    for (const record of goldenHistory()) {
      const result = mapTrueCoachEntity(row({ source_id: String(record.id), payload: record }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.entity.sourcePlatform).toBe('truecoach');
      }
    }
  });

  it('never reads email — no golden mapping carries an email field or value', () => {
    for (const record of goldenHistory()) {
      const result = mapTrueCoachEntity(row({ source_id: String(record.id), payload: record }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        const serialized = JSON.stringify(result.entity);
        expect(serialized).not.toContain('@example.com');
        expect(serialized).not.toContain('email');
      }
    }
  });

  it('never reads any billing/price field from the golden payloads', () => {
    const rows = [...goldenWorkouts(), ...goldenHistory()];
    for (const raw of rows) {
      const result = mapTrueCoachEntity(row({ source_id: String(raw.id), payload: raw }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        const serialized = JSON.stringify(result.entity).toLowerCase();
        for (const banned of ['price', 'invoice', 'amount_due', 'amount', 'balance', 'inv_']) {
          expect(serialized).not.toContain(banned);
        }
      }
    }
  });

  it('never surfaces a payload id or email — identity stays the opaque source_id', () => {
    const result = mapTrueCoachEntity(
      row({
        source_id: 'opaque-77',
        payload: { id: 501, title: 'X', email: 'decoy@x.io' } as Prisma.JsonValue,
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result.entity);
      expect(serialized).not.toContain('501');
      expect(serialized).not.toContain('decoy@x.io');
      expect(serialized).not.toContain('email');
    }
  });

  it('accepts a whitespace-padded but non-empty source_id (not skipped)', () => {
    const result = mapTrueCoachEntity(row({ source_id: '  902  ' }));
    expect(result.ok).toBe(true);
  });

  it('reads the client link from client_id (numeric coerced to string)', () => {
    const result = mapTrueCoachEntity(row({ payload: { client_id: 7 } as Prisma.JsonValue }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entity.clientSourceId).toBe('7');
  });

  it('reads the client link from the camelCase clientId variant', () => {
    const result = mapTrueCoachEntity(row({ payload: { clientId: '8' } as Prisma.JsonValue }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entity.clientSourceId).toBe('8');
  });

  it('yields a null client link when no client id is present', () => {
    const result = mapTrueCoachEntity(row({ payload: { title: 'orphan' } as Prisma.JsonValue }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entity.clientSourceId).toBeNull();
  });

  it('reads a display label from title, then name', () => {
    const byTitle = mapTrueCoachEntity(row({ payload: { title: 'Leg Day' } as Prisma.JsonValue }));
    expect(byTitle.ok).toBe(true);
    if (byTitle.ok) expect(byTitle.entity.label).toBe('Leg Day');

    const byName = mapTrueCoachEntity(row({ payload: { name: 'Check-in' } as Prisma.JsonValue }));
    expect(byName.ok).toBe(true);
    if (byName.ok) expect(byName.entity.label).toBe('Check-in');
  });

  it('trims a usable label and nulls an empty/whitespace/non-string one', () => {
    const trimmed = mapTrueCoachEntity(
      row({ payload: { title: '  Leg Day ' } as Prisma.JsonValue }),
    );
    expect(trimmed.ok).toBe(true);
    if (trimmed.ok) expect(trimmed.entity.label).toBe('Leg Day');

    for (const payload of [{ title: '' }, { title: '   ' }, { title: 123 }, { name: {} }, {}]) {
      const result = mapTrueCoachEntity(row({ payload: payload as Prisma.JsonValue }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.entity.label).toBeNull();
    }
  });

  it('yields a null label for the golden workout that has no title (item 503)', () => {
    const record = goldenWorkouts().find((w) => w.id === 503) as Prisma.JsonObject;
    const result = mapTrueCoachEntity(row({ source_id: String(record.id), payload: record }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entity.label).toBeNull();
  });

  it('skips a non-truecoach platform with a reason', () => {
    const result = mapTrueCoachEntity(row({ source_platform: 'trainerize' }));
    expect(result).toEqual({ ok: false, reason: 'unsupported_platform:trainerize' });
  });

  it('skips an empty / whitespace-only source_id with a reason', () => {
    expect(mapTrueCoachEntity(row({ source_id: '   ' }))).toEqual({
      ok: false,
      reason: 'missing_source_id',
    });
  });

  it('is total — it never throws on adversarial payloads', () => {
    for (const payload of [null, undefined, 0, false, '', [], { client_id: {} }, { title: [] }]) {
      expect(() => mapTrueCoachEntity(row({ payload: payload as Prisma.JsonValue }))).not.toThrow();
    }
  });
});
