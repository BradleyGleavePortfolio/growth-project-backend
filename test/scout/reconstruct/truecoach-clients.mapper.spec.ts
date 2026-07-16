import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import {
  mapTrueCoachClient,
  type StagedClientRow,
} from '../../../src/scout/mappers/truecoach-clients.mapper';

/**
 * Unit tests for the pure, total TrueCoach `clients` mapper.
 *
 * The mapper is the D2 guardrail in code: identity is the opaque platform id
 * (source_id), the display name is best-effort, and email is deliberately never
 * read. These tests drive it against the SAME real recorded payload shapes the
 * extension captures (test/fixtures/truecoach/clients.golden.json) so the roster
 * mapping is proven against bytes Chrome actually emitted, not synthetic stubs.
 */

function goldenClients(): readonly Prisma.JsonObject[] {
  const fixture = JSON.parse(
    readFileSync(join(__dirname, '../../fixtures/truecoach/clients.golden.json'), 'utf8'),
  ) as { responseBody: { body: string } };
  const parsed = JSON.parse(fixture.responseBody.body) as { clients: Prisma.JsonObject[] };
  return parsed.clients;
}

function row(overrides: Partial<StagedClientRow> = {}): StagedClientRow {
  return {
    source_id: '7',
    source_platform: 'truecoach',
    payload: { name: 'Dana Coach', email: 'dana@example.com' } as Prisma.JsonValue,
    ...overrides,
  };
}

describe('mapTrueCoachClient', () => {
  it('maps every real golden client to an invite-pending roster shape', () => {
    for (const client of goldenClients()) {
      const result = mapTrueCoachClient(row({ source_id: String(client.id), payload: client }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.client.sourcePersonId).toBe(String(client.id));
        expect(result.client.sourcePlatform).toBe('truecoach');
        expect(result.client.displayName).toBe(String(client.name));
      }
    }
  });

  it('never reads email — the mapped shape carries no email field or value', () => {
    const client = goldenClients()[0];
    const result = mapTrueCoachClient(row({ source_id: String(client.id), payload: client }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.stringify(result.client)).not.toContain('@example.com');
      expect(JSON.stringify(result.client)).not.toContain('email');
    }
  });

  it('uses source_id as the identity key, never any payload id/email', () => {
    const result = mapTrueCoachClient(
      row({
        source_id: 'opaque-99',
        payload: { id: 7, name: 'X', email: 'decoy@x.io' } as Prisma.JsonValue,
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.client.sourcePersonId).toBe('opaque-99');
  });

  it('trims surrounding whitespace on the identity key', () => {
    const result = mapTrueCoachClient(row({ source_id: '  42  ' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.client.sourcePersonId).toBe('42');
  });

  it('skips a non-truecoach platform with a reason', () => {
    const result = mapTrueCoachClient(row({ source_platform: 'trainerize' }));
    expect(result).toEqual({ ok: false, reason: 'unsupported_platform:trainerize' });
  });

  it('skips an empty / whitespace-only source_id with a reason', () => {
    expect(mapTrueCoachClient(row({ source_id: '   ' }))).toEqual({
      ok: false,
      reason: 'missing_source_id',
    });
  });

  it('yields a null display name when payload has no usable name', () => {
    for (const payload of [
      null,
      42,
      'scalar',
      [] as unknown,
      { name: '' },
      { name: '   ' },
      { name: 123 },
      {},
    ]) {
      const result = mapTrueCoachClient(row({ payload: payload as Prisma.JsonValue }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.client.displayName).toBeNull();
    }
  });

  it('trims a usable display name', () => {
    const result = mapTrueCoachClient(
      row({ payload: { name: '  Sam Lift ' } as Prisma.JsonValue }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.client.displayName).toBe('Sam Lift');
  });

  it('is total — it never throws on adversarial payloads', () => {
    for (const payload of [null, undefined, 0, false, '', [], { name: {} }]) {
      expect(() => mapTrueCoachClient(row({ payload: payload as Prisma.JsonValue }))).not.toThrow();
    }
  });
});
